import { describe, expect, it } from 'vitest';
import { admit, looksLikeSecret, type AdmissionFacts } from '@/server/core/runs/admission';

const baseFacts = (over: Partial<AdmissionFacts['workflow']> = {}): AdmissionFacts => ({
  workspaceStatus: 'active',
  workflow: {
    id: 8801,
    ghState: 'active',
    uiSchema: {},
    allowedRefPatterns: null,
    approvalRequired: false,
    approvalEnvironments: null,
    approvalMin: 1,
    concurrencyScope: 'none',
    concurrencyPolicy: 'allow',
    ...over,
  },
  definition: {
    hasDispatch: true,
    runNameHasTag: true,
    inputSchema: {
      type: 'object',
      required: ['environment', 'version'],
      properties: {
        environment: { type: 'string', enum: ['staging', 'production'], 'x-github-type': 'choice' },
        version: { type: 'string', 'x-github-type': 'string' },
        dryRun: { type: 'boolean', default: false, 'x-github-type': 'boolean' },
      },
    },
  },
});

describe('admission', () => {
  it('accepts valid input and fills defaults', () => {
    const r = admit(baseFacts(), { ref: 'main', inputs: { environment: 'staging', version: '1.9.4' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.inputs).toEqual({ environment: 'staging', version: '1.9.4', dryRun: false });
      expect(r.environment).toBe('staging');
    }
  });

  it('collects every problem at once', () => {
    const r = admit(baseFacts(), { ref: 'main', inputs: { environment: 'qa', unknown: 'x' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.code).sort()).toEqual(['not_an_option', 'required', 'unknown_input']);
  });

  it('enforces allowed refs', () => {
    const r = admit(baseFacts({ allowedRefPatterns: ['release/*'] }), { ref: 'main', inputs: { environment: 'staging', version: '1' } });
    expect(r.ok).toBe(false);
  });

  it('requires approval only for configured environments', () => {
    const facts = baseFacts({ approvalRequired: true, approvalEnvironments: ['production'] });
    const staging = admit(facts, { ref: 'main', inputs: { environment: 'staging', version: '1' } });
    const prod = admit(facts, { ref: 'main', inputs: { environment: 'production', version: '1' } });
    expect(staging.ok && staging.approval).toBe(null);
    expect(prod.ok && prod.approval).toEqual({ min: 1 });
  });

  it('builds the concurrency key per environment', () => {
    const r = admit(baseFacts({ concurrencyScope: 'workflow_environment', concurrencyPolicy: 'forbid' }), {
      ref: 'main',
      inputs: { environment: 'production', version: '1' },
    });
    expect(r.ok && r.concurrencyKey).toBe('8801/production');
  });

  it('refuses secrets in inputs', () => {
    expect(looksLikeSecret('ghp_' + 'a'.repeat(36))).toBe(true);
    const r = admit(baseFacts(), { ref: 'main', inputs: { environment: 'staging', version: 'ghp_' + 'a'.repeat(36) } });
    expect(r.ok).toBe(false);
  });
});
