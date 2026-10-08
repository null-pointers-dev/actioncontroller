import { WorkspaceSettings } from '@/features/admin/workspace-settings';

export const metadata = { title: 'Admin · Workspace settings' };
export default async function WorkspaceSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return <WorkspaceSettings workspaceId={workspaceId} />;
}
