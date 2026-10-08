import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { loadPrincipal, type CurrentUser } from '../core/identity/identity';
import { getAuth } from './auth';

export async function getCurrentUser(requestHeaders?: Headers): Promise<CurrentUser | null> {
  const session = await getAuth().api.getSession({ headers: requestHeaders ?? (await headers()) });
  if (!session) return null;
  const user = await loadPrincipal(session.user.id);
  return user?.isActive ? user : null;
}

/** For Server Components / layouts. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) return redirect('/sign-in');
  return user;
}

export async function requireAdminUser(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== 'admin') redirect('/');
  return user;
}
