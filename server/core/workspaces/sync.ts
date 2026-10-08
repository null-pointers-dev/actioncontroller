import 'server-only';
import { and, eq, notInArray } from 'drizzle-orm';
import { getEnv } from '@/server/env';
import { db, recordEvent, unitOfWork } from '@/server/db/uow';
import { workflows, workspaces } from '@/server/db/schema';
import { createRepoWebhook, getRepoById, listWorkflows } from '@/server/github/api';
import { ensureDefinition } from './workspaces';

const SYSTEM = { kind: 'system' as const, id: 'sync' };

/** Worker step for queue `sync` (docs/01 §6). Throws to retry with backoff. */
export async function syncWorkspace(workspaceId: string): Promise<void> {
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws || ws.status === 'archived') return;

  try {
    const repo = await getRepoById(ws.githubRepoId, ws.id);
    const remote = await listWorkflows(ws.id, repo.fullName);

    // 1. Repository metadata + workflow list
    const discovered = await unitOfWork({ actor: SYSTEM }, async () => {
      await db()
        .update(workspaces)
        .set({ fullName: repo.fullName, ownerLogin: repo.ownerLogin, repoName: repo.name, defaultBranch: repo.defaultBranch })
        .where(eq(workspaces.id, ws.id));

      const existing = new Set((await db().select({ id: workflows.id }).from(workflows).where(eq(workflows.workspaceId, ws.id))).map((r) => r.id));
      for (const wf of remote) {
        await db()
          .insert(workflows)
          .values({ id: wf.id, workspaceId: ws.id, path: wf.path, name: wf.name, ghState: wf.state })
          .onConflictDoUpdate({ target: workflows.id, set: { path: wf.path, name: wf.name, ghState: wf.state } });
        if (!existing.has(wf.id)) {
          recordEvent({
            type: 'cp.workflow.discovered',
            subject: `workflows/${wf.id}`,
            aggregateType: 'workflow',
            aggregateId: String(wf.id),
            workspaceId: ws.id,
            workflowId: wf.id,
            data: { name: wf.name, path: wf.path },
          });
        }
      }
      const remoteIds = remote.map((w) => w.id);
      const removed = await db()
        .update(workflows)
        .set({ ghState: 'deleted' })
        .where(
          remoteIds.length
            ? and(eq(workflows.workspaceId, ws.id), notInArray(workflows.id, remoteIds))
            : eq(workflows.workspaceId, ws.id),
        )
        .returning({ id: workflows.id });
      for (const r of removed) {
        recordEvent({
          type: 'cp.workflow.removed',
          subject: `workflows/${r.id}`,
          aggregateType: 'workflow',
          aggregateId: String(r.id),
          workspaceId: ws.id,
          workflowId: r.id,
          data: {},
        });
      }
      return db().select().from(workflows).where(eq(workflows.workspaceId, ws.id));
    });

    // 2. Definitions on the default branch (network outside transactions)
    const fresh = { ...ws, fullName: repo.fullName, defaultBranch: repo.defaultBranch };
    for (const wf of discovered.filter((w) => w.ghState === 'active')) {
      try {
        await ensureDefinition(fresh, wf, repo.defaultBranch, true);
      } catch (err) {
        console.warn(`[sync] definition for ${wf.path} failed`, (err as Error).message);
      }
    }

    // 3. Webhook if possible, otherwise polling
    const env = getEnv();
    let hookId: number | null = ws.githubHookId;
    if (!hookId && env.PUBLIC_BASE_URL && env.GITHUB_WEBHOOK_SECRET) {
      try {
        hookId = await createRepoWebhook(ws.id, repo.fullName, `${env.PUBLIC_BASE_URL}/api/webhooks/github`, env.GITHUB_WEBHOOK_SECRET);
      } catch (err) {
        console.info(`[sync] webhook not created for ${repo.fullName} (polling mode): ${(err as Error).message}`);
      }
    }

    await unitOfWork({ actor: SYSTEM }, async () => {
      const [updated] = await db()
        .update(workspaces)
        .set({
          status: repo.archived ? 'archived' : 'active',
          statusReason: null,
          lastSyncedAt: new Date(),
          updateMode: hookId ? 'webhook' : 'polling',
          githubHookId: hookId,
        })
        .where(eq(workspaces.id, ws.id))
        .returning();
      recordEvent({
        type: 'cp.workspace.synced',
        subject: `workspaces/${ws.id}`,
        aggregateType: 'workspace',
        aggregateId: ws.id,
        aggregateVersion: updated?.resourceVersion,
        workspaceId: ws.id,
        data: { workflows: discovered.length, updateMode: updated?.updateMode },
      });
    });
  } catch (err) {
    await unitOfWork({ actor: SYSTEM }, async () => {
      await db()
        .update(workspaces)
        .set({ status: ws.status === 'importing' ? 'error' : ws.status, statusReason: (err as Error).message.slice(0, 500) })
        .where(eq(workspaces.id, ws.id));
      recordEvent({
        type: 'cp.workspace.sync_failed',
        subject: `workspaces/${ws.id}`,
        aggregateType: 'workspace',
        aggregateId: ws.id,
        workspaceId: ws.id,
        data: { error: (err as Error).message },
      });
    });
    throw err;
  }
}
