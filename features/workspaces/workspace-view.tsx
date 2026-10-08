'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import type { Phase } from '@/shared/phases';
import { GithubStatus, StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader, SectionTitle } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/client';
import { cn, timeAgo } from '@/lib/utils';
import { RunRow } from '@/features/runs/run-row';

const TABS = ['workflows', 'requests', 'github'] as const;

export function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const trpc = useTRPC();
  const [tab, setTab] = useQueryState('tab', parseAsStringLiteral(TABS).withDefault('workflows'));
  const ws = useQuery(trpc.workspaces.get.queryOptions({ workspaceId }));

  return (
    <>
      <PageHeader
        title={ws.data?.displayName ?? 'Workspace'}
        subtitle={ws.data ? `${ws.data.fullName} · ${ws.data.visibility}${ws.data.publicRole ? ` (${ws.data.publicRole})` : ''}` : undefined}
        actions={
          ws.data?.capabilities?.isAdmin ? (
            <Link href={`/admin/workspaces/${workspaceId}`}><Button size="sm">Settings</Button></Link>
          ) : null
        }
      />
      <div role="tablist" className="mb-6 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => void setTab(t)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', tab === t ? 'border-accent font-medium' : 'border-transparent text-text-muted')}
          >
            {t === 'workflows' ? 'Workflows' : t === 'requests' ? 'Requests' : 'All GitHub runs'}
          </button>
        ))}
      </div>
      {tab === 'workflows' ? <WorkflowGrid workspaceId={workspaceId} /> : null}
      {tab === 'requests' ? <Requests workspaceId={workspaceId} /> : null}
      {tab === 'github' ? <GithubRuns workspaceId={workspaceId} /> : null}
    </>
  );
}

function WorkflowGrid({ workspaceId }: { workspaceId: string }) {
  const trpc = useTRPC();
  const { data, isPending } = useQuery(trpc.workflows.list.queryOptions({ workspaceId }));
  if (!isPending && !data?.length) {
    return <EmptyState title="No workflows exposed yet">Admins choose which workflows appear here in Settings.</EmptyState>;
  }
  const groups = new Map<string, NonNullable<typeof data>>();
  for (const wf of data ?? []) {
    const key = wf.category ?? 'Workflows';
    groups.set(key, [...(groups.get(key) ?? []), wf]);
  }
  return (
    <div className="flex flex-col gap-8">
      {[...groups.entries()].map(([category, items]) => (
        <section key={category}>
          <SectionTitle>{category}</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((wf) => (
              <Card key={wf.id} className={cn('flex flex-col gap-2', !wf.exposed && 'opacity-60')}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{wf.displayName}</p>
                  {!wf.exposed ? <span className="text-xs text-text-muted">hidden</span> : null}
                </div>
                {wf.description ? <p className="text-sm text-text-muted">{wf.description}</p> : null}
                <p className="text-xs text-text-muted">
                  {wf.lastRun ? <>last: <StatusBadge phase={wf.lastRun.phase as Phase} className="text-xs" /> · {timeAgo(wf.lastRun.createdAt)}</> : 'never run'}
                  {wf.approvalRequired ? ' · approval 🔒' : ''}
                </p>
                <div className="mt-auto flex justify-end">
                  {wf.capabilities.role === 'operator' && wf.ghState === 'active' ? (
                    <Link href={`/w/${workspaceId}/run/${wf.id}`}><Button size="sm" variant="primary">Run</Button></Link>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Requests({ workspaceId }: { workspaceId: string }) {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.runs.list.queryOptions({ scope: 'all', workspaceId, limit: 50 }));
  if (!data?.items.length) return <EmptyState title="No requests yet" />;
  return <Card className="p-1">{data.items.map((r) => <RunRow key={r.id} run={r} showRequester />)}</Card>;
}

function GithubRuns({ workspaceId }: { workspaceId: string }) {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.githubRuns.list.queryOptions({ workspaceId, limit: 50 }));
  if (!data?.length) return <EmptyState title="No runs observed yet" />;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-text-muted">
          <tr><th className="p-3">Run</th><th>Branch</th><th>Actor</th><th>Event</th><th>Status</th><th>Started</th></tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={`${r.runId}-${r.runAttempt}`} className="border-t border-border">
              <td className="p-3">
                {r.runRequestId ? <Link className="text-accent" href={`/runs/${r.runRequestId}`}>{r.displayTitle}</Link> : r.displayTitle}
                <span className="text-text-muted"> #{r.runId}{r.runAttempt > 1 ? ` (attempt ${r.runAttempt})` : ''}</span>
              </td>
              <td>{r.headBranch}</td>
              <td>{r.actorLogin}</td>
              <td>{r.event}</td>
              <td><GithubStatus status={r.status} conclusion={r.conclusion} /></td>
              <td className="text-text-muted">{timeAgo(r.ghCreatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
