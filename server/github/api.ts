import 'server-only';
import { GitHubError, ghGraphql, ghRaw, ghRequest } from './client';
import { toJobSnapshot, toRunSnapshot, type JobSnapshot, type RunSnapshot } from './mappers';
import { getEnv } from '../env';
import { credentialToken, type PickedCredential } from './pool';

export { GitHubError } from './client';
export type { RunSnapshot, JobSnapshot } from './mappers';

const enc = (fullName: string) => fullName.split('/').map(encodeURIComponent).join('/');
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------- repositories & workflows

export interface RepoInfo {
  id: number;
  name: string;
  fullName: string;
  ownerLogin: string;
  defaultBranch: string;
  archived: boolean;
  /** Permissions of the credential's account (a hint for dispatch capability). */
  canPush: boolean;
}

export async function getRepo(fullName: string, opts: { workspaceId?: string; credential?: PickedCredential }): Promise<RepoInfo> {
  const res = await ghRequest<Record<string, any>>({ // eslint-disable-line @typescript-eslint/no-explicit-any
    workspaceId: opts.workspaceId ?? null,
    purpose: 'sync',
    path: `/repos/${enc(fullName)}`,
    credential: opts.credential,
  });
  const r = res.data;
  return {
    id: Number(r.id),
    name: String(r.name),
    fullName: String(r.full_name),
    ownerLogin: String(r.owner?.login),
    defaultBranch: String(r.default_branch),
    archived: Boolean(r.archived),
    canPush: Boolean(r.permissions?.push || r.permissions?.maintain || r.permissions?.admin),
  };
}

/** Rename-proof lookup by GitHub's numeric repository id. */
export async function getRepoById(repoId: number, workspaceId: string): Promise<RepoInfo> {
  const res = await ghRequest<Record<string, any>>({ // eslint-disable-line @typescript-eslint/no-explicit-any
    workspaceId,
    purpose: 'sync',
    path: `/repositories/${repoId}`,
  });
  const r = res.data;
  return {
    id: Number(r.id),
    name: String(r.name),
    fullName: String(r.full_name),
    ownerLogin: String(r.owner?.login),
    defaultBranch: String(r.default_branch),
    archived: Boolean(r.archived),
    canPush: Boolean(r.permissions?.push || r.permissions?.maintain || r.permissions?.admin),
  };
}

export interface WorkflowInfo {
  id: number;
  name: string;
  path: string;
  state: string;
}

export async function listWorkflows(workspaceId: string, fullName: string): Promise<WorkflowInfo[]> {
  const res = await ghRequest<{ workflows: { id: number; name: string; path: string; state: string }[] }>({
    workspaceId,
    purpose: 'sync',
    path: `/repos/${enc(fullName)}/actions/workflows?per_page=100`,
  });
  return res.data.workflows.map((w) => ({ id: Number(w.id), name: w.name, path: w.path, state: w.state }));
}

export async function getCommitSha(workspaceId: string, fullName: string, ref: string): Promise<string> {
  const res = await ghRequest<string>({
    workspaceId,
    purpose: 'sync',
    path: `/repos/${enc(fullName)}/commits/${encodeURIComponent(ref)}`,
    accept: 'application/vnd.github.sha',
  });
  return String(res.data).trim();
}

export async function getFileAtRef(workspaceId: string, fullName: string, path: string, ref: string): Promise<string> {
  const res = await ghRequest<{ content?: string; encoding?: string }>({
    workspaceId,
    purpose: 'sync',
    path: `/repos/${enc(fullName)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
  });
  if (!res.data.content) throw new GitHubError(`File ${path} has no content`, 404, 'not_found', res.credentialId);
  return Buffer.from(res.data.content, 'base64').toString('utf8');
}

export async function listRefs(workspaceId: string, fullName: string): Promise<{ branches: string[]; tags: string[] }> {
  const [branches, tags] = await Promise.all([
    ghRequest<{ name: string }[]>({
      workspaceId,
      purpose: 'status',
      path: `/repos/${enc(fullName)}/branches?per_page=100`,
      cacheKey: `branches:${fullName}`,
    }),
    ghRequest<{ name: string }[]>({
      workspaceId,
      purpose: 'status',
      path: `/repos/${enc(fullName)}/tags?per_page=100`,
      cacheKey: `tags:${fullName}`,
    }),
  ]);
  return { branches: branches.data.map((b) => b.name), tags: tags.data.map((t) => t.name) };
}

export async function listEnvironments(workspaceId: string, fullName: string): Promise<string[]> {
  try {
    const res = await ghRequest<{ environments?: { name: string }[] }>({
      workspaceId,
      purpose: 'sync',
      path: `/repos/${enc(fullName)}/environments?per_page=100`,
      cacheKey: `environments:${fullName}`,
    });
    return (res.data.environments ?? []).map((e) => e.name);
  } catch (err) {
    if (err instanceof GitHubError && (err.kind === 'not_found' || err.kind === 'definite')) return [];
    throw err;
  }
}

// ---------------------------------------------------------------- dispatch

export type DispatchOutcome =
  | { kind: 'accepted'; runId: number | null; credentialId: string }
  | { kind: 'rejected'; status: number; message: string; credentialId: string }
  | { kind: 'credential_refused'; reason: string; credentialId: string; permission?: boolean }
  | { kind: 'unknown'; reason: string; credentialId: string };

/**
 * workflow_dispatch with return_run_details. Never retried here: the caller verifies by
 * correlation tag before any second attempt (docs/03 §2.5).
 */
export async function dispatchWorkflow(params: {
  workspaceId: string;
  credential: PickedCredential;
  fullName: string;
  workflowId: number;
  ref: string;
  inputs: Record<string, string | number | boolean>;
}): Promise<DispatchOutcome> {
  const inputs = Object.fromEntries(Object.entries(params.inputs).map(([k, v]) => [k, String(v)]));
  try {
    const res = await ghRequest<Record<string, unknown> | null>({
      workspaceId: params.workspaceId,
      purpose: 'dispatch',
      method: 'POST',
      credential: params.credential,
      path: `/repos/${enc(params.fullName)}/actions/workflows/${params.workflowId}/dispatches`,
      body: { ref: params.ref, inputs, return_run_details: true },
    });
    const body = res.data ?? {};
    const runId = Number(body['workflow_run_id'] ?? body['run_id'] ?? body['id'] ?? NaN);
    return { kind: 'accepted', runId: Number.isFinite(runId) ? runId : null, credentialId: res.credentialId };
  } catch (err) {
    if (!(err instanceof GitHubError)) {
      return { kind: 'unknown', reason: (err as Error).message, credentialId: params.credential.id };
    }
    switch (err.kind) {
      case 'credential':
      case 'rate_limited':
        return { kind: 'credential_refused', reason: err.message, credentialId: params.credential.id };
      case 'definite':
        // 403 without rate limiting = this credential may not dispatch here (e.g. fine-grained scope)
        if (err.status === 403) {
          return { kind: 'credential_refused', reason: err.message, credentialId: params.credential.id, permission: true };
        }
        return { kind: 'rejected', status: err.status, message: err.message, credentialId: params.credential.id };
      case 'not_found':
        return { kind: 'rejected', status: err.status, message: err.message, credentialId: params.credential.id };
      default:
        return { kind: 'unknown', reason: err.message, credentialId: params.credential.id };
    }
  }
}

export async function findRunByTag(params: {
  workspaceId: string;
  fullName: string;
  workflowId: number;
  tag: string;
  since: Date;
}): Promise<RunSnapshot | null> {
  const res = await ghRequest<{ workflow_runs: Record<string, any>[] }>({ // eslint-disable-line @typescript-eslint/no-explicit-any
    workspaceId: params.workspaceId,
    purpose: 'status',
    path:
      `/repos/${enc(params.fullName)}/actions/workflows/${params.workflowId}/runs` +
      `?event=workflow_dispatch&per_page=50&created=${encodeURIComponent('>=' + iso(params.since))}`,
  });
  const match = res.data.workflow_runs.find((r) => String(r.display_title ?? r.name ?? '').includes(params.tag));
  return match ? toRunSnapshot(match) : null;
}

// ---------------------------------------------------------------- runs & jobs

export async function getRunAttempt(workspaceId: string, fullName: string, runId: number, attempt: number): Promise<RunSnapshot> {
  const res = await ghRequest<Record<string, any>>({ // eslint-disable-line @typescript-eslint/no-explicit-any
    workspaceId,
    purpose: 'status',
    path: `/repos/${enc(fullName)}/actions/runs/${runId}/attempts/${attempt}`,
    cacheKey: `run:${runId}:${attempt}`,
  });
  return toRunSnapshot(res.data);
}

export async function getLatestRun(workspaceId: string, fullName: string, runId: number): Promise<RunSnapshot> {
  const res = await ghRequest<Record<string, any>>({ // eslint-disable-line @typescript-eslint/no-explicit-any
    workspaceId,
    purpose: 'status',
    path: `/repos/${enc(fullName)}/actions/runs/${runId}`,
  });
  return toRunSnapshot(res.data);
}

export async function listJobs(workspaceId: string, fullName: string, repoId: number, runId: number, attempt: number): Promise<JobSnapshot[]> {
  const res = await ghRequest<{ jobs: Record<string, any>[] }>({ // eslint-disable-line @typescript-eslint/no-explicit-any
    workspaceId,
    purpose: 'status',
    path: `/repos/${enc(fullName)}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    cacheKey: `jobs:${runId}:${attempt}`,
  });
  return res.data.jobs.map((j) => toJobSnapshot(j, repoId));
}

export async function listRecentRuns(workspaceId: string, fullName: string, since: Date): Promise<RunSnapshot[]> {
  const res = await ghRequest<{ workflow_runs: Record<string, any>[] }>({ // eslint-disable-line @typescript-eslint/no-explicit-any
    workspaceId,
    purpose: 'status',
    path: `/repos/${enc(fullName)}/actions/runs?per_page=100&created=${encodeURIComponent('>=' + iso(since))}`,
  });
  return res.data.workflow_runs.map((r) => toRunSnapshot(r));
}

export async function runAction(params: {
  workspaceId: string;
  fullName: string;
  runId: number;
  action: 'cancel' | 'rerun_all' | 'rerun_failed' | 'rerun_job';
  jobId?: number | null;
}): Promise<void> {
  const base = `/repos/${enc(params.fullName)}/actions`;
  const path =
    params.action === 'cancel'
      ? `${base}/runs/${params.runId}/cancel`
      : params.action === 'rerun_all'
        ? `${base}/runs/${params.runId}/rerun`
        : params.action === 'rerun_failed'
          ? `${base}/runs/${params.runId}/rerun-failed-jobs`
          : `${base}/jobs/${params.jobId}/rerun`;
  await ghRequest<null>({ workspaceId: params.workspaceId, purpose: 'dispatch', method: 'POST', path });
}

export async function jobLogs(workspaceId: string, fullName: string, jobId: number): Promise<Response> {
  const { response } = await ghRaw({
    workspaceId,
    purpose: 'status',
    path: `/repos/${enc(fullName)}/actions/jobs/${jobId}/logs`,
  });
  return response;
}

// ---------------------------------------------------------------- webhooks

export async function createRepoWebhook(workspaceId: string, fullName: string, url: string, secret: string): Promise<number> {
  const res = await ghRequest<{ id: number }>({
    workspaceId,
    purpose: 'sync',
    method: 'POST',
    path: `/repos/${enc(fullName)}/hooks`,
    body: {
      name: 'web',
      active: true,
      events: ['workflow_run', 'workflow_job', 'push', 'repository'],
      config: { url, content_type: 'json', secret, insecure_ssl: '0' },
    },
  });
  return Number(res.data.id);
}

// ---------------------------------------------------------------- users & credentials

export interface GithubUser {
  id: number;
  login: string;
  avatarUrl: string | null;
}

export async function getUserByLogin(login: string): Promise<GithubUser | null> {
  try {
    const res = await ghRequest<{ id: number; login: string; avatar_url?: string }>({
      workspaceId: null,
      purpose: 'lookup',
      path: `/users/${encodeURIComponent(login)}`,
    });
    return { id: Number(res.data.id), login: res.data.login, avatarUrl: res.data.avatar_url ?? null };
  } catch (err) {
    if (err instanceof GitHubError && err.kind === 'not_found') return null;
    throw err;
  }
}

export async function getUserById(id: number): Promise<GithubUser | null> {
  try {
    const res = await ghRequest<{ id: number; login: string; avatar_url?: string }>({
      workspaceId: null,
      purpose: 'lookup',
      path: `/user/${id}`,
    });
    return { id: Number(res.data.id), login: res.data.login, avatarUrl: res.data.avatar_url ?? null };
  } catch (err) {
    if (err instanceof GitHubError && err.kind === 'not_found') return null;
    throw err;
  }
}

/**
 * Entra identity -> GitHub login through the org's SAML identities (GitHub Enterprise Cloud with
 * SAML SSO). Requires a pool credential allowed to read the org's SAML identities.
 */
export async function lookupSamlLogin(org: string, nameId: string): Promise<GithubUser | null> {
  const query = `query($org: String!, $nameId: String!) {
    organization(login: $org) {
      samlIdentityProvider {
        externalIdentities(first: 1, userName: $nameId) {
          nodes { user { login databaseId avatarUrl } }
        }
      }
    }
  }`;
  const res = await ghGraphql<{
    organization?: { samlIdentityProvider?: { externalIdentities?: { nodes?: { user?: { login: string; databaseId: number; avatarUrl: string } | null }[] } } };
  }>({ workspaceId: null, purpose: 'lookup' }, query, { org, nameId });
  const user = res.data.data?.organization?.samlIdentityProvider?.externalIdentities?.nodes?.[0]?.user;
  return user ? { id: user.databaseId, login: user.login, avatarUrl: user.avatarUrl } : null;
}

/**
 * Validates a credential that is NOT stored yet (direct call, bypassing the pool) and returns
 * its owner account for PATs. Throws GitHubError when GitHub rejects it.
 */
export async function describeNewCredential(temp: PickedCredential): Promise<{ accountId: number | null; accountLogin: string | null }> {
  const env = getEnv();
  const token = await credentialToken(temp);
  const path = temp.kind === 'github_app' ? '/installation/repositories?per_page=1' : '/user';
  const res = await fetch(`${env.GITHUB_API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': env.GITHUB_API_VERSION,
      'User-Agent': 'workflow-control-plane',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new GitHubError(`GitHub rejected the credential (HTTP ${res.status})`, res.status, 'credential', null);
  if (temp.kind === 'github_app') return { accountId: null, accountLogin: null };
  const body = (await res.json()) as { id: number; login: string };
  return { accountId: Number(body.id), accountLogin: body.login };
}

export async function refreshRateLimit(credential: PickedCredential): Promise<void> {
  // /rate_limit doesn't consume the primary budget; response headers update the bucket.
  await ghRequest({ workspaceId: null, purpose: 'lookup', credential, path: '/rate_limit' });
}
