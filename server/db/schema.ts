// Drizzle mirror of drizzle/reference-schema.sql (the SQL migration is authoritative).
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  integer,
  interval,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const ghId = (name: string) => bigint(name, { mode: 'number' });
const version = () => bigint('resource_version', { mode: 'number' }).notNull().default(1);
const xid8 = customType<{ data: string }>({ dataType: () => 'xid8' });
/** Generated column expression (read-only for Drizzle; the database computes it). */
const sqlStatusRank = sql`cp.github_status_rank(status, conclusion)`;

export const authSchema = pgSchema('auth');
export const cp = pgSchema('cp');

export const PHASE_ENUM = [
  'pending', 'awaiting_approval', 'waiting_for_slot', 'dispatching', 'verifying', 'dispatched',
  'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'rejected', 'lost',
] as const;

// ---------------------------------------------------------------- auth (Better Auth)
export const users = authSchema.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  isActive: boolean('is_active').notNull().default(true),
  entraObjectId: text('entra_object_id'),
  githubUserId: ghId('github_user_id'),
  githubLogin: text('github_login'),
  githubAvatarUrl: text('github_avatar_url'),
  githubIdentitySource: text('github_identity_source', { enum: ['saml', 'self_declared', 'admin'] }),
  githubSyncedAt: tz('github_synced_at'),
  lastLoginAt: tz('last_login_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const sessions = authSchema.table('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  token: text('token').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: tz('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const accounts = authSchema.table('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
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
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const verifications = authSchema.table('verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: tz('expires_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------- identity
export const directoryGroups = cp.table('directory_groups', {
  id: text('id').primaryKey(),
  displayName: text('display_name'),
  lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
});

export const userGroups = cp.table(
  'user_groups',
  {
    userId: uuid('user_id').notNull(),
    groupId: text('group_id').notNull(),
    syncedAt: tz('synced_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId] })],
);

// ---------------------------------------------------------------- GitHub credential pool
export const githubCredentials = cp.table('github_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  kind: text('kind', { enum: ['fine_grained_pat', 'classic_pat', 'github_app'] }).notNull(),
  secretRef: text('secret_ref').notNull(),
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
  createdBy: uuid('created_by').notNull(),
  resourceVersion: version(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

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
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rateBucket, t.resource] })],
);

export const githubHttpCache = cp.table('github_http_cache', {
  cacheKey: text('cache_key').primaryKey(),
  etag: text('etag').notNull(),
  body: jsonb('body').notNull(),
  fetchedAt: tz('fetched_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------- workspaces
export const workspaces = cp.table('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
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
  importedBy: uuid('imported_by').notNull(),
  importedAt: tz('imported_at').notNull().defaultNow(),
  lastSyncedAt: tz('last_synced_at'),
  runsListedUntil: tz('runs_listed_until'),
  resourceVersion: version(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const workspaceGrants = cp.table('workspace_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  subjectType: text('subject_type', { enum: ['user', 'group'] }).notNull(),
  subjectId: text('subject_id').notNull(),
  role: text('role', { enum: ['viewer', 'operator'] }).notNull(),
  canApprove: boolean('can_approve').notNull().default(false),
  environments: text('environments').array(),
  grantedBy: uuid('granted_by').notNull(),
  grantedAt: tz('granted_at').notNull().defaultNow(),
  expiresAt: tz('expires_at'),
});

export const workspaceCredentials = cp.table(
  'workspace_credentials',
  {
    workspaceId: uuid('workspace_id').notNull(),
    credentialId: uuid('credential_id').notNull(),
    canDispatch: boolean('can_dispatch').notNull(),
    validatedAt: tz('validated_at').notNull().defaultNow(),
    lastError: text('last_error'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.credentialId] })],
);

export const workflows = cp.table('workflows', {
  id: ghId('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  ghState: text('gh_state').notNull(),
  exposed: boolean('exposed').notNull().default(false),
  displayName: text('display_name'),
  description: text('description'),
  category: text('category'),
  icon: text('icon'),
  uiSchema: jsonb('ui_schema').$type<Record<string, Record<string, unknown>>>().notNull().default({}),
  allowedRefPatterns: text('allowed_ref_patterns').array(),
  approvalRequired: boolean('approval_required').notNull().default(false),
  approvalEnvironments: text('approval_environments').array(),
  approvalMin: smallint('approval_min').notNull().default(1),
  approvalTtl: interval('approval_ttl').notNull().default('24 hours'),
  concurrencyScope: text('concurrency_scope', { enum: ['none', 'workflow', 'workflow_environment'] })
    .notNull()
    .default('none'),
  concurrencyPolicy: text('concurrency_policy', { enum: ['allow', 'forbid', 'queue'] }).notNull().default('allow'),
  resourceVersion: version(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const workflowDefinitions = cp.table(
  'workflow_definitions',
  {
    workflowId: ghId('workflow_id').notNull(),
    ref: text('ref').notNull(),
    commitSha: text('commit_sha').notNull(),
    hasDispatch: boolean('has_dispatch').notNull(),
    inputSchema: jsonb('input_schema').notNull(),
    runNameHasTag: boolean('run_name_has_tag').notNull(),
    parseProblems: text('parse_problems').array().notNull().default([]),
    fetchedAt: tz('fetched_at').notNull().defaultNow(),
    resourceVersion: version(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.ref] })],
);

// ---------------------------------------------------------------- runs
export interface Condition {
  type: string;
  status: 'True' | 'False';
  reason?: string;
  message?: string;
  since: string;
}

export const runRequests = cp.table('run_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  correlationTag: text('correlation_tag').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestedBy: uuid('requested_by').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  workflowId: ghId('workflow_id').notNull(),
  ref: text('ref').notNull(),
  inputs: jsonb('inputs').$type<Record<string, string | number | boolean>>().notNull().default({}),
  environment: text('environment'),
  concurrencyKey: text('concurrency_key'),
  concurrencyPolicy: text('concurrency_policy', { enum: ['allow', 'forbid', 'queue'] }).notNull().default('allow'),
  settingsSnapshot: jsonb('settings_snapshot').$type<Record<string, unknown>>().notNull().default({}),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  cancelRequestedBy: uuid('cancel_requested_by'),
  cancelRequestedAt: tz('cancel_requested_at'),
  phase: text('phase', { enum: PHASE_ENUM }).notNull().default('pending'),
  phaseReason: text('phase_reason'),
  phaseMessage: text('phase_message'),
  conditions: jsonb('conditions').$type<Condition[]>().notNull().default([]),
  githubRunId: ghId('github_run_id'),
  dispatchedWith: uuid('dispatched_with'),
  dispatchAttempts: smallint('dispatch_attempts').notNull().default(0),
  dispatchSentAt: tz('dispatch_sent_at'),
  verifyUntil: tz('verify_until'),
  resourceVersion: version(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const runActions = cp.table('run_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestedBy: uuid('requested_by').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  githubRunId: ghId('github_run_id').notNull(),
  runAttempt: integer('run_attempt').notNull(),
  action: text('action', { enum: ['cancel', 'rerun_all', 'rerun_failed', 'rerun_job'] }).notNull(),
  jobId: ghId('job_id'),
  phase: text('phase', { enum: ['pending', 'sending', 'done', 'failed', 'rejected'] }).notNull().default('pending'),
  phaseReason: text('phase_reason'),
  resultAttempt: integer('result_attempt'),
  resourceVersion: version(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const approvalRequests = cp.table('approval_requests', {
  runRequestId: uuid('run_request_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  minApprovals: smallint('min_approvals').notNull(),
  state: text('state', { enum: ['pending', 'approved', 'denied', 'expired', 'withdrawn'] }).notNull().default('pending'),
  expiresAt: tz('expires_at').notNull(),
  decidedAt: tz('decided_at'),
  resourceVersion: version(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const approvalDecisions = cp.table(
  'approval_decisions',
  {
    runRequestId: uuid('run_request_id').notNull(),
    approverId: uuid('approver_id').notNull(),
    decision: text('decision', { enum: ['approve', 'deny'] }).notNull(),
    comment: text('comment'),
    decidedAt: tz('decided_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runRequestId, t.approverId] })],
);

// ---------------------------------------------------------------- mirror
export const workflowRuns = cp.table(
  'workflow_runs',
  {
    runId: ghId('run_id').notNull(),
    runAttempt: integer('run_attempt').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: ghId('workflow_id').notNull(),
    runRequestId: uuid('run_request_id'),
    event: text('event'),
    displayTitle: text('display_title'),
    headBranch: text('head_branch'),
    headSha: text('head_sha'),
    actorLogin: text('actor_login'),
    triggeringActorLogin: text('triggering_actor_login'),
    htmlUrl: text('html_url'),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    statusRank: smallint('status_rank').generatedAlwaysAs(sqlStatusRank),
    ghCreatedAt: tz('gh_created_at').notNull(),
    ghUpdatedAt: tz('gh_updated_at').notNull(),
    runStartedAt: tz('run_started_at'),
    completedAt: tz('completed_at'),
    lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
    lastSeenVia: text('last_seen_via', { enum: ['webhook', 'poll'] }).notNull(),
    etag: text('etag'),
    resourceVersion: version(),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.runAttempt] })],
);

export interface JobStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export const workflowJobs = cp.table('workflow_jobs', {
  id: ghId('id').primaryKey(),
  runId: ghId('run_id').notNull(),
  runAttempt: integer('run_attempt').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  conclusion: text('conclusion'),
  statusRank: smallint('status_rank').generatedAlwaysAs(sqlStatusRank),
  runnerName: text('runner_name'),
  labels: text('labels').array().notNull().default([]),
  steps: jsonb('steps').$type<JobStep[]>().notNull().default([]),
  htmlUrl: text('html_url'),
  startedAt: tz('started_at'),
  completedAt: tz('completed_at'),
  lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
  lastSeenVia: text('last_seen_via', { enum: ['webhook', 'poll'] }).notNull(),
  resourceVersion: version(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------- events + plumbing
export const events = cp.table('events', {
  seq: bigint('seq', { mode: 'number' }),
  txid: xid8('txid'),
  id: uuid('id').notNull().defaultRandom(),
  type: text('type').notNull(),
  version: smallint('version').notNull(),
  occurredAt: tz('occurred_at').notNull().defaultNow(),
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
});

export const webhookDeliveries = cp.table('webhook_deliveries', {
  deliveryGuid: uuid('delivery_guid').notNull(),
  receivedAt: tz('received_at').notNull().defaultNow(),
  eventType: text('event_type').notNull(),
  action: text('action'),
  githubRepoId: ghId('github_repo_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  processStatus: text('process_status', { enum: ['pending', 'applied', 'ignored', 'failed', 'dead'] })
    .notNull()
    .default('pending'),
  attempts: integer('attempts').notNull().default(0),
  processedAt: tz('processed_at'),
  lastError: text('last_error'),
});

export type RunRequestRow = typeof runRequests.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type DefinitionRow = typeof workflowDefinitions.$inferSelect;
export type CredentialRow = typeof githubCredentials.$inferSelect;
export type GrantRow = typeof workspaceGrants.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowJobRow = typeof workflowJobs.$inferSelect;
export type EventRow = typeof events.$inferSelect;
