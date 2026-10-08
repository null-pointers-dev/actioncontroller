import { RunView } from '@/features/run-view/run-view';
import { getQueryClient, HydrateClient, trpc } from '@/lib/trpc/server';

export const metadata = { title: 'Run' };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Server prefetch: the page arrives with data; the live stream keeps it fresh.
  await getQueryClient().prefetchQuery(trpc.runs.get.queryOptions({ id }));
  return (
    <HydrateClient>
      <RunView id={id} />
    </HydrateClient>
  );
}
