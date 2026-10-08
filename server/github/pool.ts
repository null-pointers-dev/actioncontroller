import 'server-only';
import { createSign } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/server/db/client';
import { githubCredentials, githubRateBuckets, type CredentialRow } from '@/server/db/schema';
import { UpstreamUnavailable } from '@/server/core/errors';
import { getEnv } from '../env';
import { getSecret } from './secrets';

/** Priority classes: background work can't starve user actions (docs/03 §2.3). */
export type Purpose = 'dispatch' | 'status' | 'sync' | 'lookup';
const RESERVE: Record<Purpose, number> = { dispatch: 1, status: 200, sync: 1000, lookup: 2000 };

export type PickedCredential = Pick<
  CredentialRow,
  'id' | 'label' | 'kind' | 'secretRef' | 'rateBucket' | 'appId' | 'installationId'
>;

export class NoGitHubCapacity extends UpstreamUnavailable {
  constructor(purpose: Purpose, workspaceId: string | null) {
    super(`No GitHub credential can serve this ${purpose} request right now`, { purpose, workspaceId });
  }
}

async function reopenCooledBreakers(): Promise<void> {
  await getDb().execute(sql`
    update cp.github_rate_buckets set breaker_state = 'half_open'
     where breaker_state = 'open' and blocked_until < now()`);
}

async function hasReserve(bucket: string, purpose: Purpose): Promise<boolean> {
  const [b] = await getDb()
    .select()
    .from(githubRateBuckets)
    .where(and(eq(githubRateBuckets.rateBucket, bucket), eq(githubRateBuckets.resource, 'core')))
    .limit(1);
  if (!b || b.remaining === null || !b.resetsAt || b.resetsAt < new Date()) return true;
  return b.remaining >= RESERVE[purpose];
}

/** Best credential for a workspace (or any workspace when null). Throws NoGitHubCapacity. */
export async function pickCredential(workspaceId: string | null, purpose: Purpose): Promise<PickedCredential> {
  await reopenCooledBreakers();
  let id: string | null = null;
  if (workspaceId) {
    const res = await getDb().execute<{ id: string | null }>(
      sql`select cp.pick_credential(${workspaceId}::uuid, ${purpose === 'dispatch'}) as id`,
    );
    id = res.rows[0]?.id ?? null;
  } else {
    const res = await getDb().execute<{ id: string }>(sql`
      select c.id from cp.github_credentials c
        left join cp.github_rate_buckets b on b.rate_bucket = c.rate_bucket and b.resource = 'core'
       where c.status = 'active' and (c.expires_at is null or c.expires_at > now())
         and coalesce(b.breaker_state, 'closed') <> 'open'
         and (b.blocked_until is null or b.blocked_until < now())
         and (b.remaining is null or b.remaining > 0 or b.resets_at < now())
       order by case when b.resets_at < now() then null else b.remaining end desc nulls first, c.priority
       limit 1`);
    id = res.rows[0]?.id ?? null;
  }
  if (!id) throw new NoGitHubCapacity(purpose, workspaceId);
  const [cred] = await getDb().select().from(githubCredentials).where(eq(githubCredentials.id, id)).limit(1);
  if (!cred) throw new NoGitHubCapacity(purpose, workspaceId);
  if (!(await hasReserve(cred.rateBucket, purpose))) throw new NoGitHubCapacity(purpose, workspaceId);
  return cred;
}

export async function loadCredential(id: string): Promise<PickedCredential> {
  const [cred] = await getDb().select().from(githubCredentials).where(eq(githubCredentials.id, id)).limit(1);
  if (!cred) throw new Error(`Unknown credential ${id}`);
  return cred;
}

// ---------------------------------------------------------------- tokens

const appTokens = new Map<string, { token: string; expiresAt: number }>();

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function appJwt(appId: number, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${base64url(signature)}`;
}

export async function credentialToken(cred: PickedCredential): Promise<string> {
  if (cred.kind !== 'github_app') return getSecret(cred.secretRef);
  const cached = appTokens.get(cred.id);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const env = getEnv();
  const jwt = appJwt(Number(cred.appId), await getSecret(cred.secretRef));
  const res = await fetch(`${env.GITHUB_API_URL}/app/installations/${cred.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': env.GITHUB_API_VERSION,
      'User-Agent': 'workflow-control-plane',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    await markInvalid(cred, `installation token request failed: HTTP ${res.status}`);
    throw new UpstreamUnavailable(`GitHub App token request failed (${res.status})`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  appTokens.set(cred.id, { token: body.token, expiresAt: Date.parse(body.expires_at) });
  return body.token;
}

// ---------------------------------------------------------------- reporting what GitHub said

function parseExpiration(value: string | null): Date | null {
  if (!value) return null;
  const normalised = value.replace(' UTC', 'Z').replace(' ', 'T');
  const t = Date.parse(normalised);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Updates the bucket and credential from response headers (called for every response). */
export async function observeResponse(cred: PickedCredential, headers: Headers): Promise<void> {
  const remaining = headers.get('x-ratelimit-remaining');
  const limit = headers.get('x-ratelimit-limit');
  const reset = headers.get('x-ratelimit-reset');
  const resource = headers.get('x-ratelimit-resource') ?? 'core';
  if (remaining !== null && reset !== null) {
    const resetsAt = new Date(Number(reset) * 1000);
    await getDb()
      .insert(githubRateBuckets)
      .values({
        rateBucket: cred.rateBucket,
        resource,
        limitTotal: limit === null ? null : Number(limit),
        remaining: Number(remaining),
        resetsAt,
        breakerState: 'closed',
        consecutiveFailures: 0,
      })
      .onConflictDoUpdate({
        target: [githubRateBuckets.rateBucket, githubRateBuckets.resource],
        set: {
          limitTotal: limit === null ? null : Number(limit),
          remaining: Number(remaining),
          resetsAt,
          breakerState: 'closed',
          consecutiveFailures: 0,
          updatedAt: new Date(),
        },
      });
  }
  const expiresAt = parseExpiration(headers.get('github-authentication-token-expiration'));
  await getDb()
    .update(githubCredentials)
    .set({ lastUsedAt: new Date(), consecutiveFailures: 0, ...(expiresAt ? { expiresAt } : {}) })
    .where(eq(githubCredentials.id, cred.id));
}

export async function markInvalid(cred: PickedCredential, reason: string): Promise<void> {
  await getDb()
    .update(githubCredentials)
    .set({ status: 'invalid', lastError: reason })
    .where(eq(githubCredentials.id, cred.id));
  appTokens.delete(cred.id);
}

/** Secondary limit / Retry-After: skip this bucket for a while. */
export async function markBlocked(cred: PickedCredential, resource: string, seconds: number): Promise<void> {
  const blockedUntil = new Date(Date.now() + seconds * 1000);
  await getDb()
    .insert(githubRateBuckets)
    .values({ rateBucket: cred.rateBucket, resource, blockedUntil })
    .onConflictDoUpdate({
      target: [githubRateBuckets.rateBucket, githubRateBuckets.resource],
      set: { blockedUntil, updatedAt: new Date() },
    });
}

/** Transient failures (5xx, timeouts) open the bucket's breaker after 5 in a row. */
export async function recordFailure(cred: PickedCredential, reason: string): Promise<void> {
  await getDb().execute(sql`
    insert into cp.github_rate_buckets (rate_bucket, resource, consecutive_failures)
    values (${cred.rateBucket}, 'core', 1)
    on conflict (rate_bucket, resource) do update
       set consecutive_failures = cp.github_rate_buckets.consecutive_failures + 1,
           breaker_state = case when cp.github_rate_buckets.consecutive_failures + 1 >= 5 then 'open'
                                else cp.github_rate_buckets.breaker_state end,
           blocked_until = case when cp.github_rate_buckets.consecutive_failures + 1 >= 5
                                then now() + interval '60 seconds'
                                else cp.github_rate_buckets.blocked_until end,
           updated_at = now()`);
  await getDb()
    .update(githubCredentials)
    .set({ lastError: reason, consecutiveFailures: sql`${githubCredentials.consecutiveFailures} + 1` })
    .where(eq(githubCredentials.id, cred.id));
}
