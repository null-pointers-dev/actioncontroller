import Link from 'next/link';
import type { Phase } from '@/shared/phases';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo } from '@/lib/utils';

export interface RunRowData {
  id: string;
  workflowName: string;
  workspaceName: string;
  environment: string | null;
  ref: string;
  phase: Phase;
  phaseReason: string | null;
  requesterName: string | null;
  createdAt: Date;
}

export function RunRow({ run, showRequester = false }: { run: RunRowData; showRequester?: boolean }) {
  return (
    <Link href={`/runs/${run.id}`} className="flex items-center gap-4 rounded-md px-3 py-2.5 hover:bg-surface-muted">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {run.workflowName}
          <span className="font-normal text-text-muted"> · {run.environment ?? run.ref}</span>
        </p>
        <p className="truncate text-xs text-text-muted">
          {run.workspaceName}
          {showRequester && run.requesterName ? ` · ${run.requesterName}` : ''} · {timeAgo(run.createdAt)}
        </p>
      </div>
      <StatusBadge phase={run.phase} />
    </Link>
  );
}
