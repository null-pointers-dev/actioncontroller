import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-surface p-4', className)} {...props} />;
}

export function SectionTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted', className)} {...props} />;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm text-text-muted">{children}</div> : null}
    </div>
  );
}

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs', className)} {...props} />;
}
