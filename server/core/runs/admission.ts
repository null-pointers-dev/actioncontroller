// Pure admission rules (docs/07 §7). No I/O — unit tested in tests/admission.test.ts.
import { refAllowed } from '@/shared/glob';
import {
  environmentInputName,
  GITHUB_MAX_INPUTS,
  RESERVED_INPUTS,
  type InputSchema,
  type InputValue,
  type UiSchema,
} from '@/shared/input-schema';
import type { Problem } from '../errors';

export interface AdmissionFacts {
  workspaceStatus: string;
  workflow: {
    id: number;
    ghState: string;
    uiSchema: UiSchema;
    allowedRefPatterns: string[] | null;
    approvalRequired: boolean;
    approvalEnvironments: string[] | null;
    approvalMin: number;
    concurrencyScope: 'none' | 'workflow' | 'workflow_environment';
    concurrencyPolicy: 'allow' | 'forbid' | 'queue';
  };
  definition: { hasDispatch: boolean; inputSchema: InputSchema; runNameHasTag: boolean };
}

export interface AdmissionRequest {
  ref: string;
  inputs: Record<string, InputValue>;
}

export type AdmissionResult =
  | {
      ok: true;
      inputs: Record<string, InputValue>;
      environment: string | null;
      concurrencyKey: string | null;
      concurrencyPolicy: 'allow' | 'forbid' | 'queue';
      approval: { min: number } | null;
      settingsSnapshot: Record<string, unknown>;
      weakDuplicateProtection: boolean;
    }
  | { ok: false; problems: Problem[] };

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(value));
}

export function admit(facts: AdmissionFacts, req: AdmissionRequest): AdmissionResult {
  const problems: Problem[] = [];
  const { workflow, definition } = facts;

  if (facts.workspaceStatus !== 'active') problems.push({ code: 'workspace_inactive', message: 'This workspace is not active' });
  if (workflow.ghState !== 'active') problems.push({ code: 'workflow_unavailable', message: 'This workflow is disabled or removed on GitHub' });
  if (!definition.hasDispatch) {
    problems.push({ code: 'no_dispatch', message: `This workflow has no workflow_dispatch trigger on ${req.ref}` });
  }
  if (!refAllowed(req.ref, workflow.allowedRefPatterns)) {
    problems.push({ field: 'ref', code: 'ref_not_allowed', message: `Only ${workflow.allowedRefPatterns!.join(', ')} may be used` });
  }

  const schema = definition.inputSchema;
  const inputs: Record<string, InputValue> = {};
  for (const key of Object.keys(req.inputs)) {
    if (!schema.properties[key]) problems.push({ field: key, code: 'unknown_input', message: `Unknown input "${key}"` });
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    const ui = workflow.uiSchema[name] ?? {};
    const label = ui.label ?? name;
    const raw = req.inputs[name] ?? field.default;
    if (raw === undefined || raw === '') {
      if (schema.required.includes(name)) problems.push({ field: name, code: 'required', message: `${label} is required` });
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof raw === 'boolean') inputs[name] = raw;
      else if (raw === 'true' || raw === 'false') inputs[name] = raw === 'true';
      else problems.push({ field: name, code: 'type', message: `${label} must be true or false` });
      continue;
    }
    if (field.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(n)) inputs[name] = n;
      else problems.push({ field: name, code: 'type', message: `${label} must be a number` });
      continue;
    }
    const value = String(raw);
    if (field.enum && field.enum.length > 0 && !field.enum.includes(value)) {
      problems.push({ field: name, code: 'not_an_option', message: `${label} must be one of ${field.enum.join(', ')}` });
      continue;
    }
    if (ui.pattern) {
      let ok = true;
      try {
        ok = new RegExp(`^(?:${ui.pattern})$`).test(value);
      } catch {
        ok = true; // a broken admin pattern never blocks users
      }
      if (!ok) {
        problems.push({ field: name, code: 'pattern', message: ui.patternMessage ?? `${label} has an invalid format` });
        continue;
      }
    }
    if (looksLikeSecret(value)) {
      problems.push({ field: name, code: 'secret_detected', message: `${label} looks like a secret. Never pass secrets as inputs — use GitHub environment secrets` });
      continue;
    }
    inputs[name] = value;
  }

  const declared = Object.keys(schema.properties).length + RESERVED_INPUTS.length;
  if (declared > GITHUB_MAX_INPUTS) {
    problems.push({ code: 'too_many_inputs', message: `GitHub allows at most ${GITHUB_MAX_INPUTS} inputs` });
  }

  if (problems.length > 0) return { ok: false, problems };

  const envInput = environmentInputName(schema);
  const environment = envInput && inputs[envInput] !== undefined ? String(inputs[envInput]) : null;
  const concurrencyKey =
    workflow.concurrencyScope === 'none'
      ? null
      : workflow.concurrencyScope === 'workflow'
        ? `${workflow.id}`
        : `${workflow.id}/${environment ?? '-'}`;
  const needsApproval =
    workflow.approvalRequired &&
    (!workflow.approvalEnvironments?.length || (environment !== null && workflow.approvalEnvironments.includes(environment)));

  return {
    ok: true,
    inputs,
    environment,
    concurrencyKey,
    concurrencyPolicy: concurrencyKey ? workflow.concurrencyPolicy : 'allow',
    approval: needsApproval ? { min: workflow.approvalMin } : null,
    settingsSnapshot: {
      allowedRefPatterns: workflow.allowedRefPatterns,
      approvalRequired: workflow.approvalRequired,
      approvalEnvironments: workflow.approvalEnvironments,
      approvalMin: workflow.approvalMin,
      concurrencyScope: workflow.concurrencyScope,
      concurrencyPolicy: workflow.concurrencyPolicy,
    },
    weakDuplicateProtection: !definition.runNameHasTag,
  };
}
