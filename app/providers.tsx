'use client';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { TRPCReactProvider } from '@/lib/trpc/client';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <TRPCReactProvider>
      <NuqsAdapter>{children}</NuqsAdapter>
      <Toaster position="bottom-right" closeButton />
    </TRPCReactProvider>
  );
}
