'use client';
import { useVirtualizer } from '@tanstack/react-virtual';
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const ERROR = /(error|failed|exception|fatal)/i;
const ANSI = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/;

/** Virtualised job log with search and jump-to-first-error (docs/06 §3.5). */
export function LogPanel({ jobId, title, onClose }: { jobId: number; title: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    fetch(`/api/logs/${jobId}`)
      .then(async (res) => (res.ok ? res.text() : Promise.reject(new Error(await res.text()))))
      .then((t) => !cancelled && setText(t))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const lines = useMemo(() => (text ?? '').split('\n').map((l) => l.replace(ANSI, '').replace(TIMESTAMP, '')), [text]);
  const firstError = useMemo(() => lines.findIndex((l) => ERROR.test(l)), [lines]);
  const matches = useMemo(() => (query ? lines.flatMap((l, i) => (l.toLowerCase().includes(query.toLowerCase()) ? [i] : [])) : []), [lines, query]);

  const virtualizer = useVirtualizer({ count: lines.length, getScrollElement: () => parentRef.current, estimateSize: () => 20, overscan: 30 });

  return (
    <section className="rounded-lg border border-border">
      <header className="flex items-center gap-2 border-b border-border p-2">
        <p className="flex-1 truncate px-1 text-sm font-medium">Log · {title}</p>
        <Input className="h-8 w-48" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="text-xs text-text-muted">{query ? `${matches.length} matches` : `${lines.length} lines`}</span>
        {firstError >= 0 ? <Button size="sm" onClick={() => virtualizer.scrollToIndex(firstError, { align: 'center' })}>First error</Button> : null}
        {matches[0] !== undefined ? <Button size="sm" onClick={() => virtualizer.scrollToIndex(matches[0]!, { align: 'center' })}>Go</Button> : null}
        <button aria-label="Close log" onClick={onClose} className="p-1 text-text-muted hover:text-text"><X className="size-4" /></button>
      </header>
      {error ? <p className="p-3 text-sm text-tone-danger">{error}</p> : null}
      {text === null && !error ? <p className="p-3 text-sm text-text-muted">Loading log…</p> : null}
      <div ref={parentRef} className="h-[28rem] overflow-auto bg-surface-muted font-mono text-xs">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const line = lines[item.index] ?? '';
            return (
              <div
                key={item.key}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                className={cn('flex gap-3 whitespace-pre px-3 leading-5', ERROR.test(line) && 'bg-tone-danger/10 text-tone-danger', matches.includes(item.index) && 'bg-tone-attention/20')}
              >
                <span className="w-10 shrink-0 select-none text-right text-text-muted">{item.index + 1}</span>
                <span>{line}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
