import 'server-only';
import { eq } from 'drizzle-orm';
import { getDb } from '@/server/db/client';
import { githubHttpCache } from '@/server/db/schema';
import { getEnv } from '../env';
import {
  credentialToken,
  markBlocked,
  markInvalid,
  observeResponse,
  pickCredential,
  recordFailure,
  type PickedCredential,
  type Purpose,
} from './pool';

export type GitHubErrorKind = 'credential' | 'rate_limited' | 'definite' | 'not_found' | 'transient';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: GitHubErrorKind,
    readonly credentialId: string | null,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GhRequest {
  workspaceId: string | null;
  purpose: Purpose;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** Use exactly this credential (no failover). */
  credential?: PickedCredential;
  /** Enables conditional GET with a stored ETag. */
  cacheKey?: string;
  accept?: string;
}

export interface GhResponse<T> {
  status: number;
  data: T;
  headers: Headers;
  credentialId: string;
}

/** Raw streaming response (logs). Caller owns the body. */
export interface GhRawResponse {
  response: Response;
  credentialId: string;
}

async function send(req: GhRequest, cred: PickedCredential, etag?: string): Promise<Response> {
  const env = getEnv();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await credentialToken(cred)}`,
    Accept: req.accept ?? 'application/vnd.github+json',
    'X-GitHub-Api-Version': env.GITHUB_API_VERSION,
    'User-Agent': 'workflow-control-plane',
  };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  if (etag) headers['If-None-Match'] = etag;
  try {
    return await fetch(`${env.GITHUB_API_URL}${req.path}`, {
      method: req.method ?? 'GET',
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
  } catch (err) {
    await recordFailure(cred, `network: ${(err as Error).message}`);
    throw new GitHubError(`GitHub request failed: ${(err as Error).message}`, 0, 'transient', cred.id);
  }
}

/** Classifies a non-success response and updates the pool. Always throws. */
async function fail(res: Response, cred: PickedCredential): Promise<never> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const message = (body as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
  const resource = res.headers.get('x-ratelimit-resource') ?? 'core';

  if (res.status === 401) {
    await markInvalid(cred, `401: ${message}`);
    throw new GitHubError(message, 401, 'credential', cred.id, body);
  }
  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubError(message, res.status, 'rate_limited', cred.id, body); // bucket already updated
    }
    if (retryAfter || /secondary rate limit/i.test(message)) {
      await markBlocked(cred, resource, retryAfter ? Number(retryAfter) : 60);
      throw new GitHubError(message, res.status, 'rate_limited', cred.id, body);
    }
    throw new GitHubError(message, res.status, 'definite', cred.id, body); // permission problem
  }
  if (res.status === 404) throw new GitHubError(message, 404, 'not_found', cred.id, body);
  if (res.status >= 500) {
    await recordFailure(cred, `${res.status}: ${message}`);
    throw new GitHubError(message, res.status, 'transient', cred.id, body);
  }
  throw new GitHubError(message, res.status, 'definite', cred.id, body);
}

/**
 * JSON request through the credential pool.
 * GETs fail over to another credential once on credential / rate-limit / transient errors.
 * Non-GET requests never retry here (dispatch safety is handled by the caller).
 */
export async function ghRequest<T>(req: GhRequest): Promise<GhResponse<T>> {
  const method = req.method ?? 'GET';
  const maxAttempts = method === 'GET' && !req.credential ? 2 : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const cred = req.credential ?? (await pickCredential(req.workspaceId, req.purpose));
    let cached: { etag: string; body: unknown } | undefined;
    if (req.cacheKey && method === 'GET') {
      const [row] = await getDb().select().from(githubHttpCache).where(eq(githubHttpCache.cacheKey, req.cacheKey)).limit(1);
      if (row) cached = { etag: row.etag, body: row.body };
    }
    try {
      const res = await send(req, cred, cached?.etag);
      await observeResponse(cred, res.headers);
      if (res.status === 304 && cached) {
        return { status: 304, data: cached.body as T, headers: res.headers, credentialId: cred.id };
      }
      if (!res.ok) await fail(res, cred);
      const isJson = res.headers.get('content-type')?.includes('json');
      const data = (res.status === 204 ? null : isJson ? await res.json() : await res.text()) as T;
      const etag = res.headers.get('etag');
      if (req.cacheKey && etag && method === 'GET') {
        await getDb()
          .insert(githubHttpCache)
          .values({ cacheKey: req.cacheKey, etag, body: data as object })
          .onConflictDoUpdate({ target: githubHttpCache.cacheKey, set: { etag, body: data as object, fetchedAt: new Date() } });
      }
      return { status: res.status, data, headers: res.headers, credentialId: cred.id };
    } catch (err) {
      lastError = err;
      const retryable = err instanceof GitHubError && ['credential', 'rate_limited', 'transient'].includes(err.kind);
      if (!retryable || attempt === maxAttempts) throw err;
    }
  }
  throw lastError;
}

/** Streaming request (job logs). Follows GitHub's redirect to the signed download URL. */
export async function ghRaw(req: GhRequest): Promise<GhRawResponse> {
  const cred = req.credential ?? (await pickCredential(req.workspaceId, req.purpose));
  const res = await send(req, cred);
  await observeResponse(cred, res.headers);
  if (!res.ok) await fail(res, cred);
  return { response: res, credentialId: cred.id };
}

export async function ghGraphql<T>(req: Omit<GhRequest, 'path' | 'method' | 'body'>, query: string, variables: Record<string, unknown>) {
  return ghRequest<{ data?: T; errors?: { message: string }[] }>({ ...req, method: 'POST', path: '/graphql', body: { query, variables } });
}
