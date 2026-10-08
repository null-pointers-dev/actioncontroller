import 'server-only';
import { and, eq, isNull, or } from 'drizzle-orm';
import { githubStatusRank, isTerminal, PHASE_PROGRESS, phaseForGithubRun, canTransition } from '@/shared/phases';
import { db, recordEvent, unitOfWork } from '@/server/db/uow';
import { runRequests, workflowJobs, workflowRuns, workspaces, type WorkflowRunRow } from '@/server/db/schema';
import type { JobSnapshot, RunSnapshot } from '@/server/github/api';
import { transition } from '../runs/lifecycle';

export type ApplyResult = 'inserted' | 'changed' | 'confirmed' | 'stale' | 'ignored';
const GITHUB = { kind: 'github' as const };
const TAG = /cp-[0-9a-f]{12}/;

/**
 * The single entry point for run facts, from webhooks AND polling (docs/07 §7 observation).
 * Forward-only; adopts the run for its request by correlation tag; moves the request forward.
 */
export async function applyRunSnapshot(snap: RunSnapshot, via: 'webhook' | 'poll'): Promise<ApplyResult> {
  return unitOfWork({ actor: GITHUB }, async () => {
    const [ws] = await db().select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.githubRepoId, snap.repoId)).limit(1);
    if (!ws) return 'ignored';

    const values = {
      workspaceId: ws.id,
      workflowId: snap.workflowId,
      event: snap.event,
      displayTitle: snap.displayTitle,
      headBranch: snap.headBranch,
      headSha: snap.headSha,
      actorLogin: snap.actorLogin,
      triggeringActorLogin: snap.triggeringActorLogin,
      htmlUrl: snap.htmlUrl,
      status: snap.status,
      conclusion: snap.conclusion,
      ghCreatedAt: snap.createdAt,
      ghUpdatedAt: snap.updatedAt,
      runStartedAt: snap.runStartedAt,
      completedAt: snap.status === 'completed' ? snap.updatedAt : null,
      lastSeenAt: new Date(),
      lastSeenVia: via,
    };
    const key = and(eq(workflowRuns.runId, snap.runId), eq(workflowRuns.runAttempt, snap.attempt));

    let [row] = await db().select().from(workflowRuns).where(key).for('update').limit(1);
    let result: ApplyResult;
    let previous: WorkflowRunRow | undefined;

    if (!row) {
      const inserted = await db()
        .insert(workflowRuns)
        .values({ runId: snap.runId, runAttempt: snap.attempt, ...values })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) {
        row = inserted[0];
        result = 'inserted';
      } else {
        [row] = await db().select().from(workflowRuns).where(key).for('update').limit(1);
        result = 'stale';
      }
    } else {
      result = 'stale';
    }

    if (row && result !== 'inserted') {
      previous = row;
      const incoming = githubStatusRank(snap.status, snap.conclusion);
      const current = githubStatusRank(row.status, row.conclusion);
      const newer = incoming > current || (incoming === current && snap.updatedAt > row.ghUpdatedAt);
      if (newer) {
        [row] = await db().update(workflowRuns).set(values).where(key).returning();
        result = 'changed';
      } else if (snap.status === row.status && snap.conclusion === row.conclusion) {
        await db().update(workflowRuns).set({ lastSeenAt: new Date(), lastSeenVia: via }).where(key);
        result = 'confirmed';
      }
    }
    if (!row) return 'ignored';

    // Owner resolution: only the first attempt of a run belongs to a request.
    if (!row.runRequestId && snap.attempt === 1) {
      const ownerId = await findOwner(snap);
      if (ownerId) {
        [row] = await db().update(workflowRuns).set({ runRequestId: ownerId }).where(key).returning();
        if (result === 'stale' || result === 'confirmed') result = 'changed';
      }
    }
    if (row?.runRequestId && result !== 'stale') await reflectOnRequest(row.runRequestId, row);

    if (row) emitRunEvents(row, previous, result, via);
    return result;
  });
}

async function findOwner(snap: RunSnapshot): Promise<string | null> {
  const [byRunId] = await db().select({ id: runRequests.id }).from(runRequests).where(eq(runRequests.githubRunId, snap.runId)).limit(1);
  if (byRunId) return byRunId.id;
  const tag = snap.displayTitle?.match(TAG)?.[0];
  if (!tag) return null;
  const [byTag] = await db()
    .select({ id: runRequests.id })
    .from(runRequests)
    .where(
      and(
        eq(runRequests.correlationTag, tag),
        eq(runRequests.workflowId, snap.workflowId), // tags can't be borrowed by other workflows
        or(isNull(runRequests.githubRunId), eq(runRequests.githubRunId, snap.runId)),
      ),
    )
    .limit(1);
  return byTag?.id ?? null;
}

/** Moves the owning request forward from its GitHub run (never backwards). */
async function reflectOnRequest(requestId: string, run: WorkflowRunRow): Promise<void> {
  const [req] = await db().select().from(runRequests).where(eq(runRequests.id, requestId)).for('update').limit(1);
  if (!req || isTerminal(req.phase)) return;
  if (req.githubRunId && req.githubRunId !== run.runId) return; // a different run owns this request

  const patch = req.githubRunId ? {} : { githubRunId: run.runId };
  const target = phaseForGithubRun(run.status, run.conclusion);
  const keepCancelling = req.phase === 'cancelling' && (target === 'dispatched' || target === 'running');
  const forward =
    target !== null && !keepCancelling && PHASE_PROGRESS[target] > PHASE_PROGRESS[req.phase] && canTransition(req.phase, target);

  if (forward) {
    await transition(req, target, {
      patch,
      actor: GITHUB,
      reason: target === 'failed' ? `github_${run.conclusion ?? 'failure'}` : undefined,
    });
  } else if (Object.keys(patch).length > 0) {
    await transition(req, req.phase, { patch, actor: GITHUB });
  }
}

function emitRunEvents(row: WorkflowRunRow, previous: WorkflowRunRow | undefined, result: ApplyResult, via: 'webhook' | 'poll') {
  const base = {
    subject: `github-runs/${row.runId}/${row.runAttempt}`,
    aggregateType: 'github_run',
    aggregateId: `${row.runId}/${row.runAttempt}`,
    aggregateVersion: row.resourceVersion,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
  };
  const data = { runId: row.runId, attempt: row.runAttempt, status: row.status, conclusion: row.conclusion, runRequestId: row.runRequestId };
  if (result === 'inserted') recordEvent({ ...base, type: 'cp.github_run.observed', data: { ...data, htmlUrl: row.htmlUrl, event: row.event } });
  if (result === 'changed' || result === 'inserted') {
    if (!previous || previous.status !== row.status || previous.conclusion !== row.conclusion) {
      recordEvent({ ...base, type: 'cp.github_run.status_changed', data: { ...data, from: previous ? { status: previous.status, conclusion: previous.conclusion } : null } });
    }
    if (row.status === 'completed' && previous?.status !== 'completed') recordEvent({ ...base, type: 'cp.github_run.completed', data });
    if (via === 'poll' && previous && previous.status !== row.status) {
      recordEvent({ ...base, type: 'cp.system.drift_corrected', data: { ...data, from: previous.status } });
    }
  }
}

export async function applyJobSnapshot(snap: JobSnapshot, via: 'webhook' | 'poll'): Promise<ApplyResult> {
  return unitOfWork({ actor: GITHUB }, async () => {
    const [ws] = await db().select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.githubRepoId, snap.repoId)).limit(1);
    if (!ws) return 'ignored';
    const values = {
      runId: snap.runId,
      runAttempt: snap.attempt,
      workspaceId: ws.id,
      name: snap.name,
      status: snap.status,
      conclusion: snap.conclusion,
      runnerName: snap.runnerName,
      labels: snap.labels,
      steps: snap.steps,
      htmlUrl: snap.htmlUrl,
      startedAt: snap.startedAt,
      completedAt: snap.completedAt,
      lastSeenAt: new Date(),
      lastSeenVia: via,
    };
    const [existing] = await db().select().from(workflowJobs).where(eq(workflowJobs.id, snap.id)).for('update').limit(1);
    let row = existing;
    let result: ApplyResult;
    if (!existing) {
      [row] = await db().insert(workflowJobs).values({ id: snap.id, ...values }).onConflictDoNothing().returning();
      result = row ? 'inserted' : 'stale';
    } else {
      const incoming = githubStatusRank(snap.status, snap.conclusion);
      const current = githubStatusRank(existing.status, existing.conclusion);
      const stepsChanged = JSON.stringify(existing.steps) !== JSON.stringify(snap.steps);
      if (incoming > current || (incoming === current && (existing.status !== snap.status || stepsChanged))) {
        [row] = await db().update(workflowJobs).set(values).where(eq(workflowJobs.id, snap.id)).returning();
        result = 'changed';
      } else if (incoming === current) {
        await db().update(workflowJobs).set({ lastSeenAt: new Date(), lastSeenVia: via }).where(eq(workflowJobs.id, snap.id));
        result = 'confirmed';
      } else {
        result = 'stale';
      }
    }
    if (row && (result === 'inserted' || result === 'changed') && (!existing || existing.status !== row.status || existing.conclusion !== row.conclusion)) {
      const event = {
        subject: `github-jobs/${row.id}`,
        aggregateType: 'github_job',
        aggregateId: String(row.id),
        aggregateVersion: row.resourceVersion,
        workspaceId: row.workspaceId,
        data: { jobId: row.id, runId: row.runId, attempt: row.runAttempt, name: row.name, status: row.status, conclusion: row.conclusion },
      };
      recordEvent({ ...event, type: row.status === 'completed' ? 'cp.github_job.completed' : 'cp.github_job.status_changed' });
    }
    return result;
  });
}
