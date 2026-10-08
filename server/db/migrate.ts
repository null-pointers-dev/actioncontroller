import 'server-only';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withOwnerRole } from './client';

/**
 * Applies drizzle/migrations/*.sql in name order, each in its own transaction, under a
 * Postgres advisory lock so only one process migrates at a time. Applied files are
 * recorded in public.cp_schema_migrations. Migrations must be expand-only within a release.
 */
export async function runMigrations(dir = path.resolve(process.cwd(), 'drizzle/migrations')): Promise<string[]> {
  const applied: string[] = [];
  await withOwnerRole(async (client) => {
    await client.query(`select pg_advisory_lock(hashtext('cp-migrations'))`);
    try {
      await client.query(
        `create table if not exists public.cp_schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
      );
      const done = new Set(
        (await client.query<{ name: string }>(`select name from public.cp_schema_migrations`)).rows.map((r) => r.name),
      );
      const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        if (done.has(file)) continue;
        const sqlText = await readFile(path.join(dir, file), 'utf8');
        await client.query('begin');
        try {
          await client.query(sqlText);
          await client.query(`insert into public.cp_schema_migrations (name) values ($1)`, [file]);
          await client.query('commit');
          applied.push(file);
        } catch (err) {
          await client.query('rollback');
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      await client.query(`select pg_advisory_unlock(hashtext('cp-migrations'))`).catch(() => undefined);
    }
  });
  return applied;
}
