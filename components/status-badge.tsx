import { CheckCircle2, CircleDashed, CircleSlash, Clock, Loader2, PauseCircle, XCircle, HelpCircle } from 'lucide-react';
import { PHASE_LABEL, PHASE_TONE, type Phase, type Tone } from '@/shared/phases';
import { cn } from '@/lib/utils';

const toneClass: Record<Tone, string> = {
  neutral: 'text-tone-neutral',
  attention: 'text-tone-attention',
  progress: 'text-tone-progress',
  success: 'text-tone-success',
  danger: 'text-tone-danger',
};

const icons: Record<Phase, typeof CheckCircle2> = {
  pending: CircleDashed,
  awaiting_approval: PauseCircle,
  waiting_for_slot: Clock,
  dispatching: Loader2,
  verifying: Loader2,
  dispatched: Loader2,
  running: Loader2,
  cancelling: Loader2,
  succeeded: CheckCircle2,
  failed: XCircle,
  cancelled: CircleSlash,
  rejected: CircleSlash,
  lost: HelpCircle,
};

/** Status is always icon + words, never color alone (docs/06 §4). */
export function StatusBadge({ phase, reason, className }: { phase: Phase; reason?: string | null; className?: string }) {
  const Icon = icons[phase];
  const spinning = ['dispatching', 'verifying', 'dispatched', 'running', 'cancelling'].includes(phase);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', toneClass[PHASE_TONE[phase]], className)}>
      <Icon aria-hidden className={cn('size-4', spinning && 'animate-spin [animation-duration:2s]')} />
      <span>{PHASE_LABEL[phase]}</span>
      {reason ? <span className="font-normal text-text-muted">· {reason.replaceAll('_', ' ')}</span> : null}
    </span>
  );
}

export function GithubStatus({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status !== 'completed') {
    return <span className="inline-flex items-center gap-1 text-sm text-tone-progress"><Loader2 aria-hidden className="size-3.5 animate-spin" />{status.replace('_', ' ')}</span>;
  }
  const ok = conclusion === 'success' || conclusion === 'neutral';
  const skipped = conclusion === 'skipped' || conclusion === 'cancelled';
  const Icon = ok ? CheckCircle2 : skipped ? CircleSlash : XCircle;
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm', ok ? 'text-tone-success' : skipped ? 'text-tone-neutral' : 'text-tone-danger')}>
      <Icon aria-hidden className="size-3.5" />
      {conclusion ?? 'done'}
    </span>
  );
}
