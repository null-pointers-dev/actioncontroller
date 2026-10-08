import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/server/db/client';
import { db, enqueueAfterCommit, unitOfWork } from '@/server/db/uow';
import { webhookDeliveries, workspaces } from '@/server/db/schema';
import { toJobSnapshot, toRunSnapshot } from '@/server/github/mappers';
import { Queues } from '../platform/queue';
import { applyJobSnapshot, applyRunSnapshot } from './apply';

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const MAX_ATTEMPTS = 10;

/** Worker step: process stored GitHub deliveries (the HTTP endpoint only stores them). */
export async function processPendingDeliveries(limit = 25): Promise<number> {
  const pending = await getDb()
    .select({ receivedAt: webhookDeliveries.receivedAt, guid: webhookDeliveries.deliveryGuid })
    .from(webhookDeliveries)
    .where(and(inArray(webhookDeliveries.processStatus, ['pending', 'failed']), sql`${webhookDeliveries.attempts} < ${MAX_ATTEMPTS}`))
    .orderBy(webhookDeliveries.receivedAt)
    .limit(limit);
  for (const p of pending) await processOne(p.receivedAt, p.guid);
  return pending.length;
}

async function processOne(receivedAt: Date, guid: string): Promise<void> {
  const key = and(eq(webhookDeliveries.receivedAt, receivedAt), eq(webhookDeliveries.deliveryGuid, guid));
  try {
    await unitOfWork({ actor: { kind: 'github' } }, async () => {
      const [d] = await db()
        .select()
        .from(webhookDeliveries)
        .where(and(key, inArray(webhookDeliveries.processStatus, ['pending', 'failed'])))
        .for('update', { skipLocked: true })
        .limit(1);
      if (!d) return;
      const outcome = await handle(d.eventType, d.payload as Payload);
      await db()
        .update(webhookDeliveries)
        .set({ processStatus: outcome, processedAt: new Date(), attempts: d.attempts + 1, lastError: null })
        .where(key);
    });
  } catch (err) {
    await getDb()
      .update(webhookDeliveries)
      .set({
        processStatus: sql`case when ${webhookDeliveries.attempts} + 1 >= ${MAX_ATTEMPTS} then 'dead' else 'failed' end`,
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        lastError: (err as Error).message.slice(0, 1000),
      })
      .where(key);
  }
}

async function handle(eventType: string, payload: Payload): Promise<'applied' | 'ignored'> {
  const repoId = Number(payload.repository?.id);
  switch (eventType) {
    case 'workflow_run': {
      const r = await applyRunSnapshot(toRunSnapshot(payload.workflow_run, repoId), 'webhook');
      return r === 'ignored' ? 'ignored' : 'applied';
    }
    case 'workflow_job': {
      const r = await applyJobSnapshot(toJobSnapshot(payload.workflow_job, repoId), 'webhook');
      return r === 'ignored' ? 'ignored' : 'applied';
    }
    case 'push': {
      const commits: Payload[] = Array.isArray(payload.commits) ? payload.commits : [];
      const touched = commits.some((c) =>
        [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].some((f: string) => f.startsWith('.github/workflows/')),
      );
      if (!touched) return 'ignored';
      return (await enqueueSyncFor(repoId)) ? 'applied' : 'ignored';
    }
    case 'repository':
      return (await enqueueSyncFor(repoId)) ? 'applied' : 'ignored';
    default:
      return 'ignored'; // ping, etc.
  }
}

async function enqueueSyncFor(repoId: number): Promise<boolean> {
  const [ws] = await db().select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.githubRepoId, repoId)).limit(1);
  if (!ws) return false;
  enqueueAfterCommit(Queues.sync, ws.id, { delaySeconds: 5, priority: 40 });
  return true;
}
