'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, PageHeader, SectionTitle } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/input';
import { useTRPC } from '@/lib/trpc/client';

export function WorkspaceSettings({ workspaceId }: { workspaceId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ws = useQuery(trpc.workspaces.get.queryOptions({ workspaceId }));
  const refresh = () => void queryClient.invalidateQueries();
  const onError = (err: { message: string }) => toast.error(err.message);

  const update = useMutation(trpc.workspaces.update.mutationOptions({ onSuccess: () => { toast('Saved'); refresh(); }, onError }));
  const sync = useMutation(trpc.workspaces.sync.mutationOptions({ onSuccess: () => toast('Sync queued'), onError }));

  if (!ws.data) return <p className="text-sm text-text-muted">Loading…</p>;
  const w = ws.data;
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={`${w.displayName} · settings`}
        subtitle={`${w.fullName} · ${w.status} · updates via ${w.updateMode}`}
        actions={<Button size="sm" onClick={() => sync.mutate({ workspaceId })}>Sync now</Button>}
      />

      <section>
        <SectionTitle>Visibility</SectionTitle>
        <Card className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="v">Who can see this workspace</Label>
            <Select
              id="v"
              value={w.visibility === 'public' ? `public:${w.publicRole}` : 'private'}
              onChange={(e) => {
                const [visibility, publicRole] = e.target.value.split(':') as ['private' | 'public', 'viewer' | 'operator' | undefined];
                update.mutate({ workspaceId, expectedVersion: w.resourceVersion, visibility, publicRole: publicRole ?? null });
              }}
            >
              <option value="private">Private — only granted people and groups</option>
              <option value="public:viewer">Public — everyone can view</option>
              <option value="public:operator">Public — everyone can view and run</option>
            </Select>
          </div>
        </Card>
      </section>

      <Grants workspaceId={workspaceId} onError={onError} />
      <Workflows workspaceId={workspaceId} onError={onError} />
    </div>
  );
}

function Grants({ workspaceId, onError }: { workspaceId: string; onError: (e: { message: string }) => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const grants = useQuery(trpc.workspaces.grants.list.queryOptions({ workspaceId }));
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: trpc.workspaces.grants.list.queryKey({ workspaceId }) });
  const add = useMutation(trpc.workspaces.grants.add.mutationOptions({ onSuccess: invalidate, onError }));
  const remove = useMutation(trpc.workspaces.grants.remove.mutationOptions({ onSuccess: invalidate, onError }));
  const [form, setForm] = useState({ subjectType: 'user' as 'user' | 'group', subject: '', groupName: '', role: 'operator' as 'viewer' | 'operator', canApprove: false, environments: '' });

  return (
    <section>
      <SectionTitle>Access</SectionTitle>
      <Card className="flex flex-col gap-4">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-text-muted"><tr><th>Who</th><th>Role</th><th>Approver</th><th>Environments</th><th /></tr></thead>
          <tbody>
            {grants.data?.map((g) => (
              <tr key={g.id} className="border-t border-border">
                <td className="py-2">{g.subjectName} <span className="text-xs text-text-muted">({g.subjectType})</span></td>
                <td>{g.role}</td>
                <td>{g.canApprove ? 'yes' : ''}</td>
                <td>{g.environments?.join(', ') ?? 'any'}</td>
                <td className="text-right"><Button size="sm" variant="ghost" onClick={() => remove.mutate({ grantId: g.id })}>Remove</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({
              workspaceId,
              subjectType: form.subjectType,
              subject: form.subject.trim(),
              groupDisplayName: form.subjectType === 'group' ? form.groupName || undefined : undefined,
              role: form.role,
              canApprove: form.canApprove,
              environments: form.environments.trim() ? form.environments.split(',').map((s) => s.trim()).filter(Boolean) : null,
              expiresAt: null,
            });
          }}
        >
          <Select value={form.subjectType} onChange={(e) => setForm({ ...form, subjectType: e.target.value as 'user' | 'group' })} className="w-28">
            <option value="user">User</option>
            <option value="group">Entra group</option>
          </Select>
          <Input className="w-64" placeholder={form.subjectType === 'user' ? 'email@company.com' : 'Group object id'} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          {form.subjectType === 'group' ? <Input className="w-40" placeholder="Display name" value={form.groupName} onChange={(e) => setForm({ ...form, groupName: e.target.value })} /> : null}
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'viewer' | 'operator' })} className="w-32">
            <option value="viewer">Viewer</option>
            <option value="operator">Operator</option>
          </Select>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={form.canApprove} onChange={(e) => setForm({ ...form, canApprove: e.target.checked })} />Can approve</label>
          <Input className="w-48" placeholder="Environments (optional)" value={form.environments} onChange={(e) => setForm({ ...form, environments: e.target.value })} />
          <Button type="submit" variant="primary" disabled={!form.subject || add.isPending}>Add</Button>
        </form>
      </Card>
    </section>
  );
}

function Workflows({ workspaceId, onError }: { workspaceId: string; onError: (e: { message: string }) => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const list = useQuery(trpc.workflows.list.queryOptions({ workspaceId }));
  const update = useMutation(
    trpc.workflows.update.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: trpc.workflows.list.queryKey({ workspaceId }) }),
      onError,
    }),
  );

  return (
    <section>
      <SectionTitle>Workflows</SectionTitle>
      <div className="flex flex-col gap-3">
        {list.data?.map((wf) => (
          <Card key={wf.id} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{wf.displayName}</p>
                <p className="text-xs text-text-muted">{wf.path} · {wf.ghState}</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={wf.exposed} onChange={(e) => update.mutate({ workflowId: wf.id, expectedVersion: wf.resourceVersion, exposed: e.target.checked })} />
                Exposed
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextSetting label="Display name" value={wf.displayName} onSave={(v) => update.mutate({ workflowId: wf.id, expectedVersion: wf.resourceVersion, displayName: v || null })} />
              <TextSetting label="Category" value={wf.category ?? ''} onSave={(v) => update.mutate({ workflowId: wf.id, expectedVersion: wf.resourceVersion, category: v || null })} />
              <TextSetting label="Description" value={wf.description ?? ''} onSave={(v) => update.mutate({ workflowId: wf.id, expectedVersion: wf.resourceVersion, description: v || null })} />
              <TextSetting
                label="Allowed refs (comma separated, e.g. main, release/*)"
                value={wf.allowedRefPatterns?.join(', ') ?? ''}
                onSave={(v) => update.mutate({ workflowId: wf.id, expectedVersion: wf.resourceVersion, allowedRefPatterns: v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={wf.approvalRequired} onChange={(e) => update.mutate({ workflowId: wf.id, expectedVersion: wf.resourceVersion, approvalRequired: e.target.checked })} />
                Requires approval
              </label>
              {wf.approvalRequired ? (
                <TextSetting
                  inline
                  label="only for environments"
                  value={wf.approvalEnvironments?.join(', ') ?? ''}
                  onSave={(v) => update.mutate({ workflowId: wf.id, expectedVersion: wf.resourceVersion, approvalEnvironments: v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null })}
                />
              ) : null}
              <label className="flex items-center gap-2">
                One at a time:
                <Select
                  className="h-8 w-56"
                  value={wf.concurrencyScope}
                  onChange={(e) => update.mutate({ workflowId: wf.id, expectedVersion: wf.resourceVersion, concurrencyScope: e.target.value as 'none' | 'workflow' | 'workflow_environment' })}
                >
                  <option value="none">No limit</option>
                  <option value="workflow">Per workflow</option>
                  <option value="workflow_environment">Per workflow + environment</option>
                </Select>
              </label>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

function TextSetting({ label, value, onSave, inline }: { label: string; value: string; onSave: (v: string) => void; inline?: boolean }) {
  const [v, setV] = useState(value);
  return (
    <div className={inline ? 'flex items-center gap-2' : 'flex flex-col gap-1'}>
      <Label className="text-xs text-text-muted">{label}</Label>
      <Input className={inline ? 'h-8 w-48' : 'h-8'} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v.trim())} />
    </div>
  );
}
