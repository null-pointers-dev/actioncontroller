export const EVENT_TYPES = [
  'cp.run_request.created',
  'cp.run_request.phase_changed',
  'cp.run_request.cancel_requested',
  'cp.run_request.completed',
  'cp.run_action.created',
  'cp.run_action.completed',
  'cp.run_action.failed',
  'cp.github_run.observed',
  'cp.github_run.status_changed',
  'cp.github_run.completed',
  'cp.github_job.status_changed',
  'cp.github_job.completed',
  'cp.approval.requested',
  'cp.approval.decision_recorded',
  'cp.approval.approved',
  'cp.approval.denied',
  'cp.approval.expired',
  'cp.workspace.imported',
  'cp.workspace.synced',
  'cp.workspace.sync_failed',
  'cp.workspace.updated',
  'cp.workspace.archived',
  'cp.workspace.grant_added',
  'cp.workspace.grant_removed',
  'cp.workflow.discovered',
  'cp.workflow.definition_changed',
  'cp.workflow.removed',
  'cp.workflow.updated',
  'cp.credential.added',
  'cp.credential.status_changed',
  'cp.identity.github_linked',
  'cp.identity.role_changed',
  'cp.system.drift_corrected',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** What the live stream sends to the browser. */
export interface LiveEvent {
  id: string;
  type: EventType;
  time: string;
  subject: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number | null;
  workspaceId: string | null;
  workflowId: number | null;
  data: Record<string, unknown>;
}
