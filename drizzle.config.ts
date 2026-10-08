import { defineConfig } from 'drizzle-kit';

// Migrations are hand-written SQL in drizzle/migrations (they include triggers and
// functions drizzle-kit can't express). drizzle-kit is used for `studio` and `check`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './drizzle/kit',
  schemaFilter: ['cp', 'auth'],
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
