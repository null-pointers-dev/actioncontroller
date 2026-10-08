import { Composer } from '@/features/composer/composer';

export const metadata = { title: 'Run workflow' };

export default async function RunWorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; workflowId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { workspaceId, workflowId } = await params;
  const { from } = await searchParams;
  return <Composer workspaceId={workspaceId} workflowId={Number(workflowId)} fromRunId={from} />;
}
