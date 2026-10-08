'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { Info, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { UiSchema } from '@/shared/input-schema';
import { SchemaForm, type FormValues } from '@/components/schema-form';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/card';
import { FieldHint, Input, Label } from '@/components/ui/input';
import { useTRPC } from '@/lib/trpc/client';
import { newIdempotencyKey } from '@/lib/utils';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The run form GitHub never had (docs/06 §3.3). */
export function Composer({ workspaceId, workflowId, fromRunId }: { workspaceId: string; workflowId: number; fromRunId?: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [idempotencyKey] = useState(newIdempotencyKey); // created when the form opens
  const workflow = useQuery(trpc.workflows.get.queryOptions({ workflowId }));
  const previous = useQuery({ ...trpc.runs.get.queryOptions({ id: fromRunId ?? '' }), enabled: Boolean(fromRunId) });
  const [ref, setRef] = useState<string>('');
  const effectiveRef = ref || previous.data?.ref || workflow.data?.workspace.defaultBranch || '';
  const debouncedRef = useDebounced(effectiveRef, 400);

  const definition = useQuery({
    ...trpc.workflows.definition.queryOptions({ workflowId, ref: debouncedRef || undefined }),
    enabled: Boolean(debouncedRef),
  });
  const refs = useQuery(trpc.workflows.refs.queryOptions({ workflowId, q: debouncedRef }));

  const form = useForm<FormValues>({ mode: 'onBlur' });
  const defaults = useMemo(() => {
    if (!definition.data) return null;
    const values: FormValues = {};
    for (const [name, field] of Object.entries(definition.data.inputSchema.properties)) {
      const last = previous.data?.inputs?.[name];
      if (last !== undefined) values[name] = last;
      else if (field.default !== undefined) values[name] = field.default;
    }
    return values;
  }, [definition.data, previous.data]);
  useEffect(() => {
    if (defaults) form.reset(defaults);
  }, [defaults, form]);

  const values = form.watch();
  const debouncedValues = useDebounced(values, 500);
  const validation = useQuery({
    ...trpc.runs.validate.queryOptions({ workflowId, ref: debouncedRef, inputs: cleanInputs(debouncedValues) }),
    enabled: Boolean(debouncedRef && definition.data?.hasDispatch),
  });

  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const create = useMutation(
    trpc.runs.create.mutationOptions({
      onSuccess: (res) => router.push(`/runs/${res.id}`),
      onError: (err) => {
        const problems = (err instanceof TRPCClientError ? err.data?.problems : undefined) as { field?: string; message: string }[] | undefined;
        setServerErrors(Object.fromEntries((problems ?? []).filter((p) => p.field).map((p) => [p.field!, p.message])));
      },
    }),
  );

  const def = definition.data;
  const env = def?.environmentInput ? String(values[def.environmentInput] ?? '') : '';
  const needsApproval = validation.data?.approvalRequired;
  const blocking = validation.data?.problems.filter((p) => !('field' in p) || !p.field) ?? [];

  const submit = form.handleSubmit((v) =>
    create.mutate({ workflowId, ref: effectiveRef, inputs: cleanInputs(v), idempotencyKey }),
  );

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={<>Run · {workflow.data?.displayName ?? '…'}</>}
        subtitle={workflow.data ? `${workflow.data.workspace.displayName} · ${workflow.data.workspace.fullName}` : undefined}
      />
      <Card>
        <form
          onSubmit={(e) => void submit(e)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
          className="flex flex-col gap-6"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ref">Branch or tag</Label>
            <Input id="ref" list="ref-options" value={effectiveRef} onChange={(e) => setRef(e.target.value)} autoComplete="off" />
            <datalist id="ref-options">
              {[...(refs.data?.branches ?? []), ...(refs.data?.tags ?? [])].map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <FieldHint error={Boolean(serverErrors['ref'])}>
              {serverErrors['ref'] ?? (def?.allowedRefPatterns?.length ? `Allowed: ${def.allowedRefPatterns.join(', ')}` : undefined)}
            </FieldHint>
          </div>

          {definition.isPending && debouncedRef ? <p className="text-sm text-text-muted">Reading the workflow at {debouncedRef}…</p> : null}
          {def && !def.hasDispatch ? (
            <p className="text-sm text-tone-danger">This workflow can't be started manually on {def.ref} (no workflow_dispatch).</p>
          ) : null}
          {def?.hasDispatch ? (
            <SchemaForm
              schema={def.inputSchema}
              uiSchema={def.uiSchema as UiSchema}
              form={form}
              serverErrors={serverErrors}
              environmentInput={def.environmentInput}
              allowedEnvironments={def.runnableEnvironments.length ? def.runnableEnvironments : def.environments}
            />
          ) : null}

          {needsApproval || validation.data?.slotBusy || blocking.length || validation.data?.weakDuplicateProtection ? (
            <div className="flex flex-col gap-2 rounded-md bg-surface-muted p-3 text-sm">
              {needsApproval ? (
                <p className="flex gap-2"><Info className="size-4 shrink-0 text-tone-attention" />Needs approval before it starts{env ? ` (${env})` : ''}.</p>
              ) : null}
              {validation.data?.slotBusy ? (
                <p className="flex gap-2">
                  <Info className="size-4 shrink-0 text-tone-attention" />
                  {validation.data.concurrencyPolicy === 'queue'
                    ? 'Another run is active for this target — yours will wait for it.'
                    : 'Another run is active for this target — yours will wait until it finishes.'}
                </p>
              ) : null}
              {blocking.map((p) => (
                <p key={p.message} className="flex gap-2 text-tone-danger"><ShieldAlert className="size-4 shrink-0" />{p.message}</p>
              ))}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button onClick={() => router.back()}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!def?.hasDispatch || create.isPending || !def.canRun}>
              {create.isPending ? 'Sending…' : needsApproval ? 'Request run' : 'Run'} <kbd className="text-xs opacity-70">⌘↵</kbd>
            </Button>
          </div>
          {create.error && !Object.keys(serverErrors).length ? <p className="text-sm text-tone-danger">{create.error.message}</p> : null}
        </form>
      </Card>
    </div>
  );
}

function cleanInputs(values: FormValues): FormValues {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== '' && v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))),
  );
}
