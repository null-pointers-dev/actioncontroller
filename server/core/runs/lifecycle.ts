import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { canTransition, isTerminal, type Phase } from '@/shared/phases';
import { db, enqueueAfterCommit, recordEvent, unitOfWork, type Actor } from '@/server/db/uow';
import { runRequests, type Condition, type RunRequestRow } from '@/server/db/schema';
import { Queues } from '../platform/queue';

export const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'dispatcher' };

export interface TransitionOptions {
  reason?: string | null;
  message?: string | null;
  patch?: Partial<Pick<RunRequestRow, 'githubRunId' | 'dispatchedWith' | 'dispatchAttempts' | 'dispatchSentAt' | 'verifyUntil' | 'conditions'>>;
  actor?: Actor;
}

/**
 * Version-guarded phase change + events, inside (or joining) a unit of work.
 * Returns the updated row, or null when someone else changed the request first.
 */
export async function transition(req: RunRequestRow, to: Phase, opts: TransitionOptions = {}): Promise<RunRequestRow | null> {
  if (!canTransition(req.phase, to)) throw new Error(`Illegal transition ${req.phase} -> ${to} for ${req.id}`);
  return unitOfWork({ actor: opts.actor ?? SYSTEM_ACTOR }, async () => {
    const [row] = await db()
      .update(runRequests)
      .set({
        phase: to,
        ...(opts.reason !== undefined ? { phaseReason: opts.reason } : {}),
        ...(opts.message !== undefined ? { phaseMessage: opts.message } : {}),
        ...(opts.patch ?? {}),
      })
      .where(and(eq(runRequests.id, req.id), eq(runRequests.resourceVersion, req.resourceVersion)))
      .returning();
    if (!row) return null;
    if (to !== req.phase) {
      recordEvent({
        type: 'cp.run_request.phase_changed',
        subject: `run-requests/${row.id}`,
        aggregateType: 'run_request',
        aggregateId: row.id,
        aggregateVersion: row.resourceVersion,
        workspaceId: row.workspaceId,
        workflowId: row.workflowId,
        data: { runRequestId: row.id, from: req.phase, to, reason: row.phaseReason, githubRunId: row.githubRunId },
      });
      if (isTerminal(to)) {
        recordEvent({
          type: 'cp.run_request.completed',
          subject: `run-requests/${row.id}`,
          aggregateType: 'run_request',
          aggregateId: row.id,
          aggregateVersion: row.resourceVersion,
          workspaceId: row.workspaceId,
          workflowId: row.workflowId,
          data: { runRequestId: row.id, outcome: to, reason: row.phaseReason, githubRunId: row.githubRunId },
        });
        if (row.concurrencyKey) await wakeNextInSlot(row.concurrencyKey);
      }
    }
    return row;
  });
}

/** When a deploy finishes, the oldest request queued behind it gets its turn. */
export async function wakeNextInSlot(concurrencyKey: string): Promise<void> {
  const [next] = await db()
    .select({ id: runRequests.id })
    .from(runRequests)
    .where(and(eq(runRequests.concurrencyKey, concurrencyKey), eq(runRequests.phase, 'waiting_for_slot')))
    .orderBy(asc(runRequests.createdAt))
    .limit(1);
  if (next) enqueueAfterCommit(Queues.dispatch, next.id, { priority: 10 });
}

export function withCondition(conditions: Condition[], type: string, status: 'True' | 'False', reason?: string, message?: string): Condition[] {
  const others = conditions.filter((c) => c.type !== type);
  const existing = conditions.find((c) => c.type === type);
  if (existing && existing.status === status && existing.reason === reason) return conditions;
  return [...others, { type, status, reason, message, since: new Date().toISOString() }];
}

export function withoutCondition(conditions: Condition[], type: string): Condition[] {
  return conditions.filter((c) => c.type !== type);
}

/** Update only the conditions (no phase change). */
export async function setConditions(req: RunRequestRow, conditions: Condition[]): Promise<RunRequestRow | null> {
  if (JSON.stringify(conditions) === JSON.stringify(req.conditions)) return req;
  return unitOfWork({ actor: SYSTEM_ACTOR }, async () => {
    const [row] = await db()
      .update(runRequests)
      .set({ conditions })
      .where(and(eq(runRequests.id, req.id), eq(runRequests.resourceVersion, req.resourceVersion)))
      .returning();
    return row ?? null;
  });
}

export async function loadRequest(id: string): Promise<RunRequestRow | null> {
  const [row] = await db().select().from(runRequests).where(eq(runRequests.id, id)).limit(1);
  return row ?? null;
}
