import { hostname } from 'node:os';
import { createPostgresBackend, Worker, type Job, type PostgresQueueBackend } from 'bullmq';
import { getEnv } from '@/server/env';
import { closeDb, getQueuePool } from '@/server/db/client';
import { setupDatabaseOnStart } from '@/server/db/setup';
import { credentialHealth, expireApprovals, housekeeping } from '@/server/core/maintenance';
import { checkRun, pollWorkspace, scheduleChecks } from '@/server/core/observation/checker';
import { processDelivery } from '@/server/core/observation/webhooks';
import { reconcileDispatch, reconcileRunAction, type StepResult } from '@/server/core/runs/dispatch';
import { syncWorkspace } from '@/server/core/workspaces/sync';
import { closeQueues, followUp, getQueue, Queues, type KeyJob, type QueueName } from '@/server/jobs/queues';
import { startHealthServer } from './health';

process.env.CP_PROCESS_NAME ??= 'worker';
const env = getEnv();
const workerId = `${hostname()}:${process.pid}`;
const processing = env.CP_WORKER_PROCESSING === 'on';
let phase = 'starting';

// App Service expects the container to answer on PORT from the start.
const health = startHealthServer(Number(process.env.PORT ?? env.WORKER_HEALTH_PORT), () => ({ phase, processing, workerId }));

// 1. Database: no manual migrations. Production applies drizzle-generated migrations; development
//    relies on `pnpm db:push`. Guards and BullMQ's schema are applied every time (idempotent).
const setupMode = env.DB_SETUP_ON_START ?? (env.NODE_ENV === 'production' ? 'migrate' : 'guards-only');
if (setupMode !== 'off') {
  phase = 'database-setup';
  await setupDatabaseOnStart(setupMode);
}

// 2. Job handlers: each gets only a key and re-reads current state (idempotent, level-triggered).
type Handler = (key: string) => Promise<StepResult | void>;
const handlers: Partial<Record<QueueName, { handle: Handler; concurrency: number }>> = {
  [Queues.dispatch]: { handle: reconcileDispatch, concurrency: 8 },
  [Queues.runAction]: { handle: reconcileRunAction, concurrency: 4 },
  [Queues.sync]: { handle: syncWorkspace, concurrency: 2 },
  [Queues.check]: { handle: checkRun, concurrency: 8 },
  [Queues.poll]: { handle: pollWorkspace, concurrency: 4 },
  [Queues.webhook]: { handle: processDelivery, concurrency: 8 },
};

// 3. Periodic jobs as BullMQ job schedulers: exactly one execution per tick across all workers.
const schedules: { name: string; every: number; run: () => Promise<unknown> }[] = [
  { name: 'checker', every: 15_000, run: scheduleChecks },
  { name: 'approval-expiry', every: 60_000, run: expireApprovals },
  { name: 'credential-health', every: 10 * 60_000, run: credentialHealth },
  { name: 'housekeeping', every: 6 * 60 * 60_000, run: housekeeping },
];

const workers: Worker<KeyJob, void, string, PostgresQueueBackend>[] = [];

if (processing) {
  const connection = getQueuePool();

  for (const [queue, h] of Object.entries(handlers) as [QueueName, { handle: Handler; concurrency: number }][]) {
    const worker = new Worker<KeyJob, void, string, PostgresQueueBackend>(
      queue,
      async (job: Job<KeyJob, void, string>) => {
        const result = await h.handle(job.data.key);
        // "Not finished yet, look again later" is a normal outcome, not a failure.
        if (result && 'retryAfterSeconds' in result) {
          await followUp(queue, job.data.key, result.retryAfterSeconds * 1000, result.reason);
        }
      },
      { connection, concurrency: h.concurrency },
      createPostgresBackend,
    );
    worker.on('failed', (job, err) => console.error(`[worker] ${queue}:${job?.data.key} failed (attempt ${job?.attemptsMade})`, err.message));
    workers.push(worker);
  }

  const maintenance = new Worker<KeyJob, void, string, PostgresQueueBackend>(
    Queues.maintenance,
    async (job) => {
      const schedule = schedules.find((s) => s.name === job.name);
      if (schedule) await schedule.run();
    },
    { connection, concurrency: 2 },
    createPostgresBackend,
  );
  maintenance.on('failed', (job, err) => console.error(`[scheduler] ${job?.name} failed`, err.message));
  workers.push(maintenance);

  const maintenanceQueue = getQueue(Queues.maintenance);
  for (const s of schedules) {
    await maintenanceQueue.upsertJobScheduler(s.name, { every: s.every }, { name: s.name, data: { key: s.name } });
  }

  phase = 'running';
  console.log(`[worker] ${workerId} processing ${workers.length} queues`);
} else {
  phase = 'standby';
  console.log('[worker] CP_WORKER_PROCESSING=off — database setup only (staging slot)');
}

async function shutdown(signal: string) {
  console.log(`[worker] ${signal}: draining`);
  phase = 'stopping';
  await Promise.allSettled(workers.map((w) => w.close())); // waits for active jobs
  await closeQueues();
  await closeDb();
  health.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
