// Pure: workflow YAML -> input JSON Schema (docs/03 §4). No I/O.
import { parse } from 'yaml';
import { GITHUB_MAX_INPUTS, RESERVED_INPUTS, type FieldSchema, type InputSchema } from '@/shared/input-schema';

export interface ParsedDefinition {
  hasDispatch: boolean;
  inputSchema: InputSchema;
  runNameHasTag: boolean;
  declaresTagInput: boolean;
  problems: string[];
}

const EMPTY: InputSchema = { type: 'object', properties: {}, required: [] };

type Raw = Record<string, unknown>;

export function parseWorkflowFile(text: string): ParsedDefinition {
  let doc: Raw;
  try {
    doc = (parse(text) ?? {}) as Raw;
  } catch (err) {
    return { hasDispatch: false, inputSchema: EMPTY, runNameHasTag: false, declaresTagInput: false, problems: [`Invalid YAML: ${(err as Error).message}`] };
  }

  // YAML 1.2 keeps `on` as a string key; tolerate parsers that turned it into `true`.
  const on = (doc['on'] ?? doc['true']) as unknown;
  let dispatch: Raw | null | undefined;
  let hasDispatch = false;
  if (typeof on === 'string') hasDispatch = on === 'workflow_dispatch';
  else if (Array.isArray(on)) hasDispatch = on.includes('workflow_dispatch');
  else if (on && typeof on === 'object' && 'workflow_dispatch' in (on as Raw)) {
    hasDispatch = true;
    dispatch = (on as Raw)['workflow_dispatch'] as Raw | null;
  }

  const problems: string[] = [];
  const properties: Record<string, FieldSchema> = {};
  const required: string[] = [];
  const inputs = (dispatch?.['inputs'] ?? {}) as Record<string, Raw | null>;
  let declaresTagInput = false;
  const reservedDeclared: string[] = [];

  for (const [name, rawDef] of Object.entries(inputs)) {
    const def = (rawDef ?? {}) as Raw;
    if ((RESERVED_INPUTS as readonly string[]).includes(name)) {
      if (name === '_cp_tag') declaresTagInput = true;
      reservedDeclared.push(name);
      continue; // reserved inputs are filled by the system, never shown in the form
    }
    const ghType = String(def['type'] ?? 'string');
    const description = typeof def['description'] === 'string' ? def['description'] : undefined;
    const field: FieldSchema = (() => {
      switch (ghType) {
        case 'boolean':
          return { type: 'boolean', 'x-github-type': 'boolean' };
        case 'number':
          return { type: 'number', 'x-github-type': 'number' };
        case 'choice': {
          const options = Array.isArray(def['options']) ? def['options'].map(String) : [];
          if (options.length === 0) problems.push(`Input "${name}" is a choice without options`);
          return { type: 'string', enum: options, 'x-github-type': 'choice' };
        }
        case 'environment':
          return { type: 'string', 'x-github-type': 'environment' };
        default:
          if (ghType !== 'string') problems.push(`Input "${name}" has unknown type "${ghType}" (treated as text)`);
          return { type: 'string', 'x-github-type': 'string' };
      }
    })();
    if (description) field.description = description;
    const dflt = def['default'];
    if (dflt !== undefined && dflt !== null) {
      field.default =
        field.type === 'boolean' ? dflt === true || dflt === 'true' : field.type === 'number' ? Number(dflt) : String(dflt);
    }
    properties[name] = field;
    if (def['required'] === true || def['required'] === 'true') required.push(name);
  }

  const total = Object.keys(properties).length + RESERVED_INPUTS.length;
  if (hasDispatch && total > GITHUB_MAX_INPUTS) {
    problems.push(`Workflow has ${Object.keys(properties).length} inputs; with reserved inputs that exceeds GitHub's limit of ${GITHUB_MAX_INPUTS}`);
  }
  if (hasDispatch && !declaresTagInput) {
    problems.push('Add an input named "_cp_tag" (string, not required) so runs can be correlated');
  }

  const runName = doc['run-name'];
  const runNameHasTag = typeof runName === 'string' && /inputs\._cp_tag/.test(runName);

  return {
    hasDispatch,
    inputSchema: { type: 'object', properties, required, 'x-cp-reserved': reservedDeclared },
    runNameHasTag,
    declaresTagInput,
    problems,
  };
}
