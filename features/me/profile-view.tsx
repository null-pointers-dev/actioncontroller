'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/card';
import { FieldHint, Input, Label } from '@/components/ui/input';
import { useTRPC } from '@/lib/trpc/client';

export function ProfileView() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const [username, setUsername] = useState('');
  const save = useMutation(
    trpc.me.setGithubUsername.mutationOptions({
      onSuccess: (res) => {
        toast(`Linked @${res.login}`);
        void queryClient.invalidateQueries({ queryKey: trpc.me.pathKey() });
      },
      onError: (err) => toast.error(err.message),
    }),
  );
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Profile" subtitle={me.data ? `${me.data.name} · ${me.data.email} · ${me.data.role}` : undefined} />
      <Card className="flex flex-col gap-3">
        <p className="text-sm">
          GitHub username:{' '}
          {me.data?.githubLogin ? <strong>@{me.data.githubLogin}</strong> : <span className="text-text-muted">not linked</span>}
          {me.data?.githubIdentitySource ? <span className="text-text-muted"> ({me.data.githubIdentitySource.replace('_', ' ')})</span> : null}
        </p>
        {me.data?.githubIdentitySource !== 'saml' ? (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({ username });
            }}
          >
            <Label htmlFor="gh">Set your GitHub username</Label>
            <div className="flex gap-2">
              <Input id="gh" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="octocat" />
              <Button type="submit" variant="primary" disabled={!username || save.isPending}>Save</Button>
            </div>
            <FieldHint>Used to show who you are on GitHub runs. It never changes what you can access.</FieldHint>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
