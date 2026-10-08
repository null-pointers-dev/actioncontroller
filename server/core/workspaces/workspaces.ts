import 'server-only';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { refAllowed } from '@/shared/glob';
import { environmentInputName, type InputSchema } from '@/shared/input-schema';
import { db, enqueueAfterCommit, pgErrorCode, recordEvent, unitOfWork } from '@/server/db/uow';
import {
  directoryGroups,
  githubCredentials,
  workflowDefinitions,
  workflows,
  workspaceCredentials,
  workspaceGrants,
  workspaces,
  type DefinitionRow,
  type WorkflowRow,
  type WorkspaceRow,
} from '@/server/db/schema';
import {
  getCommitSha,
  getFileAtRef,
  getRepo,
  listEnvironments,
  listRefs,
  type RepoInfo,
} from '@/server/github/api';
import { loadCredential } from '@/server/github/pool';
import { authorize, capabilitiesFor, requireAdmin, visibleWorkspaceIds } from '../access/access';
import type { Capabilities, Principal } from '../access/policy';
import { Conflict, NotFound, ValidationError } from '../errors';
import { displayNames, findUserIdByEmail } from '../identity/identity';
import { Queues } from '../platform/queue';
import { parseWorkflowFile } from './definition-parser';

type Ctx = { principal: Principal; correlationId?: string };
const actorOf = (p: Principal) => ({ kind: 'user' as const, id: p.id });

// ---------------------------------------------------------------- listing

export async function listWorkspaces({ principal }: Ctx) {
  const ids = [...(await visibleWorkspaceIds(principal))];
  if (ids.length === 0) return [];
  const rows = await db().select().from(workspaces).where(inArray(workspaces.id, ids)).orderBy(workspaces.displayName);
  const caps = await capabilitiesFor(principal, ids);
  const counts = await db()
    .select({ workspaceId: workflows.workspaceId, n: sql<number>`count(*)::int` })
    .from(workflows)
    .where(and(inArray(workflows.workspaceId, ids), eq(workflows.exposed, true), ne(workflows.ghState, 'deleted')))
    .groupBy(workflows.workspaceId);
  const countMap = new Map(counts.map((c) => [c.workspaceId, c.n]));
  return rows
    .filter((w) => principal.role === 'admin' || w.status !== 'archived')
    .map((w) => toWorkspaceDto(w, caps.get(w.id), countMap.get(w.id) ?? 0));
}

export async function getWorkspace({ principal }: Ctx, workspaceId: string) {
  const caps = await authorize(principal, 'view', workspaceId);
  const [w] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!w) throw new NotFound('Workspace not found');
  return toWorkspaceDto(w, caps, null);
}

function toWorkspaceDto(w: WorkspaceRow, caps: Capabilities | undefined, exposedWorkflows: number | null) {
  return {
    id: w.id,
    displayName: w.displayName,
    description: w.description,
    fullName: w.fullName,
    defaultBranch: w.defaultBranch,
    visibility: w.visibility,
    publicRole: w.publicRole,
    status: w.status,
    statusReason: w.statusReason,
    updateMode: w.updateMode,
    lastSyncedAt: w.lastSyncedAt,
    resourceVersion: w.resourceVersion,
    exposedWorkflows,
    capabilities: caps ?? null,
  };
}

// ---------------------------------------------------------------- import (admins)

export interface RepositoryLookup {
  repo: RepoInfo | null;
  access: { credentialId: string; label: string; ok: boolean; canDispatchHint: boolean; error?: string }[];
  alreadyImported: boolean;
}

/** Which pool credentials can reach a repository (used by the import dialog). */
export async function lookupRepository({ principal }: Ctx, fullName: string): Promise<RepositoryLookup> {
  requireAdmin(principal);
  const creds = await db().select().from(githubCredentials).where(eq(githubCredentials.status, 'active'));
  const results = await Promise.allSettled(creds.map((c) => getRepo(fullName, { credential: c })));
  let repo: RepoInfo | null = null;
  const access = results.map((r, i) => {
    const c = creds[i]!;
    if (r.status === 'fulfilled') {
      repo ??= r.value;
      return { credentialId: c.id, label: c.label, ok: true, canDispatchHint: r.value.canPush };
    }
    return { credentialId: c.id, label: c.label, ok: false, canDispatchHint: false, error: (r.reason as Error).message };
  });
  const [existing] = await db().select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.fullName, fullName)).limit(1);
  return { repo, access, alreadyImported: Boolean(existing) };
}

export async function importRepository(
  ctx: Ctx,
  input: { fullName: string; credentialIds: string[]; displayName?: string; visibility: 'private' | 'public'; publicRole?: 'viewer' | 'operator' },
) {
  requireAdmin(ctx.principal);
  if (input.visibility === 'public' && !input.publicRole) {
    throw new ValidationError([{ field: 'publicRole', code: 'required', message: 'Choose what everyone may do in a public workspace' }]);
  }
  const checks = await Promise.allSettled(
    input.credentialIds.map(async (id) => ({ id, repo: await getRepo(input.fullName, { credential: await loadCredential(id) }) })),
  );
  const ok = checks.flatMap((c) => (c.status === 'fulfilled' ? [c.value] : []));
  const first = ok[0];
  if (!first) {
    throw new ValidationError([{ field: 'credentialIds', code: 'no_access', message: 'None of the chosen credentials can access this repository' }]);
  }
  const repo = first.repo;

  try {
    return await unitOfWork({ actor: actorOf(ctx.principal), correlationId: ctx.correlationId }, async () => {
      const [ws] = await db()
        .insert(workspaces)
        .values({
          githubRepoId: repo.id,
          ownerLogin: repo.ownerLogin,
          repoName: repo.name,
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          displayName: input.displayName ?? repo.name,
          visibility: input.visibility,
          publicRole: input.visibility === 'public' ? (input.publicRole ?? 'viewer') : null,
          status: 'importing',
          importedBy: ctx.principal.id,
        })
        .returning();
      await db()
        .insert(workspaceCredentials)
        .values(ok.map((o) => ({ workspaceId: ws!.id, credentialId: o.id, canDispatch: o.repo.canPush })));
      recordEvent({
        type: 'cp.workspace.imported',
        subject: `workspaces/${ws!.id}`,
        aggregateType: 'workspace',
        aggregateId: ws!.id,
        aggregateVersion: ws!.resourceVersion,
        workspaceId: ws!.id,
        data: { fullName: repo.fullName, visibility: ws!.visibility },
      });
      enqueueAfterCommit(Queues.sync, ws!.id, { priority: 20 });
      return ws!;
    });
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw new Conflict('This repository is already imported');
    throw err;
  }
}

export async function updateWorkspace(
  ctx: Ctx,
  input: {
    workspaceId: string;
    expectedVersion: number;
    displayName?: string;
    description?: string | null;
    visibility?: 'private' | 'public';
    publicRole?: 'viewer' | 'operator' | null;
  },
) {
  requireAdmin(ctx.principal);
  const patch: Partial<WorkspaceRow> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.description !== undefined) patch.description = input.description;
  if (input.visibility !== undefined) {
    patch.visibility = input.visibility;
    patch.publicRole = input.visibility === 'public' ? (input.publicRole ?? 'viewer') : null;
  } else if (input.publicRole !== undefined) {
    patch.publicRole = input.publicRole;
  }
  return unitOfWork({ actor: actorOf(ctx.principal), correlationId: ctx.correlationId }, async () => {
    const [ws] = await db()
      .update(workspaces)
      .set(patch)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.resourceVersion, input.expectedVersion)))
      .returning();
    if (!ws) throw new Conflict('The workspace changed since you loaded it; reload and try again');
    recordEvent({
      type: 'cp.workspace.updated',
      subject: `workspaces/${ws.id}`,
      aggregateType: 'workspace',
      aggregateId: ws.id,
      aggregateVersion: ws.resourceVersion,
      workspaceId: ws.id,
      data: { visibility: ws.visibility, publicRole: ws.publicRole, displayName: ws.displayName },
    });
    return ws;
  });
}

export async function requestSync(ctx: Ctx, workspaceId: string) {
  requireAdmin(ctx.principal);
  await unitOfWork({ actor: actorOf(ctx.principal), correlationId: ctx.correlationId }, async () => {
    enqueueAfterCommit(Queues.sync, workspaceId, { priority: 20 });
  });
}

export async function archiveWorkspace(ctx: Ctx, workspaceId: string) {
  requireAdmin(ctx.principal);
  await unitOfWork({ actor: actorOf(ctx.principal), correlationId: ctx.correlationId }, async () => {
    const [ws] = await db().update(workspaces).set({ status: 'archived' }).where(eq(workspaces.id, workspaceId)).returning();
    if (!ws) throw new NotFound('Workspace not found');
    recordEvent({
      type: 'cp.workspace.archived',
      subject: `workspaces/${ws.id}`,
      aggregateType: 'workspace',
      aggregateId: ws.id,
      aggregateVersion: ws.resourceVersion,
      workspaceId: ws.id,
      data: {},
    });
  });
}

// ---------------------------------------------------------------- grants (admins)

export async function listGrants({ principal }: Ctx, workspaceId: string) {
  requireAdmin(principal);
  const grants = await db().select().from(workspaceGrants).where(eq(workspaceGrants.workspaceId, workspaceId));
  const names = await displayNames(grants.filter((g) => g.subjectType === 'user').map((g) => g.subjectId));
  const groupIds = grants.filter((g) => g.subjectType === 'group').map((g) => g.subjectId);
  const groups = groupIds.length
    ? await db().select().from(directoryGroups).where(inArray(directoryGroups.id, groupIds))
    : [];
  const groupNames = new Map(groups.map((g) => [g.id, g.displayName]));
  return grants.map((g) => ({
    ...g,
    subjectName: g.subjectType === 'user' ? (names.get(g.subjectId)?.name ?? g.subjectId) : (groupNames.get(g.subjectId) ?? g.subjectId),
  }));
}

export async function addGrant(
  ctx: Ctx,
  input: {
    workspaceId: string;
    subjectType: 'user' | 'group';
    subject: string;
    groupDisplayName?: string;
    role: 'viewer' | 'operator';
    canApprove: boolean;
    environments: string[] | null;
    expiresAt: Date | null;
  },
) {
  requireAdmin(ctx.principal);
  const subjectId = input.subjectType === 'user' ? await findUserIdByEmail(input.subject) : input.subject;
  return unitOfWork({ actor: actorOf(ctx.principal), correlationId: ctx.correlationId }, async () => {
    if (input.subjectType === 'group') {
      await db()
        .insert(directoryGroups)
        .values({ id: subjectId, displayName: input.groupDisplayName ?? null })
        .onConflictDoUpdate({ target: directoryGroups.id, set: { displayName: input.groupDisplayName ?? sql`${directoryGroups.displayName}` } });
    }
    const [grant] = await db()
      .insert(workspaceGrants)
      .values({
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        subjectId,
        role: input.role,
        canApprove: input.canApprove,
        environments: input.environments,
        expiresAt: input.expiresAt,
        grantedBy: ctx.principal.id,
      })
      .onConflictDoUpdate({
        target: [workspaceGrants.workspaceId, workspaceGrants.subjectType, workspaceGrants.subjectId],
        set: { role: input.role, canApprove: input.canApprove, environments: input.environments, expiresAt: input.expiresAt },
      })
      .returning();
    recordEvent({
      type: 'cp.workspace.grant_added',
      subject: `workspaces/${input.workspaceId}`,
      aggregateType: 'workspace',
      aggregateId: input.workspaceId,
      workspaceId: input.workspaceId,
      data: { subjectType: input.subjectType, subjectId, role: input.role, canApprove: input.canApprove, environments: input.environments },
    });
    return grant!;
  });
}

export async function removeGrant(ctx: Ctx, grantId: string) {
  requireAdmin(ctx.principal);
  await unitOfWork({ actor: actorOf(ctx.principal), correlationId: ctx.correlationId }, async () => {
    const [grant] = await db().delete(workspaceGrants).where(eq(workspaceGrants.id, grantId)).returning();
    if (!grant) throw new NotFound('Grant not found');
    recordEvent({
      type: 'cp.workspace.grant_removed',
      subject: `workspaces/${grant.workspaceId}`,
      aggregateType: 'workspace',
      aggregateId: grant.workspaceId,
      workspaceId: grant.workspaceId,
      data: { subjectType: grant.subjectType, subjectId: grant.subjectId },
    });
  });
}

// ---------------------------------------------------------------- workflows

async function loadWorkflow(workflowId: number): Promise<{ wf: WorkflowRow; ws: WorkspaceRow }> {
  const [row] = await db()
    .select({ wf: workflows, ws: workspaces })
    .from(workflows)
    .innerJoin(workspaces, eq(workspaces.id, workflows.workspaceId))
    .where(eq(workflows.id, workflowId))
    .limit(1);
  if (!row) throw new NotFound('Workflow not found');
  return row;
}

export { loadWorkflow };

export async function listWorkflows({ principal }: Ctx, workspaceId: string) {
  const caps = await authorize(principal, 'view', workspaceId);
  const rows = await db()
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        ne(workflows.ghState, 'deleted'),
        caps.isAdmin ? sql`true` : eq(workflows.exposed, true),
      ),
    )
    .orderBy(workflows.category, workflows.displayName, workflows.name);
  const last = await db().execute<{ workflow_id: string; phase: string; created_at: Date; inputs: Record<string, unknown> }>(sql`
    select distinct on (workflow_id) workflow_id::text, phase, created_at, inputs
      from cp.run_requests where workspace_id = ${workspaceId}
     order by workflow_id, created_at desc`);
  const lastMap = new Map(last.rows.map((r) => [Number(r.workflow_id), r]));
  return rows.map((wf) => ({
    ...toWorkflowDto(wf),
    lastRun: lastMap.has(wf.id)
      ? { phase: lastMap.get(wf.id)!.phase, createdAt: lastMap.get(wf.id)!.created_at }
      : null,
    capabilities: caps,
  }));
}

function toWorkflowDto(wf: WorkflowRow) {
  return {
    id: wf.id,
    workspaceId: wf.workspaceId,
    name: wf.name,
    path: wf.path,
    ghState: wf.ghState,
    exposed: wf.exposed,
    displayName: wf.displayName ?? wf.name,
    description: wf.description,
    category: wf.category,
    icon: wf.icon,
    uiSchema: wf.uiSchema,
    allowedRefPatterns: wf.allowedRefPatterns,
    approvalRequired: wf.approvalRequired,
    approvalEnvironments: wf.approvalEnvironments,
    approvalMin: wf.approvalMin,
    concurrencyScope: wf.concurrencyScope,
    concurrencyPolicy: wf.concurrencyPolicy,
    resourceVersion: wf.resourceVersion,
  };
}

export async function getWorkflow({ principal }: Ctx, workflowId: number) {
  const { wf, ws } = await loadWorkflow(workflowId);
  const caps = await authorize(principal, 'view', ws.id, { workflowExposed: wf.exposed });
  return { ...toWorkflowDto(wf), workspace: { id: ws.id, displayName: ws.displayName, fullName: ws.fullName, defaultBranch: ws.defaultBranch }, capabilities: caps };
}

const DEFINITION_TTL_MS = 10 * 60_000;

/** Definition for a ref; fetched from GitHub when missing or stale (stored by web or worker). */
export async function ensureDefinition(ws: WorkspaceRow, wf: WorkflowRow, ref: string, force = false): Promise<DefinitionRow> {
  const [existing] = await db()
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.workflowId, wf.id), eq(workflowDefinitions.ref, ref)))
    .limit(1);
  if (existing && !force && Date.now() - existing.fetchedAt.getTime() < DEFINITION_TTL_MS) return existing;

  const sha = await getCommitSha(ws.id, ws.fullName, ref);
  if (existing && existing.commitSha === sha) {
    await db().update(workflowDefinitions).set({ fetchedAt: new Date() }).where(and(eq(workflowDefinitions.workflowId, wf.id), eq(workflowDefinitions.ref, ref)));
    return { ...existing, fetchedAt: new Date() };
  }
  const parsed = parseWorkflowFile(await getFileAtRef(ws.id, ws.fullName, wf.path, sha));
  return unitOfWork({ actor: { kind: 'system', id: 'definitions' } }, async () => {
    const values = {
      workflowId: wf.id,
      ref,
      commitSha: sha,
      hasDispatch: parsed.hasDispatch,
      inputSchema: parsed.inputSchema,
      runNameHasTag: parsed.runNameHasTag,
      parseProblems: parsed.problems,
      fetchedAt: new Date(),
    };
    const [row] = await db()
      .insert(workflowDefinitions)
      .values(values)
      .onConflictDoUpdate({ target: [workflowDefinitions.workflowId, workflowDefinitions.ref], set: values })
      .returning();
    recordEvent({
      type: 'cp.workflow.definition_changed',
      subject: `workflows/${wf.id}`,
      aggregateType: 'workflow',
      aggregateId: String(wf.id),
      workspaceId: ws.id,
      workflowId: wf.id,
      data: { ref, commitSha: sha, inputs: Object.keys(parsed.inputSchema.properties), problems: parsed.problems },
    });
    return row!;
  });
}

/** Everything the run form needs, for the caller (docs/04 `workflows.definition`). */
export async function getDefinitionForForm({ principal }: Ctx, workflowId: number, ref?: string) {
  const { wf, ws } = await loadWorkflow(workflowId);
  const caps = await authorize(principal, 'view', ws.id, { workflowExposed: wf.exposed });
  const theRef = ref ?? ws.defaultBranch;
  const def = await ensureDefinition(ws, wf, theRef);
  const schema = structuredClone(def.inputSchema as InputSchema);

  const envInput = environmentInputName(schema);
  let environments: string[] = [];
  if (envInput) {
    const field = schema.properties[envInput]!;
    environments = field.enum ?? (await listEnvironments(ws.id, ws.fullName));
    if (!field.enum && environments.length) field.enum = environments;
  }
  const runnableEnvironments =
    caps.runEnvironments === 'any' ? environments : environments.filter((e) => (caps.runEnvironments as string[]).includes(e));
  const approvalFor = (env: string | null) =>
    wf.approvalRequired && (!wf.approvalEnvironments?.length || (env !== null && wf.approvalEnvironments.includes(env)));

  return {
    ref: theRef,
    commitSha: def.commitSha,
    hasDispatch: def.hasDispatch,
    inputSchema: schema,
    uiSchema: wf.uiSchema,
    runNameHasTag: def.runNameHasTag,
    parseProblems: def.parseProblems,
    environmentInput: envInput,
    environments,
    runnableEnvironments,
    canRun: caps.role === 'operator' && (caps.runEnvironments === 'any' || runnableEnvironments.length > 0 || !envInput),
    allowedRefPatterns: wf.allowedRefPatterns,
    approval: {
      required: wf.approvalRequired,
      environments: wf.approvalEnvironments,
      min: wf.approvalMin,
      byEnvironment: Object.fromEntries((environments.length ? environments : ['']).map((e) => [e, approvalFor(e || null)])),
    },
    concurrency: { scope: wf.concurrencyScope, policy: wf.concurrencyPolicy },
  };
}

export async function searchRefs({ principal }: Ctx, workflowId: number, q: string) {
  const { wf, ws } = await loadWorkflow(workflowId);
  await authorize(principal, 'view', ws.id, { workflowExposed: wf.exposed });
  const { branches, tags } = await listRefs(ws.id, ws.fullName);
  const needle = q.toLowerCase();
  const filter = (names: string[]) =>
    names.filter((n) => refAllowed(n, wf.allowedRefPatterns) && (!needle || n.toLowerCase().includes(needle))).slice(0, 30);
  return { branches: filter(branches), tags: filter(tags), defaultBranch: ws.defaultBranch };
}

export async function updateWorkflow(
  ctx: Ctx,
  input: {
    workflowId: number;
    expectedVersion: number;
    exposed?: boolean;
    displayName?: string | null;
    description?: string | null;
    category?: string | null;
    uiSchema?: Record<string, Record<string, unknown>>;
    allowedRefPatterns?: string[] | null;
    approvalRequired?: boolean;
    approvalEnvironments?: string[] | null;
    approvalMin?: number;
    concurrencyScope?: 'none' | 'workflow' | 'workflow_environment';
    concurrencyPolicy?: 'allow' | 'forbid' | 'queue';
  },
) {
  requireAdmin(ctx.principal);
  const { workflowId, expectedVersion, ...patch } = input;
  if (patch.concurrencyScope === 'none') patch.concurrencyPolicy = 'allow';
  if (patch.concurrencyScope && patch.concurrencyScope !== 'none' && (!patch.concurrencyPolicy || patch.concurrencyPolicy === 'allow')) {
    patch.concurrencyPolicy = 'forbid';
  }
  return unitOfWork({ actor: actorOf(ctx.principal), correlationId: ctx.correlationId }, async () => {
    const [wf] = await db()
      .update(workflows)
      .set(patch)
      .where(and(eq(workflows.id, workflowId), eq(workflows.resourceVersion, expectedVersion)))
      .returning();
    if (!wf) throw new Conflict('The workflow changed since you loaded it; reload and try again');
    recordEvent({
      type: 'cp.workflow.updated',
      subject: `workflows/${wf.id}`,
      aggregateType: 'workflow',
      aggregateId: String(wf.id),
      aggregateVersion: wf.resourceVersion,
      workspaceId: wf.workspaceId,
      workflowId: wf.id,
      data: { changed: Object.keys(patch) },
    });
    return toWorkflowDto(wf);
  });
}

// ---------------------------------------------------------------- workspace credentials (admins)

export async function listWorkspaceCredentials({ principal }: Ctx, workspaceId: string) {
  requireAdmin(principal);
  return db()
    .select({
      credentialId: workspaceCredentials.credentialId,
      label: githubCredentials.label,
      status: githubCredentials.status,
      canDispatch: workspaceCredentials.canDispatch,
      validatedAt: workspaceCredentials.validatedAt,
      lastError: workspaceCredentials.lastError,
    })
    .from(workspaceCredentials)
    .innerJoin(githubCredentials, eq(githubCredentials.id, workspaceCredentials.credentialId))
    .where(eq(workspaceCredentials.workspaceId, workspaceId))
    .orderBy(desc(workspaceCredentials.canDispatch), githubCredentials.label);
}

export async function attachCredential(ctx: Ctx, workspaceId: string, credentialId: string) {
  requireAdmin(ctx.principal);
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) throw new NotFound('Workspace not found');
  const repo = await getRepo(ws.fullName, { credential: await loadCredential(credentialId) });
  await db()
    .insert(workspaceCredentials)
    .values({ workspaceId, credentialId, canDispatch: repo.canPush })
    .onConflictDoUpdate({
      target: [workspaceCredentials.workspaceId, workspaceCredentials.credentialId],
      set: { canDispatch: repo.canPush, validatedAt: new Date(), lastError: null },
    });
}

export async function detachCredential(ctx: Ctx, workspaceId: string, credentialId: string) {
  requireAdmin(ctx.principal);
  await db()
    .delete(workspaceCredentials)
    .where(and(eq(workspaceCredentials.workspaceId, workspaceId), eq(workspaceCredentials.credentialId, credentialId)));
}
