import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { EventType } from '@/shared/events';
import { enqueue, type QueueName } from '../jobs/queues';
import { getDb, type Db } from './client';
import { events } from './schema';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

export interface Actor {
  kind: 'user' | 'system' | 'github';
  id?: string;
}

export interface DomainEvent {
  type: EventType;
  version?: number;
  subject: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number | null;
  workspaceId?: string | null;
  workflowId?: number | null;
  causationId?: string;
  data: Record<string, unknown>;
}

interface WorkItem {
  queue: QueueName;
  key: string;
  delaySeconds: number;
  priority: number;
}

interface UnitContext {
  tx: Tx;
  actor: Actor;
  correlationId?: string;
  events: DomainEvent[];
  work: WorkItem[];
}

const storage = new AsyncLocalStorage<UnitContext>();

/** The current transaction if inside a unit of work, otherwise the pool-backed database. */
export function db(): Executor {
  return storage.getStore()?.tx ?? getDb();
}

/**
 * One transaction containing the state change and its events. Work items (BullMQ jobs) are
 * enqueued right AFTER the commit, so a job never points at uncommitted state. If the process
 * dies between commit and enqueue, the leased sweepers (observation/checker.ts) find the stuck
 * key and enqueue it — the system is level-triggered, so a lost signal only costs latency.
 * Nested calls join the outer unit. Never await a network call inside `fn`.
 */
export async function unitOfWork<T>(
  options: { actor: Actor; correlationId?: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (storage.getStore()) return fn();
  let work: WorkItem[] = [];
  const result = await getDb().transaction(async (tx) => {
    const ctx: UnitContext = { tx, actor: options.actor, correlationId: options.correlationId, events: [], work: [] };
    const value = await storage.run(ctx, fn);

    if (ctx.events.length > 0) {
      await tx.insert(events).values(
        ctx.events.map((e) => ({
          type: e.type,
          version: e.version ?? 1,
          subject: e.subject,
          aggregateType: e.aggregateType,
          aggregateId: e.aggregateId,
          aggregateVersion: e.aggregateVersion ?? null,
          actorKind: ctx.actor.kind,
          actorId: ctx.actor.id ?? null,
          workspaceId: e.workspaceId ?? null,
          workflowId: e.workflowId ?? null,
          correlationId: ctx.correlationId ?? null,
          causationId: e.causationId ?? null,
          data: e.data,
        })),
      );
      // Delivered by PostgreSQL only if this transaction commits.
      await tx.execute(sql`select pg_notify('cp_events', '')`);
    }
    work = ctx.work;
    return value;
  });
  if (work.length > 0) await flushWork(work);
  return result;
}

async function flushWork(work: WorkItem[]): Promise<void> {
  for (const w of work) {
    try {
      await enqueue(w.queue, w.key, { delayMs: w.delaySeconds * 1000, priority: w.priority });
    } catch (err) {
      console.error(`[uow] enqueue ${w.queue}:${w.key} failed (sweepers will recover)`, (err as Error).message);
    }
  }
}

function current(): UnitContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('This operation must run inside unitOfWork()');
  return ctx;
}

export function recordEvent(event: DomainEvent): void {
  current().events.push(event);
}

export function enqueueAfterCommit(queue: QueueName, key: string, opts: { delaySeconds?: number; priority?: number } = {}): void {
  current().work.push({ queue, key, delaySeconds: opts.delaySeconds ?? 0, priority: opts.priority ?? 100 });
}

export function currentActor(): Actor {
  return current().actor;
}

/** Postgres error code helper (e.g. '23505' unique violation). */
export function pgErrorCode(err: unknown): string | undefined {
  const anyErr = err as { code?: string; cause?: { code?: string } };
  return anyErr?.code ?? anyErr?.cause?.code;
}

/** Message of the underlying Postgres error (Drizzle wraps driver errors in `cause`). */
export function pgMessage(err: unknown): string {
  const anyErr = err as { message?: string; cause?: { message?: string } };
  return `${anyErr?.cause?.message ?? ''} ${anyErr?.message ?? ''}`;
}

export function pgConstraint(err: unknown): string | undefined {
  const anyErr = err as { constraint?: string; cause?: { constraint?: string } };
  return anyErr?.constraint ?? anyErr?.cause?.constraint;
}
