import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86400), 'day');
}

export function duration(from: Date | string | null | undefined, to?: Date | string | null): string {
  if (!from) return '';
  const ms = (to ? new Date(to) : new Date()).getTime() - new Date(from).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
