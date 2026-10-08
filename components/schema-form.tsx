'use client';
import type { ReactNode } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type { FieldSchema, InputSchema, UiSchema } from '@/shared/input-schema';
import { cn } from '@/lib/utils';
import { FieldHint, Input, Label, Select, Textarea } from './ui/input';

export type FormValues = Record<string, string | number | boolean>;

/** Renders a workflow's dispatch inputs (JSON Schema) with the admin's UI hints (docs/06 §3.3). */
export function SchemaForm({
  schema,
  uiSchema,
  form,
  serverErrors,
  environmentInput,
  allowedEnvironments,
}: {
  schema: InputSchema;
  uiSchema: UiSchema;
  form: UseFormReturn<FormValues>;
  serverErrors: Record<string, string>;
  environmentInput: string | null;
  allowedEnvironments: string[];
}) {
  const entries = Object.entries(schema.properties)
    .filter(([name]) => !uiSchema[name]?.hidden)
    .sort(([a], [b]) => (uiSchema[a]?.order ?? 999) - (uiSchema[b]?.order ?? 999));

  return (
    <div className="flex flex-col gap-5">
      {entries.map(([name, field]) => (
        <Field
          key={name}
          name={name}
          field={field}
          ui={uiSchema[name] ?? {}}
          required={schema.required.includes(name)}
          form={form}
          error={serverErrors[name] ?? (form.formState.errors[name]?.message as string | undefined)}
          environmentChoices={name === environmentInput ? allowedEnvironments : null}
        />
      ))}
    </div>
  );
}

function Field({
  name,
  field,
  ui,
  required,
  form,
  error,
  environmentChoices,
}: {
  name: string;
  field: FieldSchema;
  ui: UiSchema[string];
  required: boolean;
  form: UseFormReturn<FormValues>;
  error?: string;
  environmentChoices: string[] | null;
}) {
  const label = ui.label ?? name;
  const id = `input-${name}`;
  const options = environmentChoices ?? field.enum;
  const rules = { required: required ? `${label} is required` : false };

  if (field.type === 'boolean') {
    return (
      <div className="flex items-start gap-3">
        <input id={id} type="checkbox" className="mt-1 size-4 accent-[var(--color-accent)]" {...form.register(name)} />
        <div>
          <Label htmlFor={id}>{label}</Label>
          <FieldHint>{ui.help ?? field.description}</FieldHint>
        </div>
      </div>
    );
  }

  let control: ReactNode;
  if (options && options.length > 0 && (ui.widget === 'radio' || (!ui.widget && options.length <= 4))) {
    const current = form.watch(name);
    control = (
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <label
            key={opt}
            className={cn(
              'cursor-pointer rounded-md border px-3 py-1.5 text-sm',
              current === opt ? 'border-accent bg-accent/10 font-medium' : 'border-border hover:bg-surface-muted',
            )}
          >
            <input type="radio" value={opt} className="sr-only" {...form.register(name, rules)} />
            {opt}
          </label>
        ))}
      </div>
    );
  } else if (options && options.length > 0) {
    control = (
      <Select id={id} aria-invalid={Boolean(error)} {...form.register(name, rules)}>
        <option value="">Choose…</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </Select>
    );
  } else if (ui.widget === 'textarea') {
    control = <Textarea id={id} aria-invalid={Boolean(error)} {...form.register(name, rules)} />;
  } else {
    control = (
      <Input
        id={id}
        type={field.type === 'number' ? 'number' : ui.sensitive ? 'password' : 'text'}
        autoComplete="off"
        aria-invalid={Boolean(error)}
        {...form.register(name, { ...rules, valueAsNumber: field.type === 'number' })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label id={`${id}-label`} htmlFor={id}>
        {label}
        {required ? <span className="text-tone-danger"> *</span> : null}
      </Label>
      {control}
      <FieldHint error={Boolean(error)}>{error ?? ui.help ?? field.description}</FieldHint>
    </div>
  );
}
