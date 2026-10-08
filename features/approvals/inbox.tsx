'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useTRPC } from '@/lib/trpc/client';
import { timeAgo } from '@/lib/utils';

export function ApprovalsInbox() {
  const trpc = useTRPC();
  const [mode, setMode] = useQueryState('mode', parseAsStringLiteral(['waiting', 'all'] as const).withDefault('waiting'));
  const inbox = useQuery(trpc.approvals.inbox.queryOptions({ mode }));
  const [comments, setComments] = useState<Record<string, string>>({});
  const decide = useMutation(
    trpc.approvals.decide.mutationOptions({
      onSuccess: (res) => toast(res.state === 'pending' ? `Recorded (${res.approvals}/${res.required})` : `Request ${res.state}`),
      onError: (err) => toast.error(err.message),
    }),
  );

  return (
    <>
      <PageHeader
        title="Approvals"
        actions={(['waiting', 'all'] as const).map((m) => (
          <Button key={m} size="sm" variant={mode === m ? 'primary' : 'secondary'} onClick={() => void setMode(m)}>
            {m === 'waiting' ? 'Waiting for me' : 'All'}
          </Button>
        ))}
      />
      {!inbox.isPending && !inbox.data?.length ? <EmptyState title="Nothing waiting for you" /> : null}
      <div className="flex flex-col gap-3">
        {inbox.data?.map((a) => (
          <Card key={a.runRequestId} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <Link href={`/runs/${a.runRequestId}`} className="font-medium hover:underline">
                  {a.requester} → {a.workflowName}{a.environment ? ` · ${a.environment}` : ''}
                </Link>
                <p className="text-xs text-text-muted">
                  {a.workspaceName} · {a.ref} · {a.votes.filter((v) => v.decision === 'approve').length}/{a.minApprovals} approvals · {a.state === 'pending' ? `expires ${timeAgo(a.expiresAt)}` : a.state}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-[max-content_1fr] gap-x-6 text-sm">
              {Object.entries(a.inputs).map(([k, v]) => (
                <div key={k} className="contents"><span className="text-text-muted">{k}</span><span className="font-mono">{String(v)}</span></div>
              ))}
            </div>
            {a.canDecide ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="max-w-md flex-1"
                  placeholder="Comment (optional)"
                  value={comments[a.runRequestId] ?? ''}
                  onChange={(e) => setComments({ ...comments, [a.runRequestId]: e.target.value })}
                />
                <Button variant="danger" size="sm" disabled={decide.isPending}
                  onClick={() => decide.mutate({ runRequestId: a.runRequestId, decision: 'deny', comment: comments[a.runRequestId] })}>Deny</Button>
                <Button variant="primary" size="sm" disabled={decide.isPending}
                  onClick={() => decide.mutate({ runRequestId: a.runRequestId, decision: 'approve', comment: comments[a.runRequestId] })}>Approve</Button>
              </div>
            ) : a.isMine ? <p className="text-xs text-text-muted">Your request — someone else must approve it.</p> : null}
          </Card>
        ))}
      </div>
    </>
  );
}
