'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, PageHeader, SectionTitle } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/client';
import { timeAgo } from '@/lib/utils';

export function SystemView() {
  const trpc = useTRPC();
  const status = useQuery({ ...trpc.system.status.queryOptions(), refetchInterval: 10_000 });
  const s = status.data;
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="System" subtitle="Queues, webhooks, drift and sync health." />
      <section>
        <SectionTitle>Queues</SectionTitle>
        <Card className="grid gap-2 text-sm sm:grid-cols-3">
          {s?.queues.length ? s.queues.map((q) => (
            <div key={q.queue}>
              <p className="font-medium">{q.queue}</p>
              <p className="text-text-muted">{q.depth} waiting · {q.locked} in progress · oldest {q.oldest_seconds ?? 0}s</p>
            </div>
          )) : <p className="text-text-muted">All queues empty.</p>}
        </Card>
      </section>
      <section>
        <SectionTitle>Webhooks (24 h) · drift</SectionTitle>
        <Card className="flex flex-wrap gap-6 text-sm">
          {s?.deliveries.map((d) => <span key={d.status}>{d.status}: <strong>{d.n}</strong></span>)}
          <span>Drift corrections last hour: <strong>{s?.driftCorrectionsLastHour ?? 0}</strong></span>
        </Card>
      </section>
      <section>
        <SectionTitle>Workspaces</SectionTitle>
        <Card className="flex flex-col gap-1 text-sm">
          {s?.workspaces.map((w) => (
            <p key={w.id}>
              <strong>{w.display_name}</strong> · {w.status} · {w.update_mode} · synced {timeAgo(w.last_synced_at)}
              {w.status_reason ? <span className="text-tone-danger"> · {w.status_reason}</span> : null}
            </p>
          ))}
        </Card>
      </section>
    </div>
  );
}
