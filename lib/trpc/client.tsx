'use client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchStreamLink, httpSubscriptionLink, splitLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { useState, type ReactNode } from 'react';
import superjson from 'superjson';
import type { AppRouter } from '@/server/trpc/root';
import { makeQueryClient } from './query-client';

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

let browserQueryClient: QueryClient | undefined;
function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

export function TRPCReactProvider({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        splitLink({
          condition: (op) => op.type === 'subscription',
          true: httpSubscriptionLink({ url: '/api/trpc', transformer: superjson }),
          false: httpBatchStreamLink({ url: '/api/trpc', transformer: superjson }),
        }),
      ],
    }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
