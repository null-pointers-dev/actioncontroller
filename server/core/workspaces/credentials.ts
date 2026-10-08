import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, pgErrorCode, recordEvent, unitOfWork } from '@/server/db/uow';
import { githubCredentials, githubRateBuckets, workspaceCredentials, workspaces } from '@/server/db/schema';
import { describeNewCredential, getRepo, refreshRateLimit } from '@/server/github/api';
import { loadCredential } from '@/server/github/pool';
import { forgetSecret, storeSecret } from '@/server/github/secrets';
import { requireAdmin } from '../access/access';
import type { Principal } from '../access/policy';
import { Conflict, NotFound, ValidationError } from '../errors';

type Ctx = { principal: Principal; correlationId?: string };

export async function listCredentials({ principal }: Ctx) {
  requireAdmin(principal);
  const creds = await db().select().from(githubCredentials).orderBy(githubCredentials.priority, githubCredentials.label);
  const buckets = await db().select().from(githubRateBuckets).where(eq(githubRateBuckets.resource, 'core'));
  const coverage = await db()
    .select({ credentialId: workspaceCredentials.credentialId, n: sql<number>`count(*)::int`, dispatch: sql<number>`count(*) filter (where ${workspaceCredentials.canDispatch})::int` })
    .from(workspaceCredentials)
    .groupBy(workspaceCredentials.credentialId);
  const covMap = new Map(coverage.map((c) => [c.credentialId, c]));
  const bucketMap = new Map(buckets.map((b) => [b.rateBucket, b]));
  return creds.map((c) => ({
    id: c.id,
    label: c.label,
    kind: c.kind,
    accountLogin: c.githubAccountLogin,
    rateBucket: c.rateBucket,
    status: c.status,
    priority: c.priority,
    expiresAt: c.expiresAt,
    lastUsedAt: c.lastUsedAt,
    lastError: c.lastError,
    workspaces: covMap.get(c.id)?.n ?? 0,
    dispatchWorkspaces: covMap.get(c.id)?.dispatch ?? 0,
    bucket: bucketMap.get(c.rateBucket) ?? null,
    secretSource: c.secretRef.startsWith('env:') ? 'environment' : 'key-vault',
  }));
}

export async function addCredential(
  ctx: Ctx,
  input: { label: string; kind: 'fine_grained_pat' | 'classic_pat' | 'github_app'; secret: string; appId?: number; installationId?: number; priority: number },
) {
  requireAdmin(ctx.principal);
  const id = randomUUID();
  // Store first (Key Vault or env reference), then validate with GitHub.
  const secretRef = await storeSecret(`cp-gh-${id}`, input.secret);
  const temp = {
    id,
    label: input.label,
    kind: input.kind,
    secretRef,
    rateBucket: 'pending',
    appId: input.appId ?? null,
    installationId: input.installationId ?? null,
  };
  let account: { accountId: number | null; accountLogin: string | null };
  try {
    account = await describeNewCredential(temp);
  } catch (err) {
    forgetSecret(secretRef);
    throw new ValidationError([{ field: 'secret', code: 'rejected', message: (err as Error).message }]);
  }
  const rateBucket = input.kind === 'github_app' ? `installation:${input.installationId}` : `user:${account.accountId}`;
  try {
    return await unitOfWork({ actor: { kind: 'user', id: ctx.principal.id }, correlationId: ctx.correlationId }, async () => {
      const [row] = await db()
        .insert(githubCredentials)
        .values({
          id,
          label: input.label,
          kind: input.kind,
          secretRef,
          githubAccountId: account.accountId,
          githubAccountLogin: account.accountLogin,
          appId: input.appId ?? null,
          installationId: input.installationId ?? null,
          rateBucket,
          priority: input.priority,
          createdBy: ctx.principal.id,
        })
        .returning();
      recordEvent({
        type: 'cp.credential.added',
        subject: `credentials/${id}`,
        aggregateType: 'credential',
        aggregateId: id,
        data: { label: input.label, kind: input.kind, rateBucket, accountLogin: account.accountLogin },
      });
      return row!;
    });
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw new Conflict('A credential with this label already exists');
    throw err;
  }
}

export async function setCredentialStatus(ctx: Ctx, id: string, status: 'active' | 'disabled') {
  requireAdmin(ctx.principal);
  await unitOfWork({ actor: { kind: 'user', id: ctx.principal.id }, correlationId: ctx.correlationId }, async () => {
    const [row] = await db().update(githubCredentials).set({ status, lastError: null }).where(eq(githubCredentials.id, id)).returning();
    if (!row) throw new NotFound('Credential not found');
    recordEvent({
      type: 'cp.credential.status_changed',
      subject: `credentials/${id}`,
      aggregateType: 'credential',
      aggregateId: id,
      data: { status },
    });
  });
}

export async function setCredentialPriority(ctx: Ctx, id: string, priority: number) {
  requireAdmin(ctx.principal);
  await db().update(githubCredentials).set({ priority }).where(eq(githubCredentials.id, id));
}

/** Refresh budget and re-check coverage for every workspace using this credential. */
export async function revalidateCredential(ctx: Ctx | null, id: string): Promise<void> {
  if (ctx) requireAdmin(ctx.principal);
  const cred = await loadCredential(id);
  await refreshRateLimit(cred);
  const rows = await db()
    .select({ workspaceId: workspaceCredentials.workspaceId, fullName: workspaces.fullName })
    .from(workspaceCredentials)
    .innerJoin(workspaces, eq(workspaces.id, workspaceCredentials.workspaceId))
    .where(eq(workspaceCredentials.credentialId, id));
  for (const r of rows) {
    try {
      const repo = await getRepo(r.fullName, { credential: cred });
      await db()
        .update(workspaceCredentials)
        .set({ canDispatch: repo.canPush, validatedAt: new Date(), lastError: null })
        .where(sql`${workspaceCredentials.workspaceId} = ${r.workspaceId} and ${workspaceCredentials.credentialId} = ${id}`);
    } catch (err) {
      await db()
        .update(workspaceCredentials)
        .set({ lastError: (err as Error).message.slice(0, 300), validatedAt: new Date() })
        .where(sql`${workspaceCredentials.workspaceId} = ${r.workspaceId} and ${workspaceCredentials.credentialId} = ${id}`);
    }
  }
}
