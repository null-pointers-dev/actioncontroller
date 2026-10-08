import 'server-only';
import { tracked } from '@trpc/server';
import { z } from 'zod';
import type { LiveEvent } from '@/shared/events';
import { visibleWorkspaceIds } from '@/server/core/access/access';
import { decodeCursor, encodeCursor, headCursor, readEvents, type FeedEvent } from '@/server/core/events/feed';
import { loadPrincipal } from '@/server/core/identity/identity';
import { getEventHub } from '@/server/realtime/event-hub';
import { authedProcedure, router } from '../init';

const ACCESS_EVENTS = new Set(['cp.workspace.grant_added', 'cp.workspace.grant_removed', 'cp.workspace.updated', 'cp.workspace.archived', 'cp.identity.role_changed']);
const ADMIN_ONLY_PREFIXES = ['cp.credential.', 'cp.system.'];

function toLive(e: FeedEvent): LiveEvent {
  return {
    id: e.id,
    type: e.type,
    time: e.time,
    subject: e.subject,
    aggregateType: e.aggregateType,
    aggregateId: e.aggregateId,
    aggregateVersion: e.aggregateVersion,
    workspaceId: e.workspaceId,
    workflowId: e.workflowId,
    data: e.data,
  };
}

export const liveRouter = router({
  /** One SSE stream per tab: every event this user may see, resumable via lastEventId. */
  stream: authedProcedure
    .input(z.object({ lastEventId: z.string().nullish() }).optional())
    .subscription(async function* ({ ctx, input, signal }) {
      const hub = getEventHub();
      await hub.start();
      let user = ctx.user;
      let visible = await visibleWorkspaceIds(user);
      let cursor = decodeCursor(input?.lastEventId) ?? (await headCursor());

      const canSee = (e: FeedEvent) => {
        if (user.role === 'admin') return true;
        if (ADMIN_ONLY_PREFIXES.some((p) => e.type.startsWith(p))) return false;
        if (e.workspaceId) return visible.has(e.workspaceId);
        return e.data['userId'] === user.id;
      };

      while (!signal?.aborted) {
        const batch = await readEvents(cursor, 200);
        for (const e of batch) {
          cursor = e.cursor;
          if (ACCESS_EVENTS.has(e.type)) {
            user = (await loadPrincipal(user.id)) ?? user;
            visible = await visibleWorkspaceIds(user);
          }
          if (canSee(e)) yield tracked(encodeCursor(cursor), toLive(e));
        }
        if (batch.length === 200) continue;
        await hub.waitForChange(signal, 25_000);
      }
    }),
});
