import { defaultShouldDehydrateQuery, QueryClient } from '@tanstack/react-query';
import superjson from 'superjson';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
      dehydrate: {
        serializeData: superjson.serialize,
        shouldDehydrateQuery: (query) => defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
      },
      hydrate: { deserializeData: superjson.deserialize },
    },
  });
}
