// Pure access rules (no I/O) — see docs/02-identity-and-access.md §2.4.

export type WorkspaceRole = 'viewer' | 'operator';
export type Action = 'view' | 'run' | 'cancel' | 'rerun' | 'approve' | 'manage';

export interface Principal {
  id: string;
  role: 'admin' | 'user';
  isActive: boolean;
  groupIds: readonly string[];
}

export interface GrantFact {
  subjectType: 'user' | 'group';
  subjectId: string;
  role: WorkspaceRole;
  canApprove: boolean;
  environments: string[] | null;
  expiresAt: Date | null;
}

export interface WorkspaceFacts {
  visibility: 'private' | 'public';
  publicRole: WorkspaceRole | null;
  archived: boolean;
  grants: readonly GrantFact[];
}

export interface Capabilities {
  visible: boolean;
  isAdmin: boolean;
  role: WorkspaceRole | null;
  canApprove: boolean;
  /** 'any' = may run in every environment; otherwise the allowed list (may be empty). */
  runEnvironments: 'any' | string[];
}

const RANK: Record<WorkspaceRole, number> = { viewer: 1, operator: 2 };

export function capabilities(principal: Principal, facts: WorkspaceFacts, now = new Date()): Capabilities {
  const none: Capabilities = { visible: false, isAdmin: false, role: null, canApprove: false, runEnvironments: [] };
  if (!principal.isActive) return none;
  if (principal.role === 'admin') {
    return { visible: true, isAdmin: true, role: 'operator', canApprove: true, runEnvironments: 'any' };
  }
  if (facts.archived) return none;

  const groups = new Set(principal.groupIds);
  const grants = facts.grants.filter(
    (g) =>
      (!g.expiresAt || g.expiresAt > now) &&
      ((g.subjectType === 'user' && g.subjectId === principal.id) || (g.subjectType === 'group' && groups.has(g.subjectId))),
  );

  let role: WorkspaceRole | null = facts.visibility === 'public' ? facts.publicRole : null;
  for (const g of grants) if (!role || RANK[g.role] > RANK[role]) role = g.role;
  if (!role) return none;

  const unrestrictedOperator =
    (facts.visibility === 'public' && facts.publicRole === 'operator') ||
    grants.some((g) => g.role === 'operator' && !g.environments);
  const envs = new Set<string>();
  for (const g of grants) if (g.role === 'operator' && g.environments) g.environments.forEach((e) => envs.add(e));

  return {
    visible: true,
    isAdmin: false,
    role,
    canApprove: grants.some((g) => g.canApprove),
    runEnvironments: unrestrictedOperator ? 'any' : [...envs],
  };
}

export interface DecisionInput {
  environment?: string | null;
  workflowExposed?: boolean;
  isRequester?: boolean;
}

export type Decision =
  | { allowed: true; caps: Capabilities }
  | { allowed: false; visible: boolean; reason: string; caps: Capabilities };

export function decide(principal: Principal, action: Action, facts: WorkspaceFacts, input: DecisionInput = {}, now = new Date()): Decision {
  const caps = capabilities(principal, facts, now);
  const deny = (reason: string, visible = true): Decision => ({ allowed: false, visible, reason, caps });

  if (!caps.visible) return deny('not_visible', false);
  if (input.workflowExposed === false && !caps.isAdmin) return deny('not_visible', false);
  if (caps.isAdmin) return { allowed: true, caps };

  switch (action) {
    case 'view':
      return { allowed: true, caps };
    case 'run': {
      if (caps.role !== 'operator') return deny('requires_operator');
      if (caps.runEnvironments === 'any') return { allowed: true, caps };
      if (input.environment && caps.runEnvironments.includes(input.environment)) return { allowed: true, caps };
      return deny('environment_not_allowed');
    }
    case 'cancel':
    case 'rerun':
      return caps.role === 'operator' ? { allowed: true, caps } : deny('requires_operator');
    case 'approve':
      if (!caps.canApprove) return deny('requires_approver');
      if (input.isRequester) return deny('cannot_approve_own_request');
      return { allowed: true, caps };
    case 'manage':
      return deny('requires_admin');
  }
}
