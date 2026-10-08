'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { signInWithMicrosoft } from '@/lib/auth-client';

export function SignInButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      className="mt-6 w-full"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signInWithMicrosoft();
      }}
    >
      {busy ? 'Redirecting…' : 'Sign in with Microsoft'}
    </Button>
  );
}
