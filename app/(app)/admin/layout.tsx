import type { ReactNode } from 'react';
import { requireAdminUser } from '@/server/auth/session';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminUser();
  return children;
}
