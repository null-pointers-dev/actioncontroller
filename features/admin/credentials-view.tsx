'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, PageHeader, SectionTitle } from '@/components/ui/card';
import { FieldHint, Input, Label, Select } from '@/components/ui/input';
import { useTRPC } from '@/lib/trpc/client';
import { cn, timeAgo } from '@/lib/utils';

export function CredentialsView() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const list = useQuery(trpc.credentials.list.queryOptions());
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: trpc.credentials.pathKey() });
  const onError = (err: { message: string }) => toast.error(err.message);
  const setStatus = useMutation(trpc.credentials.setStatus.mutationOptions({ onSuccess: invalidate, onError }));
  const revalidate = useMutation(trpc.credentials.revalidate.mutationOptions({ onSuccess: () => { toast('Re-validated'); invalidate(); }, onError }));

  return (
    <>
      <PageHeader title="GitHub credentials" subtitle="A pool of tokens. Limits are per GitHub account: tokens of the same account share one budget." />
      <AddCredential onAdded={invalidate} />
      <SectionTitle className="mt-8">Pool</SectionTitle>
      <div className="flex flex-col gap-2">
        {list.data?.map((c) => {
          const b = c.bucket;
          const pct = b?.limitTotal && b.remaining !== null ? Math.round((b.remaining / b.limitTotal) * 100) : null;
          const expiringSoon = c.expiresAt && new Date(c.expiresAt).getTime() - Date.now() < 14 * 86400_000;
          return (
            <Card key={c.id} className="flex flex-wrap items-center gap-4">
              <div className="min-w-56 flex-1">
                <p className="font-medium">{c.label} <span className="text-xs text-text-muted">· {c.kind.replaceAll('_', ' ')}</span></p>
                <p className="text-xs text-text-muted">
                  {c.accountLogin ? `@${c.accountLogin} · ` : ''}{c.rateBucket} · {c.dispatchWorkspaces}/{c.workspaces} workspaces can dispatch · secret in {c.secretSource}
                </p>
                {c.lastError ? <p className="text-xs text-tone-danger">{c.lastError}</p> : null}
              </div>
              <div className="w-40">
                <div className="h-1.5 rounded bg-surface-muted">
                  <div className={cn('h-1.5 rounded', (pct ?? 100) < 10 ? 'bg-tone-danger' : 'bg-tone-success')} style={{ width: `${pct ?? 100}%` }} />
                </div>
                <p className="mt-1 text-xs text-text-muted">{b?.remaining ?? '?'} / {b?.limitTotal ?? '?'} · resets {timeAgo(b?.resetsAt)}</p>
              </div>
              <p className={cn('w-36 text-xs', expiringSoon ? 'text-tone-attention' : 'text-text-muted')}>
                {c.expiresAt ? `expires ${timeAgo(c.expiresAt)}` : 'no expiry'}
              </p>
              <span className={cn('text-sm', c.status === 'active' ? 'text-tone-success' : 'text-tone-danger')}>{c.status}</span>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => revalidate.mutate({ id: c.id })}>Re-validate</Button>
                {c.status === 'active' ? (
                  <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: c.id, status: 'disabled' })}>Disable</Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: c.id, status: 'active' })}>Enable</Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function AddCredential({ onAdded }: { onAdded: () => void }) {
  const trpc = useTRPC();
  const [form, setForm] = useState({ label: '', kind: 'fine_grained_pat' as 'fine_grained_pat' | 'classic_pat' | 'github_app', secret: '', appId: '', installationId: '', priority: '100' });
  const add = useMutation(
    trpc.credentials.add.mutationOptions({
      onSuccess: () => {
        toast('Credential added');
        setForm({ ...form, label: '', secret: '' });
        onAdded();
      },
      onError: (err) => toast.error(err.message),
    }),
  );
  return (
    <Card>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({
            label: form.label,
            kind: form.kind,
            secret: form.secret,
            appId: form.kind === 'github_app' ? Number(form.appId) : undefined,
            installationId: form.kind === 'github_app' ? Number(form.installationId) : undefined,
            priority: Number(form.priority),
          });
        }}
      >
        <div className="flex flex-col gap-1"><Label>Label</Label><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="release-bot #1" /></div>
        <div className="flex flex-col gap-1">
          <Label>Kind</Label>
          <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}>
            <option value="fine_grained_pat">Fine-grained PAT</option>
            <option value="classic_pat">Classic PAT</option>
            <option value="github_app">GitHub App installation</option>
          </Select>
        </div>
        <div className="flex min-w-72 flex-1 flex-col gap-1">
          <Label>{form.kind === 'github_app' ? 'Private key (PEM) or env:NAME' : 'Token or env:NAME'}</Label>
          <Input type="password" autoComplete="off" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
        </div>
        {form.kind === 'github_app' ? (
          <>
            <div className="flex w-28 flex-col gap-1"><Label>App id</Label><Input value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} /></div>
            <div className="flex w-36 flex-col gap-1"><Label>Installation id</Label><Input value={form.installationId} onChange={(e) => setForm({ ...form, installationId: e.target.value })} /></div>
          </>
        ) : null}
        <div className="flex w-24 flex-col gap-1"><Label>Priority</Label><Input value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} /></div>
        <Button type="submit" variant="primary" disabled={!form.label || !form.secret || add.isPending}>Add</Button>
        <FieldHint>
          The secret is written to Key Vault and never shown again. Locally, use a reference like env:GITHUB_TOKEN_1.
        </FieldHint>
      </form>
    </Card>
  );
}
