'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, PageHeader, SectionTitle } from '@/components/ui/card';
import { FieldHint, Input, Label, Select } from '@/components/ui/input';
import { useTRPC } from '@/lib/trpc/client';
import { timeAgo } from '@/lib/utils';

export function AdminWorkspaces() {
  const trpc = useTRPC();
  const workspaces = useQuery(trpc.workspaces.list.queryOptions());
  return (
    <>
      <PageHeader title="Workspaces" subtitle="Import repositories, then choose who can see and run their workflows." />
      <ImportRepository />
      <SectionTitle className="mt-8">All workspaces</SectionTitle>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-text-muted">
            <tr><th className="p-3">Workspace</th><th>Visibility</th><th>Status</th><th>Updates</th><th>Synced</th><th /></tr>
          </thead>
          <tbody>
            {workspaces.data?.map((w) => (
              <tr key={w.id} className="border-t border-border">
                <td className="p-3"><p className="font-medium">{w.displayName}</p><p className="text-xs text-text-muted">{w.fullName}</p></td>
                <td>{w.visibility}{w.publicRole ? ` (${w.publicRole})` : ''}</td>
                <td>{w.status}{w.statusReason ? <span className="block text-xs text-tone-danger">{w.statusReason}</span> : null}</td>
                <td>{w.updateMode}</td>
                <td className="text-text-muted">{timeAgo(w.lastSyncedAt)}</td>
                <td className="pr-3 text-right"><Link className="text-accent" href={`/admin/workspaces/${w.id}`}>Settings</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function ImportRepository() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState('');
  const [lookupName, setLookupName] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [publicRole, setPublicRole] = useState<'viewer' | 'operator'>('viewer');

  const lookup = useQuery({ ...trpc.workspaces.lookupRepository.queryOptions({ fullName: lookupName ?? 'x/x' }), enabled: Boolean(lookupName) });
  const doImport = useMutation(
    trpc.workspaces.import.mutationOptions({
      onSuccess: () => {
        toast('Imported — syncing workflows');
        setLookupName(null);
        setFullName('');
        setSelected([]);
        void queryClient.invalidateQueries({ queryKey: trpc.workspaces.pathKey() });
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  return (
    <Card className="flex flex-col gap-4">
      <p className="font-medium">Import a repository</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setLookupName(fullName.trim());
        }}
      >
        <Input placeholder="owner/repository" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <Button type="submit" disabled={!/^[^/\s]+\/[^/\s]+$/.test(fullName.trim())}>Check access</Button>
      </form>
      {lookup.isFetching ? <p className="text-sm text-text-muted">Checking with every credential…</p> : null}
      {lookup.error ? <p className="text-sm text-tone-danger">{lookup.error.message}</p> : null}
      {lookup.data ? (
        <div className="flex flex-col gap-4">
          {lookup.data.alreadyImported ? <p className="text-sm text-tone-attention">Already imported.</p> : null}
          {lookup.data.repo ? (
            <p className="text-sm">{lookup.data.repo.fullName} · default branch {lookup.data.repo.defaultBranch}</p>
          ) : (
            <p className="text-sm text-tone-danger">No credential can reach this repository.</p>
          )}
          <div className="flex flex-col gap-1">
            <Label>Credentials to use</Label>
            {lookup.data.access.map((a) => (
              <label key={a.credentialId} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={!a.ok}
                  checked={selected.includes(a.credentialId)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, a.credentialId] : selected.filter((s) => s !== a.credentialId))}
                />
                {a.label}
                <span className="text-xs text-text-muted">{a.ok ? (a.canDispatchHint ? 'can dispatch' : 'read only') : `no access: ${a.error}`}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="vis">Visibility</Label>
              <Select id="vis" value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}>
                <option value="private">Private — only people you grant</option>
                <option value="public">Public — everyone signed in</option>
              </Select>
            </div>
            {visibility === 'public' ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="pr">Everyone can</Label>
                <Select id="pr" value={publicRole} onChange={(e) => setPublicRole(e.target.value as 'viewer' | 'operator')}>
                  <option value="viewer">View</option>
                  <option value="operator">View and run</option>
                </Select>
              </div>
            ) : null}
            <Button
              variant="primary"
              disabled={!lookup.data.repo || lookup.data.alreadyImported || selected.length === 0 || doImport.isPending}
              onClick={() => doImport.mutate({ fullName: lookup.data!.repo!.fullName, credentialIds: selected, visibility, publicRole: visibility === 'public' ? publicRole : undefined })}
            >
              Import & sync
            </Button>
          </div>
          <FieldHint>After import, expose workflows and grant access in the workspace settings.</FieldHint>
        </div>
      ) : null}
    </Card>
  );
}
