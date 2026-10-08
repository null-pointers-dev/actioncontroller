'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { parseAsBoolean, parseAsStringLiteral, useQueryState } from 'nuqs';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/client';
import { cn } from '@/lib/utils';
import { RunRow } from './run-row';

export function RunsList() {
  const trpc = useTRPC();
  const [scope, setScope] = useQueryState('scope', parseAsStringLiteral(['mine', 'all'] as const).withDefault('mine'));
  const [active, setActive] = useQueryState('active', parseAsBoolean);
  const query = useInfiniteQuery(
    trpc.runs.list.infiniteQueryOptions(
      { scope, active: active ?? undefined, limit: 30 },
      { getNextPageParam: (last) => last.nextCursor },
    ),
  );
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Runs"
        actions={
          <>
            {(['mine', 'all'] as const).map((s) => (
              <Button key={s} size="sm" variant={scope === s ? 'primary' : 'secondary'} onClick={() => void setScope(s)}>
                {s === 'mine' ? 'Mine' : 'Everyone'}
              </Button>
            ))}
            <Button size="sm" className={cn(active && 'border-accent')} onClick={() => void setActive(active ? null : true)}>
              Active only
            </Button>
          </>
        }
      />
      {!query.isPending && items.length === 0 ? <EmptyState title="No runs match" /> : null}
      {items.length ? <Card className="p-1">{items.map((r) => <RunRow key={r.id} run={r} showRequester={scope === 'all'} />)}</Card> : null}
      {query.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>Load more</Button>
        </div>
      ) : null}
    </>
  );
}
