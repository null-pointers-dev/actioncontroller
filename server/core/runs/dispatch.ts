import 'server-only';
import { and, eq } from 'drizzle-orm';
import { isTerminal } from '@/shared/phases';
import type { InputSchema } from '@/shared/input-schema';
import { getEnv } from '@/server/env';
import { db, pgConstraint, pgErrorCode, recordEvent, unitOfWork } from '@/server/db/uow';
import {
  approvalRequests,
  runActions,
  users,
  workflowDefinitions,
  workflows,
  workspaceCredentials,
  workspaces,
  type RunRequestRow,
} from '@/server/db/schema';
import { dispatchWorkflow, findRunByTag, getLatestRun, GitHubError, runAction, type DispatchOutcome } from '@/server/github/api';
import { NoGitHubCapacity, pickCredential, type PickedCredential } from '@/server/github/pool';
import { authorize } from '../access/access';
import { loadPrincipal } from '../identity/identity';
import { applyRunSnapshot } from '../observation/apply';
import { loadRequest, setConditions, transition, withCondition, withoutCondition } from './lifecycle';

/** A reconcile step either finishes or asks to run again later. */
export type StepResult = { done: true } | { retryAfterSeconds: number; reason: string };
const done: StepResult = { done: true };
/** Condition meaning "GitHub refused before accepting" — retrying cannot create a duplicate. */
const NOT_ACCEPTED = 'DispatchNotAccepted';
const later = (retryAfterSeconds: number, reason: string): StepResult => ({ retryAfterSeconds, reason });

/** Queue `dispatch`, key = run request id. One step per call (docs/07 §7 decision table). */
export async function reconcileDispatch(requestId: string): Promise<StepResult> {
  const req = await loadRequest(requestId);
  if (!req || isTerminal(req.phase)) return done;

  switch (req.phase) {
    case 'pending':
    case 'waiting_for_slot':
      return startOrWait(req);
    case 'awaiting_approval':
      return afterApproval(req);
    case 'dispatching': {
      // Found mid-call: a previous worker died after committing "dispatching". Outcome unknown.
      const moved = await transition(req, 'verifying', { patch: { verifyUntil: verifyDeadline() } });
      return moved ? later(5, 'verify after interrupted dispatch') : later(1, 'version conflict');
    }
    case 'verifying':
      return verify(req);
    case 'dispatched':
    case 'running':
      if (!req.cancelRequested) return done;
      return startCancelling(req);
    case 'cancelling':
      return continueCancelling(req);
    default:
      return done;
  }
}

function verifyDeadline(): Date {
  return new Date(Date.now() + getEnv().DISPATCH_VERIFY_WINDOW_SECONDS * 1000);
}

async function afterApproval(req: RunRequestRow): Promise<StepResult> {
  const [approval] = await db().select().from(approvalRequests).where(eq(approvalRequests.runRequestId, req.id)).limit(1);
  if (req.cancelRequested || approval?.state === 'withdrawn') {
    await transition(req, 'cancelled', { reason: 'cancelled_before_start' });
    return done;
  }
  if (!approval || approval.state === 'pending') return done; // the decision re-enqueues us
  if (approval.state === 'denied' || approval.state === 'expired') {
    await transition(req, 'rejected', { reason: approval.state === 'denied' ? 'approval_denied' : 'approval_expired' });
    return done;
  }
  return startOrWait(req);
}

async function requesterStillAllowed(req: RunRequestRow): Promise<boolean> {
  const principal = await loadPrincipal(req.requestedBy);
  if (!principal) return false;
  const [wf] = await db().select({ exposed: workflows.exposed }).from(workflows).where(eq(workflows.id, req.workflowId)).limit(1);
  try {
    await authorize(principal, 'run', req.workspaceId, { environment: req.environment, workflowExposed: wf?.exposed ?? false });
    return true;
  } catch {
    return false;
  }
}

async function startOrWait(req: RunRequestRow): Promise<StepResult> {
  if (req.cancelRequested) {
    await transition(req, 'cancelled', { reason: 'cancelled_before_start' });
    return done;
  }
  if (!(await requesterStillAllowed(req))) {
    await transition(req, 'rejected', { reason: 'authorization_revoked', message: 'Your access changed before the run could start' });
    return done;
  }

  // Pick a credential BEFORE committing "dispatching": no capacity => stay put, visibly.
  let credential: PickedCredential;
  try {
    credential = await pickCredential(req.workspaceId, 'dispatch');
  } catch (err) {
    if (!(err instanceof NoGitHubCapacity)) throw err;
    await setConditions(req, withCondition(req.conditions, 'NoGitHubCapacity', 'True', 'no_credential', 'Waiting for GitHub capacity'));
    return later(60, 'no GitHub capacity');
  }

  let moved: RunRequestRow | null;
  try {
    moved = await transition(req, 'dispatching', {
      patch: {
        dispatchAttempts: req.dispatchAttempts + 1,
        dispatchSentAt: new Date(),
        verifyUntil: verifyDeadline(),
        conditions: withoutCondition(req.conditions, 'NoGitHubCapacity'),
      },
    });
  } catch (err) {
    if (pgErrorCode(err) === '23505' && pgConstraint(err) === 'run_requests_one_active_per_slot') {
      if (req.phase !== 'waiting_for_slot') await transition(req, 'waiting_for_slot', { reason: 'slot_busy' });
      return done; // slot release wakes us
    }
    throw err;
  }
  if (!moved) return later(1, 'version conflict');
  return sendDispatch(moved, credential);
}

/** Sends the dispatch. Retries immediately only when GitHub provably did not accept it. */
async function sendDispatch(req: RunRequestRow, firstCredential: PickedCredential): Promise<StepResult> {
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, req.workspaceId)).limit(1);
  const [def] = await db()
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.workflowId, req.workflowId), eq(workflowDefinitions.ref, req.ref)))
    .limit(1);
  if (!ws || !def) {
    await transition(req, 'failed', { reason: 'definition_missing' });
    return done;
  }
  const reserved = (def.inputSchema as InputSchema)['x-cp-reserved'] ?? [];
  const inputs: Record<string, string | number | boolean> = { ...req.inputs };
  if (reserved.includes('_cp_tag')) inputs['_cp_tag'] = req.correlationTag;
  if (reserved.includes('_cp_requested_by')) {
    const [u] = await db().select({ login: users.githubLogin, email: users.email }).from(users).where(eq(users.id, req.requestedBy)).limit(1);
    inputs['_cp_requested_by'] = u?.login ?? u?.email ?? req.requestedBy;
  }

  let credential: PickedCredential | null = firstCredential;
  let outcome: DispatchOutcome | null = null;
  for (let attempt = 0; attempt < 3 && credential; attempt++) {
    outcome = await dispatchWorkflow({ workspaceId: ws.id, credential, fullName: ws.fullName, workflowId: req.workflowId, ref: req.ref, inputs });
    if (outcome.kind !== 'credential_refused') break;
    if (outcome.permission) {
      await db()
        .update(workspaceCredentials)
        .set({ canDispatch: false, lastError: outcome.reason.slice(0, 300), validatedAt: new Date() })
        .where(and(eq(workspaceCredentials.workspaceId, ws.id), eq(workspaceCredentials.credentialId, credential.id)));
    }
    credential = await pickCredential(ws.id, 'dispatch').catch(() => null);
  }
  if (!outcome) return later(30, 'no outcome');

  switch (outcome.kind) {
    case 'accepted':
      if (outcome.runId) {
        await transition(req, 'dispatched', { patch: { githubRunId: outcome.runId, dispatchedWith: outcome.credentialId } });
        return done;
      }
      // Accepted without a run id (older API behaviour): find it by tag.
      await transition(req, 'verifying', { patch: { dispatchedWith: outcome.credentialId } });
      return later(5, 'accepted without run id');
    case 'rejected':
      await transition(req, 'failed', { reason: `github_${outcome.status}`, message: outcome.message.slice(0, 500) });
      return done;
    case 'credential_refused':
      // Every credential refused BEFORE acceptance: nothing was created on GitHub, so a later
      // retry is safe even without a correlation tag.
      await transition(req, 'verifying', {
        message: 'No GitHub credential could send the run right now; retrying shortly',
        patch: { conditions: withCondition(req.conditions, NOT_ACCEPTED, 'True', 'credentials_refused', outcome.reason.slice(0, 200)) },
      });
      return later(getEnv().DISPATCH_VERIFY_WINDOW_SECONDS, 'credentials refused');
    case 'unknown':
      await transition(req, 'verifying', { patch: { dispatchedWith: outcome.credentialId } });
      return later(5, `unknown outcome: ${outcome.reason}`);
  }
}

async function verify(req: RunRequestRow): Promise<StepResult> {
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, req.workspaceId)).limit(1);
  if (!ws) return done;
  const [def] = await db()
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.workflowId, req.workflowId), eq(workflowDefinitions.ref, req.ref)))
    .limit(1);
  const hasTag = ((def?.inputSchema as InputSchema | undefined)?.['x-cp-reserved'] ?? []).includes('_cp_tag');
  const notAccepted = req.conditions.some((c) => c.type === NOT_ACCEPTED && c.status === 'True');

  if (hasTag && !notAccepted) {
    try {
      const since = new Date((req.dispatchSentAt ?? req.createdAt).getTime() - 2 * 60_000);
      const found = await findRunByTag({ workspaceId: ws.id, fullName: ws.fullName, workflowId: req.workflowId, tag: req.correlationTag, since });
      if (found) {
        await applyRunSnapshot({ ...found, repoId: ws.githubRepoId }, 'poll'); // links the run and moves the request
        return req.cancelRequested ? later(1, 'cancel after adoption') : done;
      }
    } catch (err) {
      if (err instanceof NoGitHubCapacity) return later(60, 'no GitHub capacity to verify');
      if (!(err instanceof GitHubError)) throw err;
      return later(15, `verify failed: ${err.message}`);
    }
  }

  if (req.verifyUntil && req.verifyUntil > new Date()) return later(10, 'waiting for the run to appear');

  if (!hasTag && !notAccepted) {
    // Without a correlation tag a retry could start a duplicate: stop and tell the user.
    await transition(req, req.cancelRequested ? 'cancelled' : 'lost', {
      reason: 'unconfirmed_without_tag',
      message: 'GitHub did not confirm the run. Check GitHub before running again (add _cp_tag to the workflow to avoid this).',
    });
    return done;
  }
  if (req.cancelRequested) {
    await transition(req, 'cancelled', { reason: 'cancelled_before_start' });
    return done;
  }
  if (req.dispatchAttempts >= getEnv().DISPATCH_MAX_ATTEMPTS) {
    await transition(req, 'lost', { reason: 'dispatch_unconfirmed', message: 'GitHub did not confirm the run after several attempts' });
    return done;
  }
  // Provably not created: dispatch again.
  let credential: PickedCredential;
  try {
    credential = await pickCredential(req.workspaceId, 'dispatch');
  } catch (err) {
    if (err instanceof NoGitHubCapacity) return later(60, 'no GitHub capacity');
    throw err;
  }
  const moved = await transition(req, 'dispatching', {
    patch: {
      dispatchAttempts: req.dispatchAttempts + 1,
      dispatchSentAt: new Date(),
      verifyUntil: verifyDeadline(),
      conditions: withoutCondition(req.conditions, NOT_ACCEPTED),
    },
  });
  if (!moved) return later(1, 'version conflict');
  return sendDispatch(moved, credential);
}

async function startCancelling(req: RunRequestRow): Promise<StepResult> {
  const moved = await transition(req, 'cancelling', { reason: 'cancel_requested' });
  if (!moved) return later(1, 'version conflict');
  return callCancel(moved);
}

async function continueCancelling(req: RunRequestRow): Promise<StepResult> {
  if (Date.now() - req.updatedAt.getTime() < 120_000) return later(60, 'waiting for GitHub to cancel');
  return callCancel(req);
}

async function callCancel(req: RunRequestRow): Promise<StepResult> {
  if (!req.githubRunId) return later(10, 'no run to cancel yet');
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, req.workspaceId)).limit(1);
  if (!ws) return done;
  try {
    await runAction({ workspaceId: ws.id, fullName: ws.fullName, runId: req.githubRunId, action: 'cancel' });
  } catch (err) {
    if (err instanceof GitHubError && err.status === 409) {
      // Already finished: observation will settle the final phase.
      const run = await getLatestRun(ws.id, ws.fullName, req.githubRunId);
      await applyRunSnapshot({ ...run, repoId: ws.githubRepoId }, 'poll');
      return done;
    }
    if (err instanceof NoGitHubCapacity || err instanceof GitHubError) return later(30, (err as Error).message);
    throw err;
  }
  return later(60, 'cancel sent; waiting for GitHub');
}

// ---------------------------------------------------------------- run actions (queue `run-action`)

export async function reconcileRunAction(actionId: string): Promise<StepResult> {
  const [action] = await db().select().from(runActions).where(eq(runActions.id, actionId)).limit(1);
  if (!action || ['done', 'failed', 'rejected'].includes(action.phase)) return done;
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, action.workspaceId)).limit(1);
  if (!ws) return done;

  const finish = (phase: 'done' | 'failed' | 'rejected', patch: { phaseReason?: string; resultAttempt?: number } = {}) =>
    unitOfWork({ actor: { kind: 'system', id: 'run-actions' } }, async () => {
      await db().update(runActions).set({ phase, ...patch }).where(eq(runActions.id, action.id));
      recordEvent({
        type: phase === 'done' ? 'cp.run_action.completed' : 'cp.run_action.failed',
        subject: `run-actions/${action.id}`,
        aggregateType: 'run_action',
        aggregateId: action.id,
        workspaceId: action.workspaceId,
        data: { runActionId: action.id, action: action.action, runId: action.githubRunId, ...patch },
      });
    });

  // Resumed after a crash while "sending": check whether GitHub already did it.
  if (action.phase === 'sending') {
    const latest = await getLatestRun(ws.id, ws.fullName, action.githubRunId);
    if (action.action !== 'cancel' && latest.attempt > action.runAttempt) {
      await finish('done', { resultAttempt: latest.attempt });
      return done;
    }
    if (action.action === 'cancel' && latest.status === 'completed') {
      await finish('done');
      return done;
    }
  } else {
    await db().update(runActions).set({ phase: 'sending' }).where(eq(runActions.id, action.id));
  }

  try {
    await runAction({ workspaceId: ws.id, fullName: ws.fullName, runId: action.githubRunId, action: action.action, jobId: action.jobId });
  } catch (err) {
    if (err instanceof GitHubError && (err.kind === 'definite' || err.kind === 'not_found')) {
      await finish(err.status === 403 ? 'rejected' : 'failed', { phaseReason: err.message.slice(0, 300) });
      return done;
    }
    return later(30, (err as Error).message);
  }
  let resultAttempt: number | undefined;
  if (action.action !== 'cancel') {
    const latest = await getLatestRun(ws.id, ws.fullName, action.githubRunId).catch(() => null);
    if (latest) {
      resultAttempt = latest.attempt;
      await applyRunSnapshot({ ...latest, repoId: ws.githubRepoId }, 'poll');
    }
  }
  await finish('done', resultAttempt ? { resultAttempt } : {});
  return done;
}
