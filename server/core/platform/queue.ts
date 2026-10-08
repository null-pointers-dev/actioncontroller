import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/server/db/client';

export interface ClaimedItem {
  key: string;
  attempts: number;
}

export const Queues = {
  dispatch: 'dispatch',
  runAction: 'run-action',
  sync: 'sync',
  check: 'check',
  poll: 'poll',
} as const;
export type QueueName = (typeof Queues)[keyof typeof Queues];

export async function enqueue(queue: QueueName, key: string, delaySeconds = 0, priority = 100): Promise<void> {
  await getDb().execute(sql`select cp.enqueue(${queue}, ${key}, ${`${delaySeconds} seconds`}::interval, ${priority})`);
}

export async function claim(queue: QueueName, worker: string, limit: number, leaseSeconds = 60): Promise<ClaimedItem[]> {
  const res = await getDb().execute<{ work_key: string; work_attempts: number }>(
    sql`select work_key, work_attempts from cp.claim_work(${queue}, ${worker}, ${limit}, ${`${leaseSeconds} seconds`}::interval)`,
  );
  return res.rows.map((r) => ({ key: r.work_key, attempts: Number(r.work_attempts) }));
}

export async function finish(queue: QueueName, key: string, worker: string): Promise<void> {
  await getDb().execute(sql`select cp.finish_work(${queue}, ${key}, ${worker})`);
}

/** Release with exponential backoff, or with an explicit delay. */
export async function retry(queue: QueueName, key: string, worker: string, error: string, delaySeconds?: number): Promise<void> {
  if (delaySeconds === undefined) {
    await getDb().execute(sql`select cp.retry_work(${queue}, ${key}, ${worker}, ${error})`);
    return;
  }
  await getDb().execute(sql`
    update cp.work_queue
       set locked_by = null, locked_until = null, last_error = ${error},
           run_after = now() + ${`${delaySeconds} seconds`}::interval
     where queue = ${queue} and key = ${key} and locked_by = ${worker}`);
}
