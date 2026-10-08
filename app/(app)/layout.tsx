import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { LiveStream } from '@/lib/live/live-stream';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <AppShell user={{ name: user.name, role: user.role, githubLogin: user.githubLogin }}>
      <LiveStream userId={user.id} />
      {children}
    </AppShell>
  );
}
