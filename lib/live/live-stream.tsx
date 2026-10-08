'use client';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { LiveEvent } from '@/shared/events';
import { PHASE_LABEL, type Phase } from '@/shared/phases';
import { useTRPC } from '@/lib/trpc/client';
import { useLiveStatus } from '@/lib/state/live';

/**
 * One SSE subscription per tab (docs/04 §5). Events patch what they can and invalidate the
 * affected query families (debounced), so every open page stays current without polling.
 */
export function LiveStream({ userId }: { userId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const setStatus = useLiveStatus((s) => s.set);
  const pending = useRef(new Map<string, QueryKey>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidate = (key: QueryKey) => {
    pending.current.set(JSON.stringify(key), key);
    timer.current ??= setTimeout(() => {
      for (const k of pending.current.values()) void queryClient.invalidateQueries({ queryKey: k });
      pending.current.clear();
      timer.current = null;
    }, 150);
  };

  const onEvent = (e: LiveEvent) => {
    if (e.type === 'cp.run_request.phase_changed') {
      const to = e.data['to'] as Phase;
      queryClient.setQueryData(trpc.runs.get.queryKey({ id: e.aggregateId }), (old) =>
        old && (e.aggregateVersion ?? 0) >= old.resourceVersion ? { ...old, phase: to, resourceVersion: e.aggregateVersion ?? old.resourceVersion } : old,
      );
    }
    if (e.type.startsWith('cp.run_request.') || e.type.startsWith('cp.run_action.') || e.type.startsWith('cp.approval.')) {
      invalidate(trpc.runs.pathKey());
      invalidate(trpc.approvals.pathKey());
      invalidate(trpc.workflows.pathKey());
    }
    if (e.type.startsWith('cp.github_run.') || e.type.startsWith('cp.github_job.')) {
      invalidate(trpc.githubRuns.pathKey());
      invalidate(trpc.runs.pathKey());
    }
    if (e.type.startsWith('cp.workflow.') || e.type.startsWith('cp.workspace.')) {
      invalidate(trpc.workflows.pathKey());
      invalidate(trpc.workspaces.pathKey());
    }
    if (e.type.startsWith('cp.identity.') || e.type.startsWith('cp.workspace.grant')) invalidate(trpc.me.pathKey());
    if (e.type.startsWith('cp.credential.') || e.type.startsWith('cp.system.')) {
      invalidate(trpc.credentials.pathKey());
      invalidate(trpc.system.pathKey());
    }
  };

  const subscription = useSubscription(
    trpc.live.stream.subscriptionOptions(undefined, {
      onData: (message) => {
        const e = message.data as LiveEvent;
        onEvent(e);
        if (e.type === 'cp.run_request.completed') {
          const cached = queryClient.getQueryData(trpc.runs.get.queryKey({ id: e.aggregateId }));
          if (cached?.requestedBy === userId) {
            const outcome = e.data['outcome'] as Phase;
            toast(`${cached.workflowName}: ${PHASE_LABEL[outcome]}`, { description: cached.environment ?? cached.ref });
          }
        }
      },
    }),
  );

  useEffect(() => {
    const map = { idle: 'offline', connecting: 'reconnecting', pending: 'live', error: 'offline' } as const;
    setStatus(map[subscription.status]);
  }, [subscription.status, setStatus]);

  return null;
}
