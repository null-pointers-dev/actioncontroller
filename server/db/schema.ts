// The database schema — single source of truth for tables, columns, constraints and indexes.
// Applied by drizzle-kit (push in development, generated migrations in production).
// Functions, triggers, roles and grants live in drizzle/guards.sql and are applied right
// after every push/migrate by server/db/setup.ts (drizzle-kit can't express them).
import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  interval,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------- helpers

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const now = (name: string) => tz(name).notNull().defaultNow();
const ghId = (name: string) => bigint(name, { mode: 'number' });
const pk = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const version = () => bigint('resource_version', { mode: 'number' }).notNull().default(1);
const textArray = (name: string) => text(name).array();
const xid8 = customType<{ data: string }>({ dataType: () => 'xid8' });

/** CHECK (col IN ('a','b')) — literals are inlined so the DDL has no parameters. */
function oneOf(name: string, column: AnyPgColumn, values: readonly string[]) {
  return check(name, sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`);
}

/** GitHub status rank, computed by the database (mirrors shared/phases.ts githubStatusRank). */
const statusRank: SQL = sql.raw(`CASE
  WHEN status = 'requested' THEN 1
  WHEN status IN ('queued', 'pending') THEN 2
  WHEN status IN ('waiting', 'in_progress') THEN 3
  WHEN status = 'completed' AND conclusion = 'action_required' THEN 3
  WHEN status = 'completed' THEN 5
  ELSE 0 END`);

export const PHASE_ENUM = [
  'pending', 'awaiting_approval', 'waiting_for_slot', 'dispatching', 'verifying', 'dispatched',
  'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'rejected', 'lost',
] as const;
const ACTIVE_SLOT_PHASES = `'dispatching', 'verifying', 'dispatched', 'running', 'cancelling'`;
const OPEN_PHASES = `'pending', 'awaiting_approval', 'waiting_for_slot', 'dispatching', 'verifying', 'dispatched', 'running', 'cancelling'`;
const GH_STATUSES = ['requested', 'queued', 'pending', 'waiting', 'in_progress', 'completed'] as const;

export const authSchema = pgSchema('auth');
export const cp = pgSchema('cp');

// ================================================================ auth (Better Auth)

export const users = authSchema.table(
  'users',
  {
    id: pk(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
    isActive: boolean('is_active').notNull().default(true),
    entraObjectId: text('entra_object_id').unique(),
    githubUserId: ghId('github_user_id').unique(),
    githubLogin: text('github_login'),
    githubAvatarUrl: text('github_avatar_url'),
    githubIdentitySource: text('github_identity_source', { enum: ['saml', 'self_declared', 'admin'] }),
    githubSyncedAt: tz('github_synced_at'),
    lastLoginAt: tz('last_login_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    oneOf('users_role_check', t.role, ['user', 'admin']),
    oneOf('users_github_source_check', t.githubIdentitySource, ['saml', 'self_declared', 'admin']),
    check('users_github_pair_check', sql`(${t.githubUserId} is null) = (${t.githubLogin} is null)`),
  ],
);

export const sessions = authSchema.table(
  'sessions',
  {
    id: pk(),
    token: text('token').notNull().unique(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: tz('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const accounts = authSchema.table(
  'accounts',
  {
    id: pk(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tz('access_token_expires_at'),
    refreshTokenExpiresAt: tz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [uniqueIndex('accounts_provider_account_uidx').on(t.providerId, t.accountId), index('accounts_user_idx').on(t.userId)],
);

export const verifications = authSchema.table('verifications', {
  id: pk(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: tz('expires_at').notNull(),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

// ================================================================ identity

export const directoryGroups = cp.table('directory_groups', {
  id: text('id').primaryKey(), // Entra group object id
  displayName: text('display_name'),
  lastSeenAt: now('last_seen_at'),
});

export const userGroups = cp.table(
  'user_groups',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    groupId: text('group_id').notNull().references(() => directoryGroups.id, { onDelete: 'cascade' }),
    syncedAt: now('synced_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId] }), index('user_groups_group_idx').on(t.groupId)],
);

// ================================================================ GitHub credential pool

export const githubCredentials = cp.table(
  'github_credentials',
  {
    id: pk(),
    label: text('label').notNull().unique(),
    kind: text('kind', { enum: ['fine_grained_pat', 'classic_pat', 'github_app'] }).notNull(),
    secretRef: text('secret_ref').notNull(), // Key Vault secret name or "env:NAME" — never the secret
    githubAccountId: ghId('github_account_id'),
    githubAccountLogin: text('github_account_login'),
    appId: ghId('app_id'),
    installationId: ghId('installation_id'),
    rateBucket: text('rate_bucket').notNull(),
    status: text('status', { enum: ['active', 'disabled', 'expired', 'invalid'] }).notNull().default('active'),
    priority: smallint('priority').notNull().default(100),
    expiresAt: tz('expires_at'),
    lastUsedAt: tz('last_used_at'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    resourceVersion: version(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    oneOf('github_credentials_kind_check', t.kind, ['fine_grained_pat', 'classic_pat', 'github_app']),
    oneOf('github_credentials_status_check', t.status, ['active', 'disabled', 'expired', 'invalid']),
    check('github_credentials_app_ids_check', sql`(${t.kind} = 'github_app') = (${t.installationId} is not null and ${t.appId} is not null)`),
    check('github_credentials_account_check', sql`${t.kind} = 'github_app' or ${t.githubAccountId} is not null`),
    // GitHub limits per ACCOUNT (PATs) or per INSTALLATION (Apps): the bucket must match the owner.
    check(
      'github_credentials_bucket_check',
      sql`${t.rateBucket} = case when ${t.kind} = 'github_app' then 'installation:' || ${t.installationId} else 'user:' || ${t.githubAccountId} end`,
    ),
    index('github_credentials_active_idx').on(t.rateBucket).where(sql`status = 'active'`),
  ],
);

export const githubRateBuckets = cp.table(
  'github_rate_buckets',
  {
    rateBucket: text('rate_bucket').notNull(),
    resource: text('resource').notNull().default('core'),
    limitTotal: integer('limit_total'),
    remaining: integer('remaining'),
    resetsAt: tz('resets_at'),
    blockedUntil: tz('blocked_until'),
    breakerState: text('breaker_state', { enum: ['closed', 'open', 'half_open'] }).notNull().default('closed'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    updatedAt: now('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.rateBucket, t.resource] }),
    oneOf('github_rate_buckets_breaker_check', t.breakerState, ['closed', 'open', 'half_open']),
  ],
);

export const githubHttpCache = cp.table('github_http_cache', {
  cacheKey: text('cache_key').primaryKey(),
  etag: text('etag').notNull(),
  body: jsonb('body').notNull(),
  fetchedAt: now('fetched_at'),
});

// ================================================================ workspaces

export const workspaces = cp.table(
  'workspaces',
  {
    id: pk(),
    githubRepoId: ghId('github_repo_id').notNull().unique(),
    ownerLogin: text('owner_login').notNull(),
    repoName: text('repo_name').notNull(),
    fullName: text('full_name').notNull().unique(),
    defaultBranch: text('default_branch').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    visibility: text('visibility', { enum: ['private', 'public'] }).notNull().default('private'),
    publicRole: text('public_role', { enum: ['viewer', 'operator'] }),
    status: text('status', { enum: ['importing', 'active', 'error', 'archived'] }).notNull().default('importing'),
    statusReason: text('status_reason'),
    updateMode: text('update_mode', { enum: ['webhook', 'polling'] }).notNull().default('polling'),
    githubHookId: ghId('github_hook_id'),
    importedBy: uuid('imported_by').notNull().references(() => users.id),
    importedAt: now('imported_at'),
    lastSyncedAt: tz('last_synced_at'),
    runsListedUntil: tz('runs_listed_until'),
    resourceVersion: version(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    oneOf('workspaces_visibility_check', t.visibility, ['private', 'public']),
    oneOf('workspaces_public_role_check', t.publicRole, ['viewer', 'operator']),
    oneOf('workspaces_status_check', t.status, ['importing', 'active', 'error', 'archived']),
    oneOf('workspaces_update_mode_check', t.updateMode, ['webhook', 'polling']),
    check('workspaces_public_role_required_check', sql`(${t.visibility} = 'public') = (${t.publicRole} is not null)`),
    check('workspaces_hook_check', sql`(${t.updateMode} = 'webhook') = (${t.githubHookId} is not null)`),
  ],
);

export const workspaceGrants = cp.table(
  'workspace_grants',
  {
    id: pk(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type', { enum: ['user', 'group'] }).notNull(),
    subjectId: text('subject_id').notNull(), // users.id or Entra group object id
    role: text('role', { enum: ['viewer', 'operator'] }).notNull(),
    canApprove: boolean('can_approve').notNull().default(false),
    environments: textArray('environments'), // null = any
    grantedBy: uuid('granted_by').notNull().references(() => users.id),
    grantedAt: now('granted_at'),
    expiresAt: tz('expires_at'),
  },
  (t) => [
    uniqueIndex('workspace_grants_subject_uidx').on(t.workspaceId, t.subjectType, t.subjectId),
    index('workspace_grants_subject_idx').on(t.subjectType, t.subjectId),
    oneOf('workspace_grants_subject_type_check', t.subjectType, ['user', 'group']),
    oneOf('workspace_grants_role_check', t.role, ['viewer', 'operator']),
  ],
);

export const workspaceCredentials = cp.table(
  'workspace_credentials',
  {
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id').notNull().references(() => githubCredentials.id, { onDelete: 'cascade' }),
    canDispatch: boolean('can_dispatch').notNull(),
    validatedAt: now('validated_at'),
    lastError: text('last_error'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.credentialId] }), index('workspace_credentials_cred_idx').on(t.credentialId)],
);

export const workflows = cp.table(
  'workflows',
  {
    id: ghId('id').primaryKey(), // GitHub workflow id
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    // discovered (worker)
    path: text('path').notNull(),
    name: text('name').notNull(),
    ghState: text('gh_state').notNull(),
    // curation (admins)
    exposed: boolean('exposed').notNull().default(false),
    displayName: text('display_name'),
    description: text('description'),
    category: text('category'),
    icon: text('icon'),
    uiSchema: jsonb('ui_schema').$type<Record<string, Record<string, unknown>>>().notNull().default({}),
    // run settings
    allowedRefPatterns: textArray('allowed_ref_patterns'),
    approvalRequired: boolean('approval_required').notNull().default(false),
    approvalEnvironments: textArray('approval_environments'),
    approvalMin: smallint('approval_min').notNull().default(1),
    approvalTtl: interval('approval_ttl').notNull().default('24 hours'),
    concurrencyScope: text('concurrency_scope', { enum: ['none', 'workflow', 'workflow_environment'] }).notNull().default('none'),
    concurrencyPolicy: text('concurrency_policy', { enum: ['allow', 'forbid', 'queue'] }).notNull().default('allow'),
    resourceVersion: version(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    uniqueIndex('workflows_workspace_path_uidx').on(t.workspaceId, t.path),
    index('workflows_exposed_idx').on(t.workspaceId).where(sql`exposed`),
    check('workflows_approval_min_check', sql`${t.approvalMin} between 1 and 5`),
    oneOf('workflows_concurrency_scope_check', t.concurrencyScope, ['none', 'workflow', 'workflow_environment']),
    oneOf('workflows_concurrency_policy_check', t.concurrencyPolicy, ['allow', 'forbid', 'queue']),
    check('workflows_concurrency_pair_check', sql`(${t.concurrencyScope} = 'none') = (${t.concurrencyPolicy} = 'allow')`),
  ],
);

export const workflowDefinitions = cp.table(
  'workflow_definitions',
  {
    workflowId: ghId('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    commitSha: text('commit_sha').notNull(),
    hasDispatch: boolean('has_dispatch').notNull(),
    inputSchema: jsonb('input_schema').notNull().default({ type: 'object', properties: {}, required: [] }),
    runNameHasTag: boolean('run_name_has_tag').notNull(),
    parseProblems: textArray('parse_problems').notNull().default(sql`'{}'::text[]`),
    fetchedAt: now('fetched_at'),
    resourceVersion: version(),
    updatedAt: now('updated_at'),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.ref] })],
);

// ================================================================ runs

export interface Condition {
  type: string;
  status: 'True' | 'False';
  reason?: string;
  message?: string;
  since: string;
}

export const runRequests = cp.table(
  'run_requests',
  {
    id: pk(),
    correlationTag: text('correlation_tag')
      .notNull()
      .unique()
      .default(sql`'cp-' || substr(md5(gen_random_uuid()::text), 1, 12)`),
    idempotencyKey: text('idempotency_key').notNull(),
    // WANTED — frozen after insert (trigger in guards.sql)
    requestedBy: uuid('requested_by').notNull().references(() => users.id),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    workflowId: ghId('workflow_id').notNull().references(() => workflows.id),
    ref: text('ref').notNull(),
    inputs: jsonb('inputs').$type<Record<string, string | number | boolean>>().notNull().default({}),
    environment: text('environment'),
    concurrencyKey: text('concurrency_key'),
    concurrencyPolicy: text('concurrency_policy', { enum: ['allow', 'forbid', 'queue'] }).notNull().default('allow'),
    settingsSnapshot: jsonb('settings_snapshot').$type<Record<string, unknown>>().notNull().default({}),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    cancelRequestedBy: uuid('cancel_requested_by').references(() => users.id),
    cancelRequestedAt: tz('cancel_requested_at'),
    // PROGRESS — worker
    phase: text('phase', { enum: PHASE_ENUM }).notNull().default('pending'),
    phaseReason: text('phase_reason'),
    phaseMessage: text('phase_message'),
    conditions: jsonb('conditions').$type<Condition[]>().notNull().default([]),
    githubRunId: ghId('github_run_id'),
    dispatchedWith: uuid('dispatched_with').references(() => githubCredentials.id),
    dispatchAttempts: smallint('dispatch_attempts').notNull().default(0),
    dispatchSentAt: tz('dispatch_sent_at'),
    verifyUntil: tz('verify_until'),
    resourceVersion: version(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    uniqueIndex('run_requests_idempotency_uidx').on(t.requestedBy, t.idempotencyKey),
    uniqueIndex('run_requests_github_run_uidx').on(t.githubRunId).where(sql`github_run_id is not null`),
    index('run_requests_open_idx').on(t.phase, t.updatedAt).where(sql.raw(`phase in (${OPEN_PHASES})`)),
    index('run_requests_by_requester_idx').on(t.requestedBy, t.createdAt.desc()),
    index('run_requests_by_workspace_idx').on(t.workspaceId, t.createdAt.desc()),
    // At most ONE active run per concurrency key (forbid / queue): the database arbitrates races.
    uniqueIndex('run_requests_one_active_per_slot')
      .on(t.concurrencyKey)
      .where(sql.raw(`concurrency_policy in ('forbid', 'queue') and phase in (${ACTIVE_SLOT_PHASES})`)),
    oneOf('run_requests_phase_check', t.phase, PHASE_ENUM),
    oneOf('run_requests_concurrency_policy_check', t.concurrencyPolicy, ['allow', 'forbid', 'queue']),
    check('run_requests_concurrency_key_check', sql`${t.concurrencyPolicy} = 'allow' or ${t.concurrencyKey} is not null`),
  ],
);

export const runActions = cp.table(
  'run_actions',
  {
    id: pk(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedBy: uuid('requested_by').notNull().references(() => users.id),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    githubRunId: ghId('github_run_id').notNull(),
    runAttempt: integer('run_attempt').notNull(),
    action: text('action', { enum: ['cancel', 'rerun_all', 'rerun_failed', 'rerun_job'] }).notNull(),
    jobId: ghId('job_id'),
    phase: text('phase', { enum: ['pending', 'sending', 'done', 'failed', 'rejected'] }).notNull().default('pending'),
    phaseReason: text('phase_reason'),
    resultAttempt: integer('result_attempt'),
    resourceVersion: version(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    uniqueIndex('run_actions_idempotency_uidx').on(t.requestedBy, t.idempotencyKey),
    index('run_actions_open_idx').on(t.phase, t.updatedAt).where(sql`phase in ('pending', 'sending')`),
    oneOf('run_actions_action_check', t.action, ['cancel', 'rerun_all', 'rerun_failed', 'rerun_job']),
    oneOf('run_actions_phase_check', t.phase, ['pending', 'sending', 'done', 'failed', 'rejected']),
    check('run_actions_job_check', sql`(${t.action} = 'rerun_job') = (${t.jobId} is not null)`),
  ],
);

export const approvalRequests = cp.table(
  'approval_requests',
  {
    runRequestId: uuid('run_request_id').primaryKey().references(() => runRequests.id),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    minApprovals: smallint('min_approvals').notNull(),
    state: text('state', { enum: ['pending', 'approved', 'denied', 'expired', 'withdrawn'] }).notNull().default('pending'),
    expiresAt: tz('expires_at').notNull(),
    decidedAt: tz('decided_at'),
    resourceVersion: version(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    index('approval_requests_pending_idx').on(t.workspaceId, t.expiresAt).where(sql`state = 'pending'`),
    oneOf('approval_requests_state_check', t.state, ['pending', 'approved', 'denied', 'expired', 'withdrawn']),
  ],
);

export const approvalDecisions = cp.table(
  'approval_decisions',
  {
    runRequestId: uuid('run_request_id').notNull().references(() => approvalRequests.runRequestId),
    approverId: uuid('approver_id').notNull().references(() => users.id),
    decision: text('decision', { enum: ['approve', 'deny'] }).notNull(),
    comment: text('comment'),
    decidedAt: now('decided_at'),
  },
  (t) => [primaryKey({ columns: [t.runRequestId, t.approverId] }), oneOf('approval_decisions_decision_check', t.decision, ['approve', 'deny'])],
);

// ================================================================ mirror (what GitHub reports)

export const workflowRuns = cp.table(
  'workflow_runs',
  {
    runId: ghId('run_id').notNull(),
    runAttempt: integer('run_attempt').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: ghId('workflow_id').notNull(),
    runRequestId: uuid('run_request_id').references(() => runRequests.id),
    event: text('event'),
    displayTitle: text('display_title'),
    headBranch: text('head_branch'),
    headSha: text('head_sha'),
    actorLogin: text('actor_login'),
    triggeringActorLogin: text('triggering_actor_login'),
    htmlUrl: text('html_url'),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    statusRank: smallint('status_rank').generatedAlwaysAs(statusRank),
    ghCreatedAt: tz('gh_created_at').notNull(),
    ghUpdatedAt: tz('gh_updated_at').notNull(),
    runStartedAt: tz('run_started_at'),
    completedAt: tz('completed_at'),
    lastSeenAt: now('last_seen_at'),
    lastSeenVia: text('last_seen_via', { enum: ['webhook', 'poll'] }).notNull(),
    etag: text('etag'),
    resourceVersion: version(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.runAttempt] }),
    index('workflow_runs_by_workspace_idx').on(t.workspaceId, t.ghCreatedAt.desc()),
    index('workflow_runs_by_workflow_idx').on(t.workflowId, t.ghCreatedAt.desc()),
    index('workflow_runs_by_request_idx').on(t.runRequestId).where(sql`run_request_id is not null`),
    index('workflow_runs_unfinished_idx').on(t.lastSeenAt).where(sql`status <> 'completed'`),
    oneOf('workflow_runs_status_check', t.status, GH_STATUSES),
    oneOf('workflow_runs_seen_via_check', t.lastSeenVia, ['webhook', 'poll']),
  ],
);

export interface JobStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export const workflowJobs = cp.table(
  'workflow_jobs',
  {
    id: ghId('id').primaryKey(),
    runId: ghId('run_id').notNull(),
    runAttempt: integer('run_attempt').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    statusRank: smallint('status_rank').generatedAlwaysAs(statusRank),
    runnerName: text('runner_name'),
    labels: textArray('labels').notNull().default(sql`'{}'::text[]`),
    steps: jsonb('steps').$type<JobStep[]>().notNull().default([]),
    htmlUrl: text('html_url'),
    startedAt: tz('started_at'),
    completedAt: tz('completed_at'),
    lastSeenAt: now('last_seen_at'),
    lastSeenVia: text('last_seen_via', { enum: ['webhook', 'poll'] }).notNull(),
    resourceVersion: version(),
    updatedAt: now('updated_at'),
  },
  (t) => [
    index('workflow_jobs_by_run_idx').on(t.runId, t.runAttempt),
    oneOf('workflow_jobs_status_check', t.status, GH_STATUSES),
    oneOf('workflow_jobs_seen_via_check', t.lastSeenVia, ['webhook', 'poll']),
  ],
);

// ================================================================ events (outbox = live stream = audit)

export const events = cp.table(
  'events',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    txid: xid8('txid').notNull().default(sql`pg_current_xact_id()`),
    id: uuid('id').notNull().unique().default(sql`uuidv7()`),
    type: text('type').notNull(),
    version: smallint('version').notNull(),
    occurredAt: now('occurred_at'),
    subject: text('subject').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    aggregateVersion: bigint('aggregate_version', { mode: 'number' }),
    actorKind: text('actor_kind', { enum: ['user', 'system', 'github'] }).notNull(),
    actorId: text('actor_id'),
    workspaceId: uuid('workspace_id'),
    workflowId: ghId('workflow_id'),
    correlationId: text('correlation_id'),
    causationId: uuid('causation_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('events_feed_idx').on(t.txid, t.seq),
    index('events_aggregate_idx').on(t.aggregateType, t.aggregateId, t.seq),
    index('events_workspace_idx').on(t.workspaceId, t.occurredAt),
    index('events_occurred_idx').on(t.occurredAt),
    oneOf('events_actor_kind_check', t.actorKind, ['user', 'system', 'github']),
  ],
);

// ================================================================ webhook inbox (raw deliveries, replayable)

export const webhookDeliveries = cp.table(
  'webhook_deliveries',
  {
    deliveryGuid: uuid('delivery_guid').primaryKey(), // X-GitHub-Delivery — the PK is the dedupe
    receivedAt: now('received_at'),
    eventType: text('event_type').notNull(),
    action: text('action'),
    githubRepoId: ghId('github_repo_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processStatus: text('process_status', { enum: ['pending', 'applied', 'ignored', 'failed', 'dead'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    processedAt: tz('processed_at'),
    lastError: text('last_error'),
  },
  (t) => [
    index('webhook_deliveries_todo_idx').on(t.receivedAt).where(sql`process_status in ('pending', 'failed')`),
    index('webhook_deliveries_received_idx').on(t.receivedAt),
    oneOf('webhook_deliveries_status_check', t.processStatus, ['pending', 'applied', 'ignored', 'failed', 'dead']),
  ],
);

export type RunRequestRow = typeof runRequests.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type DefinitionRow = typeof workflowDefinitions.$inferSelect;
export type CredentialRow = typeof githubCredentials.$inferSelect;
export type GrantRow = typeof workspaceGrants.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowJobRow = typeof workflowJobs.$inferSelect;
export type EventRow = typeof events.$inferSelect;
