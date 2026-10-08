import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { credentialAddInput } from '@/shared/schemas';
import { getDb } from '@/server/db/client';
import {
  addCredential,
  listCredentials,
  revalidateCredential,
  setCredentialPriority,
  setCredentialStatus,
} from '@/server/core/workspaces/credentials';
import { adminProcedure, router } from '../init';

export const credentialsRouter = router({
  list: adminProcedure.query(({ ctx }) => listCredentials(ctx.svc)),
  add: adminProcedure.input(credentialAddInput).mutation(async ({ ctx, input }) => {
    const row = await addCredential(ctx.svc, input);
    return { id: row.id };
  }),
  setStatus: adminProcedure
    .input(z.object({ id: z.uuid(), status: z.enum(['active', 'disabled']) }))
    .mutation(({ ctx, input }) => setCredentialStatus(ctx.svc, input.id, input.status)),
  setPriority: adminProcedure
    .input(z.object({ id: z.uuid(), priority: z.number().int().min(1).max(1000) }))
    .mutation(({ ctx, input }) => setCredentialPriority(ctx.svc, input.id, input.priority)),
  revalidate: adminProcedure.input(z.object({ id: z.uuid() })).mutation(({ ctx, input }) => revalidateCredential(ctx.svc, input.id)),
});

export const systemRouter = router({
  status: adminProcedure.query(async () => {
    const db = getDb();
    const [queues, deliveries, drift, workspaces] = await Promise.all([
      db.execute<{ queue: string; depth: number; oldest_seconds: number | null; locked: number }>(sql`
        select queue, count(*)::int as depth,
               extract(epoch from now() - min(enqueued_at))::int as oldest_seconds,
               count(*) filter (where locked_until > now())::int as locked
          from cp.work_queue group by queue order by queue`),
      db.execute<{ status: string; n: number }>(sql`
        select process_status as status, count(*)::int as n from cp.webhook_deliveries
         where received_at > now() - interval '24 hours' group by process_status`),
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from cp.events
         where type = 'cp.system.drift_corrected' and occurred_at > now() - interval '1 hour'`),
      db.execute<{ id: string; display_name: string; status: string; update_mode: string; last_synced_at: Date | null; status_reason: string | null }>(sql`
        select id, display_name, status, update_mode, last_synced_at, status_reason from cp.workspaces order by display_name`),
    ]);
    return {
      queues: queues.rows,
      deliveries: deliveries.rows,
      driftCorrectionsLastHour: drift.rows[0]?.n ?? 0,
      workspaces: workspaces.rows,
    };
  }),
});
