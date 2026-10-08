// The subset of JSON Schema we generate from a workflow's `workflow_dispatch.inputs`.

export type GithubInputType = 'string' | 'choice' | 'boolean' | 'number' | 'environment';

export interface FieldSchema {
  type: 'string' | 'number' | 'boolean';
  title?: string;
  description?: string;
  enum?: string[];
  default?: string | number | boolean;
  'x-github-type': GithubInputType;
}

export interface InputSchema {
  type: 'object';
  properties: Record<string, FieldSchema>;
  required: string[];
  /** Reserved inputs (`_cp_*`) the workflow declares. Only these may be sent on dispatch. */
  'x-cp-reserved'?: string[];
}

/** Admin-provided presentation hints, keyed by input name. */
export interface UiSchemaField {
  label?: string;
  help?: string;
  order?: number;
  widget?: 'radio' | 'select' | 'text' | 'textarea';
  sensitive?: boolean;
  hidden?: boolean;
  pattern?: string;
  patternMessage?: string;
}
export type UiSchema = Record<string, UiSchemaField>;

export const RESERVED_INPUTS = ['_cp_tag', '_cp_requested_by'] as const;
export const GITHUB_MAX_INPUTS = 25;

export type InputValue = string | number | boolean;

/** The environment input of a workflow, if any: an `environment`-typed input, else one named "environment". */
export function environmentInputName(schema: InputSchema): string | null {
  const entries = Object.entries(schema.properties);
  const typed = entries.find(([, f]) => f['x-github-type'] === 'environment');
  if (typed) return typed[0];
  return schema.properties['environment'] ? 'environment' : null;
}
