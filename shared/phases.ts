// The run-request phase vocabulary and state machine. Mirrors cp.phase_transition_allowed().

export const PHASES = [
  'pending',
  'awaiting_approval',
  'waiting_for_slot',
  'dispatching',
  'verifying',
  'dispatched',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
  'lost',
] as const;

export type Phase = (typeof PHASES)[number];

export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set(['succeeded', 'failed', 'cancelled', 'rejected', 'lost']);
export const ACTIVE_SLOT_PHASES: ReadonlySet<Phase> = new Set(['dispatching', 'verifying', 'dispatched', 'running', 'cancelling']);

const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  pending: ['awaiting_approval', 'waiting_for_slot', 'dispatching', 'rejected', 'cancelled'],
  awaiting_approval: ['waiting_for_slot', 'dispatching', 'rejected', 'cancelled'],
  waiting_for_slot: ['dispatching', 'rejected', 'cancelled'],
  dispatching: ['verifying', 'dispatched', 'running', 'succeeded', 'failed', 'cancelled', 'cancelling', 'lost'],
  verifying: ['dispatching', 'dispatched', 'running', 'succeeded', 'failed', 'cancelled', 'cancelling', 'lost'],
  dispatched: ['running', 'succeeded', 'failed', 'cancelled', 'cancelling'],
  running: ['succeeded', 'failed', 'cancelled', 'cancelling'],
  cancelling: ['cancelled', 'succeeded', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
  rejected: [],
  lost: [],
};

export function canTransition(from: Phase, to: Phase): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function isTerminal(phase: Phase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** Order used when GitHub observations move a request forward (never backwards). */
export const PHASE_PROGRESS: Record<Phase, number> = {
  pending: 0,
  awaiting_approval: 1,
  waiting_for_slot: 2,
  dispatching: 3,
  verifying: 3,
  dispatched: 4,
  running: 5,
  cancelling: 6,
  succeeded: 9,
  failed: 9,
  cancelled: 9,
  rejected: 9,
  lost: 9,
};

export type Tone = 'neutral' | 'attention' | 'progress' | 'success' | 'danger';

export const PHASE_LABEL: Record<Phase, string> = {
  pending: 'Requested',
  awaiting_approval: 'Waiting for approval',
  waiting_for_slot: 'Queued behind another run',
  dispatching: 'Sending to GitHub',
  verifying: 'Confirming with GitHub',
  dispatched: 'Queued on GitHub',
  running: 'Running',
  cancelling: 'Cancelling',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  rejected: 'Not started',
  lost: "Couldn't confirm with GitHub",
};

export const PHASE_TONE: Record<Phase, Tone> = {
  pending: 'neutral',
  awaiting_approval: 'attention',
  waiting_for_slot: 'attention',
  dispatching: 'progress',
  verifying: 'progress',
  dispatched: 'progress',
  running: 'progress',
  cancelling: 'attention',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  rejected: 'danger',
  lost: 'danger',
};

/** GitHub status (+ conclusion) rank. Mirrors cp.github_status_rank(). */
export function githubStatusRank(status: string, conclusion: string | null | undefined): number {
  if (status === 'requested') return 1;
  if (status === 'queued' || status === 'pending') return 2;
  if (status === 'waiting' || status === 'in_progress') return 3;
  if (status === 'completed') return conclusion === 'action_required' ? 3 : 5;
  return 0;
}

/** Which request phase a GitHub run state implies (null = no change). */
export function phaseForGithubRun(status: string, conclusion: string | null | undefined): Phase | null {
  switch (status) {
    case 'requested':
    case 'queued':
    case 'pending':
    case 'waiting':
      return 'dispatched';
    case 'in_progress':
      return 'running';
    case 'completed':
      if (conclusion === 'success' || conclusion === 'neutral') return 'succeeded';
      if (conclusion === 'cancelled') return 'cancelled';
      if (conclusion === 'action_required') return null;
      return 'failed';
    default:
      return null;
  }
}
