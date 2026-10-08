import 'server-only';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { getEnv } from '@/server/env';
import { db, pgErrorCode, recordEvent, unitOfWork } from '@/server/db/uow';
import { directoryGroups, userGroups, users } from '@/server/db/schema';
import { getUserById, getUserByLogin, lookupSamlLogin } from '@/server/github/api';
import { Conflict, NotFound, ValidationError } from '../errors';
import type { Principal } from '../access/policy';

export interface CurrentUser extends Principal {
  name: string;
  email: string;
  image: string | null;
  githubLogin: string | null;
  githubAvatarUrl: string | null;
  githubIdentitySource: 'saml' | 'self_declared' | 'admin' | null;
}

export async function loadPrincipal(userId: string): Promise<CurrentUser | null> {
  const [u] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return null;
  const groups = await db().select({ id: userGroups.groupId }).from(userGroups).where(eq(userGroups.userId, userId));
  return {
    id: u.id,
    role: u.role,
    isActive: u.isActive,
    groupIds: groups.map((g) => g.id),
    name: u.name,
    email: u.email,
    image: u.image,
    githubLogin: u.githubLogin,
    githubAvatarUrl: u.githubAvatarUrl,
    githubIdentitySource: u.githubIdentitySource,
  };
}

interface EntraClaims {
  oid?: string;
  groups?: string[];
  preferred_username?: string;
  upn?: string;
  email?: string;
}

/** Reads claims from an ID token received directly from Entra by Better Auth's code exchange. */
export function decodeIdToken(idToken: string | null | undefined): EntraClaims {
  if (!idToken) return {};
  const payload = idToken.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as EntraClaims;
  } catch {
    return {};
  }
}

/**
 * Called after every Microsoft sign-in: Entra object id, group membership, admin role.
 * Configure the app registration to emit only groups assigned to the application.
 */
export async function syncFromSignIn(userId: string, idToken: string | null | undefined): Promise<void> {
  const claims = decodeIdToken(idToken);
  const groups = [...new Set(claims.groups ?? [])];
  const adminGroup = getEnv().CP_ADMIN_GROUP_ID;

  await unitOfWork({ actor: { kind: 'system', id: 'sign-in' } }, async () => {
    const [before] = await db().select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!before) return;
    const role = adminGroup ? (groups.includes(adminGroup) ? 'admin' : 'user') : before.role;

    await db()
      .update(users)
      .set({ entraObjectId: claims.oid ?? undefined, lastLoginAt: new Date(), role })
      .where(eq(users.id, userId));

    if (groups.length > 0) {
      await db()
        .insert(directoryGroups)
        .values(groups.map((id) => ({ id })))
        .onConflictDoUpdate({ target: directoryGroups.id, set: { lastSeenAt: new Date() } });
      await db()
        .insert(userGroups)
        .values(groups.map((groupId) => ({ userId, groupId })))
        .onConflictDoUpdate({ target: [userGroups.userId, userGroups.groupId], set: { syncedAt: new Date() } });
      await db().delete(userGroups).where(and(eq(userGroups.userId, userId), notInArray(userGroups.groupId, groups)));
    } else {
      await db().delete(userGroups).where(eq(userGroups.userId, userId));
    }

    if (role !== before.role) {
      recordEvent({
        type: 'cp.identity.role_changed',
        subject: `users/${userId}`,
        aggregateType: 'user',
        aggregateId: userId,
        data: { userId, from: before.role, to: role },
      });
    }
  });
}

/** Best-effort, never blocks sign-in (docs/02 §3). */
export async function refreshGithubIdentity(userId: string, nameId?: string): Promise<void> {
  try {
    const [u] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) return;
    let found: { id: number; login: string; avatarUrl: string | null } | null = null;
    let source = u.githubIdentitySource;
    if (u.githubUserId) {
      found = await getUserById(u.githubUserId);
    } else {
      const org = getEnv().CP_SAML_ORG;
      if (org && (nameId ?? u.email)) {
        found = await lookupSamlLogin(org, nameId ?? u.email);
        source = 'saml';
      }
    }
    if (!found) return;
    await unitOfWork({ actor: { kind: 'system', id: 'github-identity' } }, async () => {
      await db()
        .update(users)
        .set({
          githubUserId: found.id,
          githubLogin: found.login,
          githubAvatarUrl: found.avatarUrl,
          githubIdentitySource: source ?? 'saml',
          githubSyncedAt: new Date(),
        })
        .where(eq(users.id, userId));
      if (found.login !== u.githubLogin) {
        recordEvent({
          type: 'cp.identity.github_linked',
          subject: `users/${userId}`,
          aggregateType: 'user',
          aggregateId: userId,
          data: { userId, githubLogin: found.login, source: source ?? 'saml' },
        });
      }
    });
  } catch (err) {
    console.warn('[identity] GitHub identity refresh failed', (err as Error).message);
  }
}

export async function setGithubUsername(user: Principal, username: string): Promise<{ login: string }> {
  const found = await getUserByLogin(username);
  if (!found) throw new ValidationError([{ field: 'username', code: 'not_found', message: 'No GitHub user with that name' }]);
  try {
    await unitOfWork({ actor: { kind: 'user', id: user.id } }, async () => {
      await db()
        .update(users)
        .set({
          githubUserId: found.id,
          githubLogin: found.login,
          githubAvatarUrl: found.avatarUrl,
          githubIdentitySource: 'self_declared',
          githubSyncedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      recordEvent({
        type: 'cp.identity.github_linked',
        subject: `users/${user.id}`,
        aggregateType: 'user',
        aggregateId: user.id,
        data: { userId: user.id, githubLogin: found.login, source: 'self_declared' },
      });
    });
  } catch (err) {
    if (pgErrorCode(err) === '23505') throw new Conflict('That GitHub account is already linked to another user');
    throw err;
  }
  return { login: found.login };
}

export async function findUserIdByEmail(email: string): Promise<string> {
  const [u] = await db()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  if (!u) throw new NotFound(`No user with email ${email} has signed in yet`);
  return u.id;
}

export async function displayNames(ids: string[]): Promise<Map<string, { name: string; githubLogin: string | null }>> {
  const map = new Map<string, { name: string; githubLogin: string | null }>();
  if (ids.length === 0) return map;
  const rows = await db()
    .select({ id: users.id, name: users.name, githubLogin: users.githubLogin })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]));
  for (const r of rows) map.set(r.id, { name: r.name, githubLogin: r.githubLogin });
  return map;
}
