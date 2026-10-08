'use client';
import { useQuery } from '@tanstack/react-query';
import { CheckSquare, Home, KeyRound, LayoutGrid, ListChecks, LogOut, Server, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { signOut } from '@/lib/auth-client';
import { useTRPC } from '@/lib/trpc/client';
import { cn } from '@/lib/utils';
import { LiveIndicator } from './live-indicator';

interface ShellUser {
  name: string;
  role: 'admin' | 'user';
  githubLogin: string | null;
}

function NavLink({ href, icon: Icon, children, badge }: { href: string; icon: typeof Home; children: ReactNode; badge?: number }) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        active ? 'bg-surface-muted font-medium' : 'text-text-muted hover:bg-surface-muted hover:text-text',
      )}
    >
      <Icon aria-hidden className="size-4" />
      <span className="flex-1">{children}</span>
      {badge ? <span className="rounded-full bg-accent px-1.5 text-xs text-accent-fg">{badge}</span> : null}
    </Link>
  );
}

export function AppShell({ user, children }: { user: ShellUser; children: ReactNode }) {
  const trpc = useTRPC();
  const workspaces = useQuery(trpc.workspaces.list.queryOptions());
  const approvals = useQuery(trpc.approvals.inbox.queryOptions({ mode: 'waiting' }));

  return (
    <div className="grid min-h-dvh grid-cols-[15rem_1fr]">
      <aside className="flex flex-col gap-6 border-r border-border bg-surface-muted/40 p-3">
        <Link href="/" className="px-2 pt-1 text-sm font-semibold">◆ Control Plane</Link>
        <nav className="flex flex-col gap-0.5">
          <NavLink href="/" icon={Home}>Home</NavLink>
          <NavLink href="/runs" icon={ListChecks}>Runs</NavLink>
          <NavLink href="/approvals" icon={CheckSquare} badge={approvals.data?.length}>Approvals</NavLink>
          <NavLink href="/w" icon={LayoutGrid}>Workspaces</NavLink>
        </nav>
        <div>
          <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Workspaces</p>
          <nav className="flex flex-col gap-0.5">
            {workspaces.data?.slice(0, 8).map((w) => (
              <NavLink key={w.id} href={`/w/${w.id}`} icon={LayoutGrid}>{w.displayName}</NavLink>
            ))}
          </nav>
        </div>
        {user.role === 'admin' ? (
          <div>
            <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Admin</p>
            <nav className="flex flex-col gap-0.5">
              <NavLink href="/admin" icon={Settings}>Workspaces</NavLink>
              <NavLink href="/admin/credentials" icon={KeyRound}>Credentials</NavLink>
              <NavLink href="/admin/system" icon={Server}>System</NavLink>
            </nav>
          </div>
        ) : null}
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex h-12 items-center justify-end gap-4 border-b border-border px-6">
          <LiveIndicator />
          <Link href="/me" className="text-sm">
            {user.name}
            {user.githubLogin ? <span className="text-text-muted"> · @{user.githubLogin}</span> : null}
          </Link>
          <button type="button" onClick={() => void signOut()} className="text-text-muted hover:text-text" aria-label="Sign out">
            <LogOut className="size-4" />
          </button>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
