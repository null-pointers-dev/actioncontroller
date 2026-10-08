import {
  forwardRef,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

const base =
  'w-full rounded-md border border-border bg-surface px-3 text-sm placeholder:text-text-muted ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-[invalid=true]:border-tone-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(base, 'h-9', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(base, 'min-h-20 py-2', className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return <select ref={ref} className={cn(base, 'h-9', className)} {...props} />;
});

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium', className)} {...props} />;
}

export function FieldHint({ children, error }: { children?: ReactNode; error?: boolean }) {
  if (!children) return null;
  return <p className={cn('text-xs', error ? 'text-tone-danger' : 'text-text-muted')}>{children}</p>;
}
