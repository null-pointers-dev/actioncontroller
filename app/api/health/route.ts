import { sql } from 'drizzle-orm';
import { getDb } from '@/server/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ status: 'ok' });
  } catch (err) {
    return Response.json({ status: 'error', error: (err as Error).message }, { status: 503 });
  }
}
