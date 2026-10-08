import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth/session';
import { SignInButton } from './sign-in-button';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  if (await getCurrentUser()) redirect('/');
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-border p-8 text-center">
        <p className="text-lg font-semibold">◆ Control Plane</p>
        <p className="mt-1 text-sm text-text-muted">Run GitHub Actions workflows, cleanly.</p>
        <SignInButton />
      </div>
    </main>
  );
}
