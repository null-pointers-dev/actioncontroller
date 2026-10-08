import 'server-only';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '@/server/db/uow';
import { workspaceGrants, workspaces } from '@/server/db/schema';
import { Forbidden, NotFound } from '../errors';
import { capabilities, decide, type Action, type Capabilities, type DecisionInput, type Principal, type WorkspaceFacts } from './policy';

export type { Principal, Capabilities, Action } from './policy';

export async function loadWorkspaceFacts(workspaceId: string): Promise<WorkspaceFacts | null> {
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) return null;
  const grants = await db().select().from(workspaceGrants).where(eq(workspaceGrants.workspaceId, workspaceId));
  return {
    visibility: ws.visibility,
    publicRole: ws.publicRole,
    archived: ws.status === 'archived',
    grants: grants.map((g) => ({
      subjectType: g.subjectType,
      subjectId: g.subjectId,
      role: g.role,
      canApprove: g.canApprove,
      environments: g.environments,
      expiresAt: g.expiresAt,
    })),
  };
}

/** Throws NotFound (invisible) or Forbidden (visible but not allowed). Returns capabilities. */
export async function authorize(
  principal: Principal,
  action: Action,
  workspaceId: string,
  input: DecisionInput = {},
): Promise<Capabilities> {
  const facts = await loadWorkspaceFacts(workspaceId);
  if (!facts) throw new NotFound('Workspace not found');
  const decision = decide(principal, action, facts, input);
  if (decision.allowed) return decision.caps;
  if (!decision.visible) throw new NotFound('Workspace not found');
  throw new Forbidden(`Not allowed: ${decision.reason}`, { reason: decision.reason });
}

export function requireAdmin(principal: Principal): void {
  if (!principal.isActive || principal.role !== 'admin') throw new Forbidden('Admins only');
}

/** Workspaces the principal can see (ids). Admins: all except archived are listed separately. */
export async function visibleWorkspaceIds(principal: Principal): Promise<Set<string>> {
  if (!principal.isActive) return new Set();
  if (principal.role === 'admin') {
    const rows = await db().select({ id: workspaces.id }).from(workspaces);
    return new Set(rows.map((r) => r.id));
  }
  const subjects = [principal.id, ...principal.groupIds];
  const rows = await db()
    .selectDistinct({ id: workspaces.id })
    .from(workspaces)
    .leftJoin(workspaceGrants, eq(workspaceGrants.workspaceId, workspaces.id))
    .where(
      and(
        ne(workspaces.status, 'archived'),
        or(
          eq(workspaces.visibility, 'public'),
          and(
            inArray(workspaceGrants.subjectId, subjects),
            or(sql`${workspaceGrants.expiresAt} is null`, sql`${workspaceGrants.expiresAt} > now()`),
          ),
        ),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** Capabilities for many workspaces at once (lists, `me.get`). */
export async function capabilitiesFor(principal: Principal, workspaceIds: string[]): Promise<Map<string, Capabilities>> {
  const result = new Map<string, Capabilities>();
  if (workspaceIds.length === 0) return result;
  const wsRows = await db().select().from(workspaces).where(inArray(workspaces.id, workspaceIds));
  const grantRows = await db().select().from(workspaceGrants).where(inArray(workspaceGrants.workspaceId, workspaceIds));
  for (const ws of wsRows) {
    const facts: WorkspaceFacts = {
      visibility: ws.visibility,
      publicRole: ws.publicRole,
      archived: ws.status === 'archived',
      grants: grantRows
        .filter((g) => g.workspaceId === ws.id)
        .map((g) => ({
          subjectType: g.subjectType,
          subjectId: g.subjectId,
          role: g.role,
          canApprove: g.canApprove,
          environments: g.environments,
          expiresAt: g.expiresAt,
        })),
    };
    result.set(ws.id, capabilities(principal, facts));
  }
  return result;
}
