import { describe, expect, it } from 'vitest';
import { parseWorkflowFile } from '@/server/core/workspaces/definition-parser';

const yaml = `
name: Deploy
run-name: Deploy \${{ inputs.environment }} · \${{ inputs._cp_tag }}
on:
  workflow_dispatch:
    inputs:
      environment:
        type: environment
        required: true
      version:
        description: Version to deploy
        required: true
      dryRun:
        type: boolean
        default: false
      region:
        type: choice
        options: [eu, us]
        default: eu
      _cp_tag:
        type: string
        required: false
  push:
    branches: [main]
jobs: {}
`;

describe('workflow definition parser', () => {
  it('turns dispatch inputs into JSON Schema and hides reserved inputs', () => {
    const d = parseWorkflowFile(yaml);
    expect(d.hasDispatch).toBe(true);
    expect(d.runNameHasTag).toBe(true);
    expect(d.declaresTagInput).toBe(true);
    expect(Object.keys(d.inputSchema.properties)).toEqual(['environment', 'version', 'dryRun', 'region']);
    expect(d.inputSchema.required).toEqual(['environment', 'version']);
    expect(d.inputSchema.properties['region']?.enum).toEqual(['eu', 'us']);
    expect(d.inputSchema.properties['dryRun']?.default).toBe(false);
    expect(d.inputSchema['x-cp-reserved']).toEqual(['_cp_tag']);
    expect(d.problems).toEqual([]);
  });

  it('reports workflows that cannot be correlated', () => {
    const d = parseWorkflowFile('on: workflow_dispatch\njobs: {}\n');
    expect(d.hasDispatch).toBe(true);
    expect(d.problems.some((p) => p.includes('_cp_tag'))).toBe(true);
  });

  it('survives invalid YAML', () => {
    const d = parseWorkflowFile('on: [workflow_dispatch\n');
    expect(d.hasDispatch).toBe(false);
    expect(d.problems[0]).toMatch(/Invalid YAML/);
  });
});
