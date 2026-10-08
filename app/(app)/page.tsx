import { HomeView } from '@/features/home/home-view';
import { requireUser } from '@/server/auth/session';

export default async function HomePage() {
  const user = await requireUser();
  return <HomeView firstName={user.name.split(' ')[0] ?? user.name} />;
}
