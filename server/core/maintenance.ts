import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/server/db/client';
import { db, enqueueAfterCommit, recordEvent, unitOfWork } from '@/server/db/uow';
import { githubCredentials } from '@/server/db/schema';
import { refreshRateLimit } from '@/server/github/api';
import { Queues } from '@/server/jobs/queues';
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

const EVENTS_RETENTION = '13 months';
const DELIVERIES_RETENTION = '30 days';

/**
 * Daily: retention. Events are append-only (trigger); the retention job is the one place
 * allowed to delete them, by setting cp.retention_delete for its own transaction only.
 * Deletes in batches so no single transaction gets large.
 */
export async function housekeeping(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const deleted = await getDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('cp.retention_delete', 'on', true)`);
      const res = await tx.execute(sql`
        delete from cp.events where seq in (
          select seq from cp.events where occurred_at < now() - ${EVENTS_RETENTION}::interval limit 5000)`);
      return res.rowCount ?? 0;
    });
    if (deleted < 5000) break;
  }
  await getDb().execute(sql`
    delete from cp.webhook_deliveries
     where received_at < now() - ${DELIVERIES_RETENTION}::interval and process_status in ('applied', 'ignored', 'dead')`);
}
