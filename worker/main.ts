import { hostname } from 'node:os';
process.env.CP_PROCESS_NAME ??= 'worker';

import { getEnv } from '@/server/env';
import { closeDb } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrate';
import { credentialHealth, expireApprovals, housekeeping } from '@/server/core/maintenance';
import { checkRun, pollWorkspace, scheduleChecks } from '@/server/core/observation/checker';
import { processPendingDeliveries } from '@/server/core/observation/webhooks';
import { Queues } from '@/server/core/platform/queue';
import { reconcileDispatch, reconcileRunAction } from '@/server/core/runs/dispatch';
import { syncWorkspace } from '@/server/core/workspaces/sync';
import { startHealthServer } from './health';
import { LeasedScheduler, repeat, WorkerHost } from './host';

const env = getEnv();
const workerId = `${hostname()}:${process.pid}`;
const processing = env.CP_WORKER_PROCESSING === 'on';
let phase = 'starting';

const health = startHealthServer(Number(process.env.PORT ?? env.WORKER_HEALTH_PORT), () => ({ phase, processing, workerId }));

phase = 'migrating';
const applied = await runMigrations();
console.log(applied.length ? `[worker] migrations applied: ${applied.join(', ')}` : '[worker] database up to date');

const host = new WorkerHost(workerId);
const scheduler = new LeasedScheduler(workerId);
let webhooks: { stop: () => void } | null = null;

if (processing) {
  host
    .register({ queue: Queues.dispatch, concurrency: 8, handle: (key) => reconcileDispatch(key) })
    .register({ queue: Queues.runAction, concurrency: 4, handle: (key) => reconcileRunAction(key) })
    .register({ queue: Queues.sync, concurrency: 2, handle: (key) => syncWorkspace(key) })
    .register({ queue: Queues.check, concurrency: 8, handle: (key) => checkRun(key) })
    .register({ queue: Queues.poll, concurrency: 4, handle: (key) => pollWorkspace(key) });
  host.start();

  webhooks = repeat('webhooks', 500, () => processPendingDeliveries(25));

  scheduler
    .every('checker', 15_000, scheduleChecks)
    .every('approval-expiry', 60_000, expireApprovals)
    .every('credential-health', 10 * 60_000, credentialHealth)
    .every('housekeeping', 6 * 60 * 60_000, housekeeping);
  phase = 'running';
  console.log(`[worker] ${workerId} processing`);
} else {
  phase = 'standby';
  console.log('[worker] CP_WORKER_PROCESSING=off — migrations only (staging slot)');
}

async function shutdown(signal: string) {
  console.log(`[worker] ${signal}: draining`);
  phase = 'stopping';
  webhooks?.stop();
  await scheduler.stop();
  await host.stop();
  await closeDb();
  health.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
