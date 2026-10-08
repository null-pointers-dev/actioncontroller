'use client';
import { useQuery } from '@tanstack/react-query';
import { Globe, Lock } from 'lucide-react';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/client';

export function WorkspacesView() {
  const trpc = useTRPC();
  const { data, isPending } = useQuery(trpc.workspaces.list.queryOptions());
  return (
    <>
      <PageHeader title="Workspaces" subtitle="Repositories you can see. Each one is a workspace of runnable workflows." />
      {!isPending && !data?.length ? (
        <EmptyState title="No workspaces yet">An admin imports repositories and shares them with you.</EmptyState>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map((w) => (
          <Link key={w.id} href={`/w/${w.id}`}>
            <Card className="flex h-full flex-col gap-2 hover:bg-surface-muted">
              <div className="flex items-center justify-between">
                <p className="font-medium">{w.displayName}</p>
                {w.visibility === 'public' ? (
                  <Badge><Globe className="size-3" />Public</Badge>
                ) : (
                  <Badge><Lock className="size-3" />Private</Badge>
                )}
              </div>
              <p className="text-xs text-text-muted">{w.fullName}</p>
              <p className="mt-auto text-xs text-text-muted">
                {w.exposedWorkflows ?? 0} workflows · you: {w.capabilities?.isAdmin ? 'admin' : (w.capabilities?.role ?? '—')}
                {w.status !== 'active' ? ` · ${w.status}` : ''}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
