import { z } from 'zod';

const idempotencyKey = z.string().min(8).max(100);
const inputValue = z.union([z.string().max(10_000), z.number(), z.boolean()]);

export const repoFullName = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Use the form owner/repository');

export const runCreateInput = z.object({
  workflowId: z.number().int().positive(),
  ref: z.string().min(1).max(255),
  inputs: z.record(z.string(), inputValue).default({}),
  idempotencyKey,
});
export type RunCreateInput = z.infer<typeof runCreateInput>;

export const runValidateInput = runCreateInput.omit({ idempotencyKey: true });

export const runListInput = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  workspaceId: z.uuid().optional(),
  workflowId: z.number().int().optional(),
  active: z.boolean().optional(),
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(100).default(30),
});

export const runActionInput = z.object({
  runId: z.number().int().positive(),
  attempt: z.number().int().positive(),
  action: z.enum(['cancel', 'rerun_all', 'rerun_failed', 'rerun_job']),
  jobId: z.number().int().positive().optional(),
  idempotencyKey,
});

export const approvalDecideInput = z.object({
  runRequestId: z.uuid(),
  decision: z.enum(['approve', 'deny']),
  comment: z.string().max(1000).optional(),
});

export const workspaceImportInput = z.object({
  fullName: repoFullName,
  credentialIds: z.array(z.uuid()).min(1),
  displayName: z.string().min(1).max(100).optional(),
  visibility: z.enum(['private', 'public']).default('private'),
  publicRole: z.enum(['viewer', 'operator']).optional(),
});

export const workspaceUpdateInput = z.object({
  workspaceId: z.uuid(),
  expectedVersion: z.number().int(),
  displayName: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  visibility: z.enum(['private', 'public']).optional(),
  publicRole: z.enum(['viewer', 'operator']).nullable().optional(),
});

export const grantAddInput = z.object({
  workspaceId: z.uuid(),
  subjectType: z.enum(['user', 'group']),
  /** user: email address; group: Entra group object id */
  subject: z.string().min(1).max(200),
  groupDisplayName: z.string().max(200).optional(),
  role: z.enum(['viewer', 'operator']),
  canApprove: z.boolean().default(false),
  environments: z.array(z.string().min(1)).nullable().default(null),
  expiresAt: z.coerce.date().nullable().default(null),
});

export const workflowUpdateInput = z.object({
  workflowId: z.number().int(),
  expectedVersion: z.number().int(),
  exposed: z.boolean().optional(),
  displayName: z.string().max(100).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  category: z.string().max(50).nullable().optional(),
  uiSchema: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  allowedRefPatterns: z.array(z.string().min(1)).nullable().optional(),
  approvalRequired: z.boolean().optional(),
  approvalEnvironments: z.array(z.string().min(1)).nullable().optional(),
  approvalMin: z.number().int().min(1).max(5).optional(),
  concurrencyScope: z.enum(['none', 'workflow', 'workflow_environment']).optional(),
  concurrencyPolicy: z.enum(['allow', 'forbid', 'queue']).optional(),
});

export const credentialAddInput = z
  .object({
    label: z.string().min(1).max(100),
    kind: z.enum(['fine_grained_pat', 'classic_pat', 'github_app']),
    /** The token / App private key, OR a reference "env:NAME" (local development). */
    secret: z.string().min(1),
    appId: z.number().int().optional(),
    installationId: z.number().int().optional(),
    priority: z.number().int().min(1).max(1000).default(100),
  })
  .refine((v) => v.kind !== 'github_app' || (v.appId && v.installationId), {
    message: 'GitHub Apps need appId and installationId',
  });

export const setGithubUsernameInput = z.object({
  username: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'Not a valid GitHub username'),
});

export const cursorPage = z.object({ cursor: z.string().nullish(), limit: z.number().int().min(1).max(100).default(30) });
