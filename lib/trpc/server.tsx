import 'server-only';
import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { headers } from 'next/headers';
import { cache, type ReactNode } from 'react';
import { createContext } from '@/server/trpc/init';
import { appRouter } from '@/server/trpc/root';
import { makeQueryClient } from './query-client';

/** One QueryClient per server request. */
export const getQueryClient = cache(makeQueryClient);

/** Server-side tRPC for prefetching in Server Components (same auth, same services). */
export const trpc = createTRPCOptionsProxy({
  ctx: async () => createContext({ headers: await headers() }),
  router: appRouter,
  queryClient: getQueryClient,
});

export function HydrateClient({ children }: { children: ReactNode }) {
  return <HydrationBoundary state={dehydrate(getQueryClient())}>{children}</HydrationBoundary>;
}
