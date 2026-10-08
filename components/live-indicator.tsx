'use client';
import { useLiveStatus } from '@/lib/state/live';
import { cn } from '@/lib/utils';

const label = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', offline: 'Offline' } as const;
const dot = { connecting: 'bg-tone-neutral', live: 'bg-tone-success', reconnecting: 'bg-tone-attention', offline: 'bg-tone-neutral' } as const;

export function LiveIndicator() {
  const status = useLiveStatus((s) => s.status);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-muted" role="status" aria-live="polite">
      <span className={cn('size-2 rounded-full', dot[status])} />
      {label[status]}
    </span>
  );
}
