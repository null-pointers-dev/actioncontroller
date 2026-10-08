import { describe, expect, it } from 'vitest';
import { decide, type Principal, type WorkspaceFacts } from '@/server/core/access/policy';

const user = (over: Partial<Principal> = {}): Principal => ({ id: 'u1', role: 'user', isActive: true, groupIds: ['g-release'], ...over });
const facts = (over: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({ visibility: 'private', publicRole: null, archived: false, grants: [], ...over });

describe('access decisions', () => {
  it('hides private workspaces from people without grants', () => {
    const d = decide(user(), 'view', facts());
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.visible).toBe(false);
  });

  it('public viewer can see but not run', () => {
    const f = facts({ visibility: 'public', publicRole: 'viewer' });
    expect(decide(user(), 'view', f).allowed).toBe(true);
    expect(decide(user(), 'run', f).allowed).toBe(false);
  });

  it('group grant gives operator, limited to environments', () => {
    const f = facts({
      grants: [{ subjectType: 'group', subjectId: 'g-release', role: 'operator', canApprove: false, environments: ['staging'], expiresAt: null }],
    });
    expect(decide(user(), 'run', f, { environment: 'staging' }).allowed).toBe(true);
    expect(decide(user(), 'run', f, { environment: 'production' }).allowed).toBe(false);
  });

  it('expired grants are ignored', () => {
    const f = facts({
      grants: [{ subjectType: 'user', subjectId: 'u1', role: 'operator', canApprove: true, environments: null, expiresAt: new Date(Date.now() - 1000) }],
    });
    expect(decide(user(), 'view', f).allowed).toBe(false);
  });

  it('approvers cannot approve their own request', () => {
    const f = facts({ grants: [{ subjectType: 'user', subjectId: 'u1', role: 'viewer', canApprove: true, environments: null, expiresAt: null }] });
    expect(decide(user(), 'approve', f, { isRequester: false }).allowed).toBe(true);
    expect(decide(user(), 'approve', f, { isRequester: true }).allowed).toBe(false);
  });

  it('non-exposed workflows are invisible to non-admins', () => {
    const f = facts({ visibility: 'public', publicRole: 'operator' });
    const d = decide(user(), 'run', f, { workflowExposed: false });
    expect(d.allowed === false && d.visible).toBe(false);
    expect(decide(user({ role: 'admin' }), 'run', f, { workflowExposed: false }).allowed).toBe(true);
  });

  it('inactive users get nothing, even admins', () => {
    expect(decide(user({ role: 'admin', isActive: false }), 'view', facts()).allowed).toBe(false);
  });
});
