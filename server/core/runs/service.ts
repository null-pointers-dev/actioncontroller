import 'server-only';
import { and, desc, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import { environmentInputName, type InputSchema, type InputValue, type UiSchema } from '@/shared/input-schema';
import { isTerminal, TERMINAL_PHASES, type Phase } from '@/shared/phases';
import { db, enqueueAfterCommit, pgErrorCode, pgMessage, recordEvent, unitOfWork } from '@/server/db/uow';
import {
  approvalDecisions,
  approvalRequests,
  runActions,
  runRequests,
  workflowJobs,
  workflowRuns,
  workflows,
  workspaces,
  type RunRequestRow,
} from '@/server/db/schema';
import { authorize, capabilitiesFor, visibleWorkspaceIds } from '../access/access';
import type { Principal } from '../access/policy';
import { AdmissionRejected, Conflict, Forbidden, NotFound, type Problem } from '../errors';
import { displayNames } from '../identity/identity';
import { Queues } from '@/server/jobs/queues';
import { ensureDefinition, loadWorkflow } from '../workspaces/workspaces';
import { admit } from './admission';
import { withCondition } from './lifecycle';

type Ctx = { principal: Principal; correlationId?: string };
const TERMINAL = [...TERMINAL_PHASES] as Phase[];

function sameRequest(row: RunRequestRow, workflowId: number, ref: string, inputs: Record<string, InputValue>): boolean {
  return row.workflowId === workflowId && row.ref === ref && JSON.stringify(row.inputs) === JSON.stringify(inputs);
}

async function prepare(ctx: Ctx, input: { workflowId: number; ref: string; inputs: Record<string, InputValue> }) {
  const { wf, ws } = await loadWorkflow(input.workflowId);
  const def = await ensureDefinition(ws, wf, input.ref);
  const schema = def.inputSchema as InputSchema;
  const envInput = environmentInputName(schema);
  const environment = envInput ? String(input.inputs[envInput] ?? schema.properties[envInput]?.default ?? '') || null : null;
  const result = admit(
    {
      workspaceStatus: ws.status,
      workflow: {
        id: wf.id,
        ghState: wf.ghState,
        uiSchema: wf.uiSchema as UiSchema,
        allowedRefPatterns: wf.allowedRefPatterns,
        approvalRequired: wf.approvalRequired,
        approvalEnvironments: wf.approvalEnvironments,
        approvalMin: wf.approvalMin,
        concurrencyScope: wf.concurrencyScope,
        concurrencyPolicy: wf.concurrencyPolicy,
      },
      definition: { hasDispatch: def.hasDispatch, inputSchema: schema, runNameHasTag: def.runNameHasTag },
    },
    { ref: input.ref, inputs: input.inputs },
  );
  return { wf, ws, def, environment, result };
}

// ---------------------------------------------------------------- commands

export async function validateRun(ctx: Ctx, input: { workflowId: number; ref: string; inputs: Record<string, InputValue> }) {
  const { wf, ws, environment, result } = await prepare(ctx, input);
  const problems: Problem[] = [];
  try {
    await authorize(ctx.principal, 'run', ws.id, { environment, workflowExposed: wf.exposed });
  } catch (err) {
    if (err instanceof NotFound) throw err;
    problems.push({ code: 'not_allowed', message: environment ? `You can't run this in ${environment}` : "You can't run this workflow" });
  }
  if (!result.ok) problems.push(...result.problems);
  let slotBusy = false;
  if (result.ok && result.concurrencyKey) {
    const [busy] = await db()
      .select({ id: runRequests.id })
      .from(runRequests)
      .where(
        and(
          eq(runRequests.concurrencyKey, result.concurrencyKey),
          inArray(runRequests.phase, ['dispatching', 'verifying', 'dispatched', 'running', 'cancelling']),
        ),
      )
      .limit(1);
    slotBusy = Boolean(busy);
  }
  return {
    ok: problems.length === 0,
    problems,
    environment,
    approvalRequired: result.ok ? Boolean(result.approval) : false,
    slotBusy,
    concurrencyPolicy: result.ok ? result.concurrencyPolicy : null,
    weakDuplicateProtection: result.ok ? result.weakDuplicateProtection : false,
  };
}

export async function createRun(
  ctx: Ctx,
  input: { workflowId: number; ref: string; inputs: Record<string, InputValue>; idempotencyKey: string },
) {
  const [existing] = await db()
    .select()
    .from(runRequests)
    .where(and(eq(runRequests.requestedBy, ctx.principal.id), eq(runRequests.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (existing) {
    if (existing.workflowId === input.workflowId && existing.ref === input.ref) return existing;
    throw new Conflict('This idempotency key was already used for a different request', { reason: 'idempotency_key_reused' });
  }

  const { wf, ws, environment, result } = await prepare(ctx, input);
  await authorize(ctx.principal, 'run', ws.id, { environment, workflowExposed: wf.exposed });
  if (!result.ok) throw new AdmissionRejected(result.problems);

  try {
    return await unitOfWork({ actor: { kind: 'user', id: ctx.principal.id }, correlationId: ctx.correlationId }, async () => {
      const conditions = result.weakDuplicateProtection
        ? withCondition([], 'DuplicateProtectionWeak', 'True', 'run_name_without_tag', 'run-name does not include the correlation tag')
        : [];
      const [req] = await db()
        .insert(runRequests)
        .values({
          idempotencyKey: input.idempotencyKey,
          requestedBy: ctx.principal.id,
          workspaceId: ws.id,
          workflowId: wf.id,
          ref: input.ref,
          inputs: result.inputs,
          environment: result.environment,
          concurrencyKey: result.concurrencyKey,
          concurrencyPolicy: result.concurrencyPolicy,
          settingsSnapshot: result.settingsSnapshot,
          phase: result.approval ? 'awaiting_approval' : 'pending',
          conditions,
        })
        .returning();
      const row = req!;
      recordEvent({
        type: 'cp.run_request.created',
        subject: `run-requests/${row.id}`,
        aggregateType: 'run_request',
        aggregateId: row.id,
        aggregateVersion: row.resourceVersion,
        workspaceId: ws.id,
        workflowId: wf.id,
        data: {
          runRequestId: row.id,
          workflow: { id: wf.id, name: wf.displayName ?? wf.name },
          ref: row.ref,
          environment: row.environment,
          requestedBy: ctx.principal.id,
          initialPhase: row.phase,
        },
      });
      if (result.approval) {
        await db()
          .insert(approvalRequests)
          .values({
            runRequestId: row.id,
            workspaceId: ws.id,
            minApprovals: result.approval.min,
            expiresAt: sql`now() + ${wf.approvalTtl}::interval`,
          });
        recordEvent({
          type: 'cp.approval.requested',
          subject: `run-requests/${row.id}`,
          aggregateType: 'approval',
          aggregateId: row.id,
          workspaceId: ws.id,
          workflowId: wf.id,
          data: { runRequestId: row.id, minApprovals: result.approval.min },
        });
      } else {
        enqueueAfterCommit(Queues.dispatch, row.id, { priority: 10 });
      }
      return row;
    });
  } catch (err) {
    if (pgErrorCode(err) === '23505') {
      const [again] = await db()
        .select()
        .from(runRequests)
        .where(and(eq(runRequests.requestedBy, ctx.principal.id), eq(runRequests.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (again && sameRequest(again, input.workflowId, input.ref, again.inputs)) return again;
    }
    throw err;
  }
}

export async function cancelRun(ctx: Ctx, runRequestId: string) {
  const [req] = await db().select().from(runRequests).where(eq(runRequests.id, runRequestId)).limit(1);
  if (!req) throw new NotFound('Run request not found');
  await authorize(ctx.principal, 'cancel', req.workspaceId);
  if (isTerminal(req.phase)) throw new Conflict('This run has already finished', { reason: 'invalid_state' });

  await unitOfWork({ actor: { kind: 'user', id: ctx.principal.id }, correlationId: ctx.correlationId }, async () => {
    const [row] = await db()
      .update(runRequests)
      .set({ cancelRequested: true, cancelRequestedBy: ctx.principal.id, cancelRequestedAt: new Date() })
      .where(and(eq(runRequests.id, runRequestId), eq(runRequests.cancelRequested, false)))
      .returning();
    if (!row) return; // already requested
    if (row.phase === 'awaiting_approval') {
      await db()
        .update(approvalRequests)
        .set({ state: 'withdrawn', decidedAt: new Date() })
        .where(and(eq(approvalRequests.runRequestId, row.id), eq(approvalRequests.state, 'pending')));
    }
    recordEvent({
      type: 'cp.run_request.cancel_requested',
      subject: `run-requests/${row.id}`,
      aggregateType: 'run_request',
      aggregateId: row.id,
      aggregateVersion: row.resourceVersion,
      workspaceId: row.workspaceId,
      workflowId: row.workflowId,
      data: { runRequestId: row.id, requestedBy: ctx.principal.id, phaseAtRequest: row.phase },
    });
    enqueueAfterCommit(Queues.dispatch, row.id, { priority: 10 });
  });
}

export async function createRunAction(
  ctx: Ctx,
  input: { runId: number; attempt: number; action: 'cancel' | 'rerun_all' | 'rerun_failed' | 'rerun_job'; jobId?: number; idempotencyKey: string },
) {
  const [run] = await db()
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.runId, input.runId), eq(workflowRuns.runAttempt, input.attempt)))
    .limit(1);
  if (!run) throw new NotFound('Run not found');
  await authorize(ctx.principal, input.action === 'cancel' ? 'cancel' : 'rerun', run.workspaceId);
  if (input.action === 'cancel' && run.status === 'completed') throw new Conflict('This run has already finished', { reason: 'invalid_state' });
  if (input.action !== 'cancel' && run.status !== 'completed') throw new Conflict('Only finished runs can be re-run', { reason: 'invalid_state' });
  if (input.action === 'rerun_job' && !input.jobId) throw new Conflict('Choose a job to re-run', { reason: 'invalid_state' });

  const [existing] = await db()
    .select()
    .from(runActions)
    .where(and(eq(runActions.requestedBy, ctx.principal.id), eq(runActions.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (existing) return existing;

  return unitOfWork({ actor: { kind: 'user', id: ctx.principal.id }, correlationId: ctx.correlationId }, async () => {
    const [row] = await db()
      .insert(runActions)
      .values({
        idempotencyKey: input.idempotencyKey,
        requestedBy: ctx.principal.id,
        workspaceId: run.workspaceId,
        githubRunId: input.runId,
        runAttempt: input.attempt,
        action: input.action,
        jobId: input.action === 'rerun_job' ? input.jobId : null,
      })
      .returning();
    recordEvent({
      type: 'cp.run_action.created',
      subject: `run-actions/${row!.id}`,
      aggregateType: 'run_action',
      aggregateId: row!.id,
      workspaceId: run.workspaceId,
      workflowId: run.workflowId,
      data: { runActionId: row!.id, action: input.action, runId: input.runId, attempt: input.attempt, runRequestId: run.runRequestId },
    });
    enqueueAfterCommit(Queues.runAction, row!.id, { priority: 10 });
    return row!;
  });
}

export async function decideApproval(ctx: Ctx, input: { runRequestId: string; decision: 'approve' | 'deny'; comment?: string }) {
  const [row] = await db()
    .select({ approval: approvalRequests, req: runRequests })
    .from(approvalRequests)
    .innerJoin(runRequests, eq(runRequests.id, approvalRequests.runRequestId))
    .where(eq(approvalRequests.runRequestId, input.runRequestId))
    .limit(1);
  if (!row) throw new NotFound('Approval not found');
  await authorize(ctx.principal, 'approve', row.req.workspaceId, { isRequester: row.req.requestedBy === ctx.principal.id });
  if (row.approval.state !== 'pending') throw new Conflict(`This approval is already ${row.approval.state}`, { reason: 'invalid_state' });

  try {
    return await unitOfWork({ actor: { kind: 'user', id: ctx.principal.id }, correlationId: ctx.correlationId }, async () => {
      await db().insert(approvalDecisions).values({
        runRequestId: input.runRequestId,
        approverId: ctx.principal.id,
        decision: input.decision,
        comment: input.comment ?? null,
      });
      const base = {
        subject: `run-requests/${input.runRequestId}`,
        aggregateType: 'approval',
        aggregateId: input.runRequestId,
        workspaceId: row.req.workspaceId,
        workflowId: row.req.workflowId,
      };
      recordEvent({ ...base, type: 'cp.approval.decision_recorded', data: { runRequestId: input.runRequestId, approverId: ctx.principal.id, decision: input.decision, comment: input.comment ?? null } });

      const [{ approvals } = { approvals: 0 }] = await db()
        .select({ approvals: sql<number>`count(*)::int` })
        .from(approvalDecisions)
        .where(and(eq(approvalDecisions.runRequestId, input.runRequestId), eq(approvalDecisions.decision, 'approve')));
      const state = input.decision === 'deny' ? 'denied' : approvals >= row.approval.minApprovals ? 'approved' : 'pending';
      if (state !== 'pending') {
        await db().update(approvalRequests).set({ state, decidedAt: new Date() }).where(eq(approvalRequests.runRequestId, input.runRequestId));
        recordEvent({ ...base, type: state === 'approved' ? 'cp.approval.approved' : 'cp.approval.denied', data: { runRequestId: input.runRequestId } });
        enqueueAfterCommit(Queues.dispatch, input.runRequestId, { priority: 10 });
      }
      return { state, approvals, required: row.approval.minApprovals };
    });
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw new Conflict('You already voted on this request');
    if (/cannot approve their own/.test(pgMessage(err))) throw new Forbidden('You cannot approve your own request');
    throw err;
  }
}

// ---------------------------------------------------------------- queries

function encodePageCursor(createdAt: Date, id: string) {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}
function decodePageCursor(cursor: string | null | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return at && id ? { createdAt: new Date(at), id } : null;
}

export async function listRuns(
  { principal }: Ctx,
  input: { scope: 'mine' | 'all'; workspaceId?: string; workflowId?: number; active?: boolean; cursor?: string | null; limit: number },
) {
  const conds = [];
  if (input.scope === 'mine') conds.push(eq(runRequests.requestedBy, principal.id));
  if (input.workspaceId) {
    await authorize(principal, 'view', input.workspaceId);
    conds.push(eq(runRequests.workspaceId, input.workspaceId));
  } else if (input.scope === 'all') {
    const visible = [...(await visibleWorkspaceIds(principal))];
    if (visible.length === 0) return { items: [], nextCursor: null };
    conds.push(inArray(runRequests.workspaceId, visible));
  }
  if (input.workflowId) conds.push(eq(runRequests.workflowId, input.workflowId));
  if (input.active === true) conds.push(notInArray(runRequests.phase, TERMINAL));
  if (input.active === false) conds.push(inArray(runRequests.phase, TERMINAL));
  const cursor = decodePageCursor(input.cursor);
  if (cursor) {
    conds.push(or(lt(runRequests.createdAt, cursor.createdAt), and(eq(runRequests.createdAt, cursor.createdAt), lt(runRequests.id, cursor.id)))!);
  }

  const rows = await db()
    .select({
      req: runRequests,
      workflowName: sql<string>`coalesce(${workflows.displayName}, ${workflows.name})`,
      workspaceName: workspaces.displayName,
    })
    .from(runRequests)
    .innerJoin(workflows, eq(workflows.id, runRequests.workflowId))
    .innerJoin(workspaces, eq(workspaces.id, runRequests.workspaceId))
    .where(and(...conds))
    .orderBy(desc(runRequests.createdAt), desc(runRequests.id))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const names = await displayNames(page.map((r) => r.req.requestedBy));
  return {
    items: page.map((r) => toRunDto(r.req, r.workflowName, r.workspaceName, names.get(r.req.requestedBy)?.name ?? null)),
    nextCursor: rows.length > input.limit ? encodePageCursor(page.at(-1)!.req.createdAt, page.at(-1)!.req.id) : null,
  };
}

function toRunDto(req: RunRequestRow, workflowName: string, workspaceName: string, requesterName: string | null) {
  return {
    id: req.id,
    workspaceId: req.workspaceId,
    workspaceName,
    workflowId: req.workflowId,
    workflowName,
    ref: req.ref,
    environment: req.environment,
    inputs: req.inputs,
    phase: req.phase,
    phaseReason: req.phaseReason,
    phaseMessage: req.phaseMessage,
    conditions: req.conditions,
    githubRunId: req.githubRunId,
    cancelRequested: req.cancelRequested,
    requestedBy: req.requestedBy,
    requesterName,
    createdAt: req.createdAt,
    updatedAt: req.updatedAt,
    resourceVersion: req.resourceVersion,
  };
}

export async function getRun({ principal }: Ctx, runRequestId: string) {
  const [row] = await db()
    .select({
      req: runRequests,
      workflowName: sql<string>`coalesce(${workflows.displayName}, ${workflows.name})`,
      workspaceName: workspaces.displayName,
      fullName: workspaces.fullName,
    })
    .from(runRequests)
    .innerJoin(workflows, eq(workflows.id, runRequests.workflowId))
    .innerJoin(workspaces, eq(workspaces.id, runRequests.workspaceId))
    .where(eq(runRequests.id, runRequestId))
    .limit(1);
  if (!row) throw new NotFound('Run request not found');
  const caps = await authorize(principal, 'view', row.req.workspaceId);

  const [approval] = await db().select().from(approvalRequests).where(eq(approvalRequests.runRequestId, runRequestId)).limit(1);
  const decisions = approval
    ? await db().select().from(approvalDecisions).where(eq(approvalDecisions.runRequestId, runRequestId))
    : [];
  const githubRun = row.req.githubRunId
    ? (
        await db()
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.runId, row.req.githubRunId))
          .orderBy(desc(workflowRuns.runAttempt))
          .limit(1)
      )[0] ?? null
    : null;
  const names = await displayNames([row.req.requestedBy, ...decisions.map((d) => d.approverId)]);
  const isRequester = row.req.requestedBy === principal.id;

  return {
    ...toRunDto(row.req, row.workflowName, row.workspaceName, names.get(row.req.requestedBy)?.name ?? null),
    repository: row.fullName,
    approval: approval
      ? {
          state: approval.state,
          minApprovals: approval.minApprovals,
          expiresAt: approval.expiresAt,
          decisions: decisions.map((d) => ({ ...d, approverName: names.get(d.approverId)?.name ?? null })),
        }
      : null,
    githubRun: githubRun && {
      runId: githubRun.runId,
      attempt: githubRun.runAttempt,
      status: githubRun.status,
      conclusion: githubRun.conclusion,
      htmlUrl: githubRun.htmlUrl,
      lastSeenAt: githubRun.lastSeenAt,
      lastSeenVia: githubRun.lastSeenVia,
    },
    can: {
      cancel: caps.role === 'operator' && !isTerminal(row.req.phase) && !row.req.cancelRequested,
      approve: caps.canApprove && !isRequester && approval?.state === 'pending',
      rerun: caps.role === 'operator' && githubRun?.status === 'completed',
    },
  };
}

export async function runTimeline({ principal }: Ctx, runRequestId: string) {
  const [req] = await db().select().from(runRequests).where(eq(runRequests.id, runRequestId)).limit(1);
  if (!req) throw new NotFound('Run request not found');
  await authorize(principal, 'view', req.workspaceId);
  const res = await db().execute<{ id: string; type: string; occurred_at: Date; actor_kind: string; actor_id: string | null; data: Record<string, unknown> }>(sql`
    select id, type, occurred_at, actor_kind, actor_id, data from cp.events
     where (aggregate_type in ('run_request', 'approval') and aggregate_id = ${runRequestId})
        or data->>'runRequestId' = ${runRequestId}
     order by occurred_at, seq
     limit 300`);
  const names = await displayNames(res.rows.filter((r) => r.actor_kind === 'user' && r.actor_id).map((r) => r.actor_id!));
  return res.rows.map((r) => ({
    id: r.id,
    type: r.type,
    time: new Date(r.occurred_at).toISOString(),
    actor: r.actor_kind === 'user' ? (names.get(r.actor_id!)?.name ?? 'Someone') : r.actor_kind === 'github' ? 'GitHub' : 'System',
    data: r.data,
  }));
}

export async function listGithubRuns({ principal }: Ctx, input: { workspaceId: string; cursor?: string | null; limit: number }) {
  await authorize(principal, 'view', input.workspaceId);
  const rows = await db()
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workspaceId, input.workspaceId))
    .orderBy(desc(workflowRuns.ghCreatedAt))
    .limit(input.limit);
  return rows;
}

export async function githubRunJobs({ principal }: Ctx, input: { runId: number; attempt: number }) {
  const [run] = await db()
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.runId, input.runId), eq(workflowRuns.runAttempt, input.attempt)))
    .limit(1);
  if (!run) throw new NotFound('Run not found');
  await authorize(principal, 'view', run.workspaceId);
  const jobs = await db()
    .select()
    .from(workflowJobs)
    .where(and(eq(workflowJobs.runId, input.runId), eq(workflowJobs.runAttempt, input.attempt)))
    .orderBy(workflowJobs.startedAt, workflowJobs.id);
  return { run, jobs };
}

export async function approvalInbox({ principal }: Ctx, input: { mode: 'waiting' | 'all' }) {
  const visible = [...(await visibleWorkspaceIds(principal))];
  if (visible.length === 0) return [];
  const caps = await capabilitiesFor(principal, visible);
  const approverIn = visible.filter((id) => caps.get(id)?.canApprove);
  const scope = input.mode === 'waiting' ? approverIn : visible;
  if (scope.length === 0) return [];
  const rows = await db()
    .select({
      approval: approvalRequests,
      req: runRequests,
      workflowName: sql<string>`coalesce(${workflows.displayName}, ${workflows.name})`,
      workspaceName: workspaces.displayName,
    })
    .from(approvalRequests)
    .innerJoin(runRequests, eq(runRequests.id, approvalRequests.runRequestId))
    .innerJoin(workflows, eq(workflows.id, runRequests.workflowId))
    .innerJoin(workspaces, eq(workspaces.id, runRequests.workspaceId))
    .where(
      and(
        inArray(approvalRequests.workspaceId, scope),
        input.mode === 'waiting' ? eq(approvalRequests.state, 'pending') : sql`true`,
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(100);
  const votes = rows.length
    ? await db()
        .select()
        .from(approvalDecisions)
        .where(inArray(approvalDecisions.runRequestId, rows.map((r) => r.req.id)))
    : [];
  const names = await displayNames([...rows.map((r) => r.req.requestedBy), ...votes.map((v) => v.approverId)]);
  return rows
    .filter((r) => input.mode === 'all' || (r.req.requestedBy !== principal.id && !votes.some((v) => v.runRequestId === r.req.id && v.approverId === principal.id)))
    .map((r) => ({
      runRequestId: r.req.id,
      state: r.approval.state,
      minApprovals: r.approval.minApprovals,
      expiresAt: r.approval.expiresAt,
      workflowName: r.workflowName,
      workspaceName: r.workspaceName,
      environment: r.req.environment,
      ref: r.req.ref,
      inputs: r.req.inputs,
      requester: names.get(r.req.requestedBy)?.name ?? null,
      isMine: r.req.requestedBy === principal.id,
      canDecide: caps.get(r.req.workspaceId)?.canApprove === true && r.req.requestedBy !== principal.id && r.approval.state === 'pending',
      votes: votes
        .filter((v) => v.runRequestId === r.req.id)
        .map((v) => ({ decision: v.decision, approver: names.get(v.approverId)?.name ?? null, comment: v.comment })),
    }));
}
