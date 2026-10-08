import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/server/db/client';
import { workflowRuns, workspaces } from '@/server/db/schema';
import { getRunAttempt, listJobs, listRecentRuns } from '@/server/github/api';
import { enqueue, Queues } from '../platform/queue';
import { applyJobSnapshot, applyRunSnapshot } from './apply';

/** Leased scheduler tick (every ~15 s): finds what needs confirming and queues it. */
export async function scheduleChecks(): Promise<void> {
  const db = getDb();
  const stale = await db.execute<{ run_id: string; run_attempt: number }>(sql`
    select run_id::text, run_attempt from cp.workflow_runs
     where status <> 'completed' and last_seen_at < now() - interval '60 seconds'
     order by last_seen_at limit 200`);
  for (const r of stale.rows) await enqueue(Queues.check, `${r.run_id}:${r.run_attempt}`, 0, 50);

  // Polling workspaces: every 30 s while runs are active, every 2 min otherwise.
  // Webhook workspaces: a warm listing every 5 min as a safety net.
  const due = await db.execute<{ id: string }>(sql`
    select w.id from cp.workspaces w
     where w.status = 'active'
       and (w.runs_listed_until is null
            or (w.update_mode = 'polling' and exists (
                  select 1 from cp.workflow_runs r where r.workspace_id = w.id and r.status <> 'completed')
                and w.runs_listed_until < now() - interval '30 seconds')
            or (w.update_mode = 'polling' and w.runs_listed_until < now() - interval '2 minutes')
            or w.runs_listed_until < now() - interval '5 minutes')`);
  for (const w of due.rows) await enqueue(Queues.poll, w.id, 0, 60);

  // Requests that should be moving but aren't (crashed worker, lost wake-up, cancel waiting).
  const stuck = await db.execute<{ id: string }>(sql`
    select id from cp.run_requests
     where (phase in ('pending', 'waiting_for_slot', 'dispatching', 'verifying', 'cancelling')
            and updated_at < now() - interval '2 minutes')
        or (phase in ('dispatched', 'running') and cancel_requested)
     limit 200`);
  for (const r of stuck.rows) await enqueue(Queues.dispatch, r.id, 0, 30);
}

/** Queue `check`: confirm one unfinished run attempt (and its jobs) with GitHub. */
export async function checkRun(key: string): Promise<void> {
  const [runIdText, attemptText] = key.split(':');
  const runId = Number(runIdText);
  const attempt = Number(attemptText);
  const [row] = await getDb()
    .select({ workspaceId: workflowRuns.workspaceId, fullName: workspaces.fullName, repoId: workspaces.githubRepoId })
    .from(workflowRuns)
    .innerJoin(workspaces, eq(workspaces.id, workflowRuns.workspaceId))
    .where(and(eq(workflowRuns.runId, runId), eq(workflowRuns.runAttempt, attempt)))
    .limit(1);
  if (!row) return;
  const snap = await getRunAttempt(row.workspaceId, row.fullName, runId, attempt);
  await applyRunSnapshot(snap, 'poll');
  for (const job of await listJobs(row.workspaceId, row.fullName, row.repoId, runId, attempt)) {
    await applyJobSnapshot(job, 'poll');
  }
}

/** Queue `poll`: list recent runs of a workspace (finds runs we never heard about). */
export async function pollWorkspace(workspaceId: string): Promise<void> {
  const [ws] = await getDb().select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws || ws.status !== 'active') return;
  const startedAt = new Date();
  const since = new Date((ws.runsListedUntil ?? new Date(Date.now() - 60 * 60_000)).getTime() - 5 * 60_000);
  for (const snap of await listRecentRuns(ws.id, ws.fullName, since)) {
    await applyRunSnapshot({ ...snap, repoId: ws.githubRepoId }, 'poll');
  }
  await getDb().update(workspaces).set({ runsListedUntil: startedAt }).where(eq(workspaces.id, ws.id));
}
