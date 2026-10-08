import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createContext } from '@/server/trpc/init';
import { appRouter } from '@/server/trpc/root';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createContext({ headers: req.headers }),
  });
}

export { handler as GET, handler as POST };
