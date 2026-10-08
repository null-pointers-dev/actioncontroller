import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/server/db/client';

/** Returns a fencing token if `holder` now holds the lease, otherwise null. */
export async function acquireLease(name: string, holder: string, ttlSeconds: number): Promise<number | null> {
  const res = await getDb().execute<{ token: string | null }>(
    sql`select cp.acquire_lease(${name}, ${holder}, ${`${ttlSeconds} seconds`}::interval) as token`,
  );
  const token = res.rows[0]?.token;
  return token === null || token === undefined ? null : Number(token);
}

export async function releaseLease(name: string, holder: string): Promise<void> {
  await getDb().execute(sql`delete from cp.leases where name = ${name} and holder = ${holder}`);
}
