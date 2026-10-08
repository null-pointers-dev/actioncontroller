// GitHub JSON -> our snapshot types. Nothing outside server/github sees GitHub payload shapes.

export interface RunSnapshot {
  runId: number;
  attempt: number;
  repoId: number;
  workflowId: number;
  event: string | null;
  displayTitle: string | null;
  headBranch: string | null;
  headSha: string | null;
  actorLogin: string | null;
  triggeringActorLogin: string | null;
  htmlUrl: string | null;
  status: string;
  conclusion: string | null;
  createdAt: Date;
  updatedAt: Date;
  runStartedAt: Date | null;
}

export interface JobSnapshot {
  id: number;
  runId: number;
  attempt: number;
  repoId: number;
  name: string;
  status: string;
  conclusion: string | null;
  runnerName: string | null;
  labels: string[];
  steps: { number: number; name: string; status: string; conclusion: string | null; startedAt: string | null; completedAt: string | null }[];
  htmlUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const date = (v: unknown): Date | null => (typeof v === 'string' && v ? new Date(v) : null);

export function toRunSnapshot(run: Json, repoIdFallback?: number): RunSnapshot {
  return {
    runId: Number(run.id),
    attempt: Number(run.run_attempt ?? 1),
    repoId: Number(run.repository?.id ?? repoIdFallback),
    workflowId: Number(run.workflow_id),
    event: run.event ?? null,
    displayTitle: run.display_title ?? run.name ?? null,
    headBranch: run.head_branch ?? null,
    headSha: run.head_sha ?? null,
    actorLogin: run.actor?.login ?? null,
    triggeringActorLogin: run.triggering_actor?.login ?? null,
    htmlUrl: run.html_url ?? null,
    status: String(run.status),
    conclusion: run.conclusion ?? null,
    createdAt: new Date(run.created_at),
    updatedAt: new Date(run.updated_at ?? run.created_at),
    runStartedAt: date(run.run_started_at),
  };
}

export function toJobSnapshot(job: Json, repoId: number): JobSnapshot {
  return {
    id: Number(job.id),
    runId: Number(job.run_id),
    attempt: Number(job.run_attempt ?? 1),
    repoId,
    name: String(job.name),
    status: String(job.status),
    conclusion: job.conclusion ?? null,
    runnerName: job.runner_name ?? null,
    labels: Array.isArray(job.labels) ? job.labels.map(String) : [],
    steps: Array.isArray(job.steps)
      ? job.steps.map((s: Json) => ({
          number: Number(s.number),
          name: String(s.name),
          status: String(s.status),
          conclusion: s.conclusion ?? null,
          startedAt: s.started_at ?? null,
          completedAt: s.completed_at ?? null,
        }))
      : [],
    htmlUrl: job.html_url ?? null,
    startedAt: date(job.started_at),
    completedAt: date(job.completed_at),
  };
}
