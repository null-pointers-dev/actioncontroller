import 'server-only';
import { createPostgresBackend, Queue, type PostgresQueueBackend } from 'bullmq';
import { getQueuePool } from '../db/client';

/**
 * BullMQ on PostgreSQL (BullMQ 6+): queues live in the `bullmq` schema of the same database.
 * Jobs carry only a key; handlers always re-read current state (level-triggered), so a
 * duplicate or late job is harmless.
 */
export const Queues = {
  dispatch: 'dispatch',
  runAction: 'run-action',
  sync: 'sync',
  check: 'check',
  poll: 'poll',
  webhook: 'webhook',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof Queues)[keyof typeof Queues];

export interface KeyJob {
  key: string;
  reason?: string;
}

export type CpQueue = Queue<KeyJob, void, string, PostgresQueueBackend>;

const globals = globalThis as typeof globalThis & { __cpQueues?: Map<QueueName, CpQueue> };
globals.__cpQueues ??= new Map();

export function getQueue(name: QueueName): CpQueue {
  let queue = globals.__cpQueues!.get(name);
  if (!queue) {
    queue = new Queue<KeyJob, void, string, PostgresQueueBackend>(
      name,
      {
        connection: getQueuePool(),
        defaultJobOptions: {
          attempts: 8,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 3_600, count: 2_000 },
          removeOnFail: { age: 7 * 24 * 3_600 },
        },
      },
      createPostgresBackend,
    );
    globals.__cpQueues!.set(name, queue);
  }
  return queue;
}

export interface EnqueueOptions {
  delayMs?: number;
  /** Lower = sooner (our scale). User actions use 10 or less and get BullMQ's top priority. */
  priority?: number;
  /** Stable id: BullMQ ignores an add while a job with this id exists (e.g. webhook delivery GUID). */
  jobId?: string;
}

/** Signal: "look at this key". Duplicates are fine; handlers are idempotent. */
export async function enqueue(queue: QueueName, key: string, opts: EnqueueOptions = {}): Promise<void> {
  await getQueue(queue).add(queue, { key }, {
    delay: opts.delayMs && opts.delayMs > 0 ? opts.delayMs : undefined,
    // BullMQ: jobs without priority run first; background work gets a numeric priority.
    priority: opts.priority && opts.priority > 10 ? opts.priority : undefined,
    jobId: opts.jobId,
  });
}

/**
 * "Run this key again later" (a reconcile step asked to retry). Throttled per key so that
 * several concurrent chains for one key collapse into one.
 */
export async function followUp(queue: QueueName, key: string, delayMs: number, reason: string): Promise<void> {
  await getQueue(queue).add(queue, { key, reason }, {
    delay: delayMs,
    deduplication: { id: `${queue}:${key}`, ttl: Math.max(1_000, delayMs - 500) },
  });
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...globals.__cpQueues!.values()].map((q) => q.close()));
  globals.__cpQueues!.clear();
}
