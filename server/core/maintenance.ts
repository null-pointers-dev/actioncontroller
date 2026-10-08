import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { getDb, withOwnerRole } from '@/server/db/client';
import { db, enqueueAfterCommit, recordEvent, unitOfWork } from '@/server/db/uow';
import { githubCredentials } from '@/server/db/schema';
import { refreshRateLimit } from '@/server/github/api';
import { Queues } from './platform/queue';
import { revalidateCredential } from './workspaces/credentials';

/** Every minute: pending approvals past their TTL expire; the dispatcher then rejects the request. */
export async function expireApprovals(): Promise<void> {
  await unitOfWork({ actor: { kind: 'system', id: 'approval-expiry' } }, async () => {
    const expired = await db().execute<{ run_request_id: string; workspace_id: string }>(sql`
      update cp.approval_requests set state = 'expired', decided_at = now()
       where state = 'pending' and expires_at < now()
       returning run_request_id, workspace_id`);
    for (const r of expired.rows) {
      recordEvent({
        type: 'cp.approval.expired',
        subject: `run-requests/${r.run_request_id}`,
        aggregateType: 'approval',
        aggregateId: r.run_request_id,
        workspaceId: r.workspace_id,
        data: { runRequestId: r.run_request_id },
      });
      enqueueAfterCommit(Queues.dispatch, r.run_request_id, { priority: 20 });
    }
  });
}

/** Every 10 minutes: budgets, expiry, revoked tokens, coverage problems. */
export async function credentialHealth(): Promise<void> {
  const creds = await getDb().select().from(githubCredentials).where(eq(githubCredentials.status, 'active'));
  for (const c of creds) {
    try {
      await refreshRateLimit(c); // 401 marks it invalid inside the client
      if (c.expiresAt && c.expiresAt.getTime() - Date.now() < 14 * 24 * 3600_000) {
        console.warn(`[credentials] "${c.label}" expires ${c.expiresAt.toISOString()}`);
      }
    } catch (err) {
      console.warn(`[credentials] health check failed for "${c.label}": ${(err as Error).message}`);
    }
  }
  const broken = await getDb().execute<{ credential_id: string }>(sql`
    select distinct credential_id from cp.workspace_credentials where last_error is not null`);
  for (const b of broken.rows) {
    await revalidateCredential(null, b.credential_id).catch((err) => console.warn('[credentials] revalidate failed', (err as Error).message));
  }
  await getDb().execute(sql`
    update cp.github_credentials set status = 'expired'
     where status = 'active' and expires_at is not null and expires_at < now()`);
}

/** Daily: partitions ahead, prune the webhook dedupe table. */
export async function housekeeping(): Promise<void> {
  await withOwnerRole(async (client) => {
    await client.query(`select cp.ensure_month_partitions('events', 2)`);
    await client.query(`select cp.ensure_month_partitions('webhook_deliveries', 2)`);
  });
  await getDb().execute(sql`delete from cp.inbox_seen where seen_at < now() - interval '14 days'`);
}
