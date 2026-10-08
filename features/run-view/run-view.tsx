'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Phase } from '@/shared/phases';
import { GithubStatus, StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, SectionTitle } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/client';
import { cn, duration, newIdempotencyKey, timeAgo } from '@/lib/utils';
import { LogPanel } from './log-panel';

const STEPS: { label: string; reached: (p: Phase) => boolean }[] = [
  { label: 'Requested', reached: () => true },
  { label: 'Approved', reached: (p) => !['awaiting_approval', 'pending'].includes(p) },
  { label: 'Sent', reached: (p) => ['dispatched', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(p) },
  { label: 'Running', reached: (p) => ['running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(p) },
  { label: 'Done', reached: (p) => ['succeeded', 'failed', 'cancelled', 'rejected', 'lost'].includes(p) },
];

export function RunView({ id }: { id: string }) {
  const trpc = useTRPC();
  const run = useQuery(trpc.runs.get.queryOptions({ id }));
  const gh = run.data?.githubRun;
  const jobs = useQuery({
    ...trpc.githubRuns.jobs.queryOptions({ runId: gh?.runId ?? 0, attempt: gh?.attempt ?? 1 }),
    enabled: Boolean(gh),
  });
  const timeline = useQuery(trpc.runs.timeline.queryOptions({ id }));
  const [logJob, setLogJob] = useState<{ id: number; name: string } | null>(null);
  const [actionKey] = useState(newIdempotencyKey);

  const cancel = useMutation(trpc.runs.cancel.mutationOptions({ onSuccess: () => toast('Cancellation requested') }));
  const action = useMutation(trpc.runs.action.mutationOptions({ onSuccess: () => toast('Re-run requested') }));

  if (run.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (run.error) return <p className="text-sm text-tone-danger">{run.error.message}</p>;
  const r = run.data;
  const failedJob = jobs.data?.jobs.find((j) => j.conclusion === 'failure');
  const failedStep = failedJob?.steps.find((s) => s.conclusion === 'failure');
  const showSteps = r.approval || r.phase !== 'pending';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">
            {r.workflowName}
            {r.environment ? <span className="text-text-muted"> → {r.environment}</span> : null}
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            {r.requesterName} · {timeAgo(r.createdAt)} · {r.ref} · {r.workspaceName}
          </p>
          <div className="mt-2"><StatusBadge phase={r.phase} reason={r.phaseReason} /></div>
          {r.phaseMessage ? <p className="mt-1 text-sm text-text-muted">{r.phaseMessage}</p> : null}
        </div>
        <div className="flex gap-2">
          {r.can.rerun && gh ? (
            <>
              <Button size="sm" onClick={() => action.mutate({ runId: gh.runId, attempt: gh.attempt, action: 'rerun_failed', idempotencyKey: `${actionKey}-f` })}>
                Re-run failed
              </Button>
              <Button size="sm" onClick={() => action.mutate({ runId: gh.runId, attempt: gh.attempt, action: 'rerun_all', idempotencyKey: `${actionKey}-a` })}>
                Re-run all
              </Button>
            </>
          ) : null}
          {r.can.cancel ? (
            <Button size="sm" variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate({ id })}>Cancel</Button>
          ) : null}
        </div>
      </div>

      {showSteps ? (
        <ol className="flex flex-wrap items-center gap-2 text-sm">
          {STEPS.filter((s) => s.label !== 'Approved' || r.approval).map((s, i, arr) => (
            <li key={s.label} className="flex items-center gap-2">
              <span className={cn('rounded-full px-2 py-0.5', s.reached(r.phase) ? 'bg-accent/15 font-medium' : 'text-text-muted')}>{s.label}</span>
              {i < arr.length - 1 ? <span className="text-text-muted">—</span> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {failedJob ? (
        <Card className="border-tone-danger/40">
          <p className="text-sm font-medium text-tone-danger">
            Failed in {failedJob.name}{failedStep ? ` › ${failedStep.name}` : ''}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => setLogJob({ id: failedJob.id, name: failedJob.name })}>Show log</Button>
            {failedJob.htmlUrl ? (
              <a href={failedJob.htmlUrl} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost">Open in GitHub <ExternalLink className="size-3" /></Button></a>
            ) : null}
          </div>
        </Card>
      ) : null}

      {gh ? (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <SectionTitle className="mb-0">GitHub run #{gh.runId}{gh.attempt > 1 ? ` · attempt ${gh.attempt}` : ''}</SectionTitle>
            <span className="text-xs text-text-muted">
              confirmed {timeAgo(gh.lastSeenAt)} via {gh.lastSeenVia}
              {gh.htmlUrl ? <> · <a className="text-accent" href={gh.htmlUrl} target="_blank" rel="noreferrer">Open in GitHub ↗</a></> : null}
            </span>
          </div>
          <Card className="flex flex-col gap-3">
            {jobs.data?.jobs.length ? null : <p className="text-sm text-text-muted">Waiting for jobs…</p>}
            {jobs.data?.jobs.map((job) => (
              <div key={job.id}>
                <div className="flex items-center justify-between gap-3">
                  <button className="text-left text-sm font-medium hover:underline" onClick={() => setLogJob({ id: job.id, name: job.name })}>
                    {job.name}
                  </button>
                  <span className="flex items-center gap-3 text-xs text-text-muted">
                    {duration(job.startedAt, job.completedAt)}
                    <GithubStatus status={job.status} conclusion={job.conclusion} />
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                  {job.steps.map((s) => (
                    <span key={s.number} className={cn(s.conclusion === 'failure' && 'font-medium text-tone-danger', s.status === 'in_progress' && 'text-tone-progress')}>
                      {s.conclusion === 'success' ? '✔' : s.conclusion === 'failure' ? '✖' : s.status === 'in_progress' ? '◉' : '○'} {s.name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {logJob ? <LogPanel jobId={logJob.id} title={logJob.name} onClose={() => setLogJob(null)} /> : null}

      {r.approval ? (
        <section>
          <SectionTitle>Approval</SectionTitle>
          <Card className="text-sm">
            <p>{r.approval.state} · {r.approval.decisions.filter((d) => d.decision === 'approve').length}/{r.approval.minApprovals} approvals · expires {timeAgo(r.approval.expiresAt)}</p>
            {r.approval.decisions.map((d) => (
              <p key={d.approverId} className="text-text-muted">{d.approverName}: {d.decision}{d.comment ? ` — “${d.comment}”` : ''}</p>
            ))}
          </Card>
        </section>
      ) : null}

      <section>
        <SectionTitle>Inputs</SectionTitle>
        <Card className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          {Object.entries(r.inputs).map(([k, v]) => (
            <div key={k} className="contents"><span className="text-text-muted">{k}</span><span className="font-mono">{String(v)}</span></div>
          ))}
        </Card>
      </section>

      <section>
        <SectionTitle>Timeline</SectionTitle>
        <Card className="flex flex-col gap-1 text-sm">
          {timeline.data?.map((e) => (
            <p key={e.id}>
              <span className="font-mono text-xs text-text-muted">{new Date(e.time).toLocaleTimeString()}</span>{' '}
              {describe(e.type, e.data, e.actor)}
            </p>
          ))}
        </Card>
      </section>
    </div>
  );
}

function describe(type: string, data: Record<string, unknown>, actor: string): string {
  switch (type) {
    case 'cp.run_request.created': return `${actor} requested the run`;
    case 'cp.run_request.phase_changed': return `${String(data['from'])} → ${String(data['to'])}${data['reason'] ? ` (${String(data['reason'])})` : ''}`;
    case 'cp.run_request.cancel_requested': return `${actor} asked to cancel`;
    case 'cp.run_request.completed': return `Finished: ${String(data['outcome'])}`;
    case 'cp.approval.requested': return 'Approval required';
    case 'cp.approval.decision_recorded': return `${actor} ${data['decision'] === 'approve' ? 'approved' : 'denied'}${data['comment'] ? `: “${String(data['comment'])}”` : ''}`;
    case 'cp.approval.approved': return 'Approved';
    case 'cp.approval.denied': return 'Denied';
    case 'cp.approval.expired': return 'Approval expired';
    case 'cp.github_run.observed': return `GitHub run #${String(data['runId'])} appeared`;
    case 'cp.github_run.status_changed': return `GitHub: ${String(data['status'])}${data['conclusion'] ? ` (${String(data['conclusion'])})` : ''}`;
    case 'cp.run_action.created': return `${actor} requested ${String(data['action']).replace('_', ' ')}`;
    default: return type.replace('cp.', '');
  }
}
