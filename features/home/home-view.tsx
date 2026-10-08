'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, EmptyState, SectionTitle } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/client';
import { RunRow } from '@/features/runs/run-row';

export function HomeView({ firstName }: { firstName: string }) {
  const trpc = useTRPC();
  const running = useQuery(trpc.runs.list.queryOptions({ scope: 'mine', active: true, limit: 10 }));
  const recent = useQuery(trpc.runs.list.queryOptions({ scope: 'mine', active: false, limit: 8 }));
  const approvals = useQuery(trpc.approvals.inbox.queryOptions({ mode: 'waiting' }));
  const workspaces = useQuery(trpc.workspaces.list.queryOptions());

  // Quick run: the workflows you ran last, pre-filled with your last inputs.
  const quick = new Map<number, { workflowId: number; workspaceId: string; name: string; runId: string }>();
  for (const r of [...(running.data?.items ?? []), ...(recent.data?.items ?? [])]) {
    if (!quick.has(r.workflowId)) quick.set(r.workflowId, { workflowId: r.workflowId, workspaceId: r.workspaceId, name: r.workflowName, runId: r.id });
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Hello, {firstName}</h1>

      {approvals.data && approvals.data.length > 0 ? (
        <section>
          <SectionTitle>Needs you</SectionTitle>
          <Card className="flex flex-col gap-2">
            {approvals.data.slice(0, 5).map((a) => (
              <Link key={a.runRequestId} href="/approvals" className="flex items-center justify-between text-sm hover:underline">
                <span>
                  {a.requester} wants to run <strong>{a.workflowName}</strong>
                  {a.environment ? ` in ${a.environment}` : ''}
                </span>
                <span className="text-accent">Review</span>
              </Link>
            ))}
          </Card>
        </section>
      ) : null}

      <section>
        <SectionTitle>Running now</SectionTitle>
        {running.data?.items.length ? (
          <Card className="p-1">{running.data.items.map((r) => <RunRow key={r.id} run={r} />)}</Card>
        ) : (
          <p className="text-sm text-text-muted">Nothing running.</p>
        )}
      </section>

      {quick.size > 0 ? (
        <section>
          <SectionTitle>Quick run</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {[...quick.values()].slice(0, 6).map((q) => (
              <Link
                key={q.workflowId}
                href={`/w/${q.workspaceId}/run/${q.workflowId}?from=${q.runId}`}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-muted"
              >
                {q.name} ↻
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <SectionTitle>Recent</SectionTitle>
        {recent.data?.items.length ? (
          <Card className="p-1">{recent.data.items.map((r) => <RunRow key={r.id} run={r} />)}</Card>
        ) : (
          <EmptyState title="No runs yet">
            Pick a workflow in a <Link className="text-accent" href="/w">workspace</Link> to get started.
          </EmptyState>
        )}
      </section>

      {workspaces.data?.length ? (
        <section>
          <SectionTitle>Your workspaces</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.data.slice(0, 6).map((w) => (
              <Link key={w.id} href={`/w/${w.id}`}>
                <Card className="hover:bg-surface-muted">
                  <p className="font-medium">{w.displayName}</p>
                  <p className="text-xs text-text-muted">{w.fullName} · {w.exposedWorkflows ?? 0} workflows</p>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
