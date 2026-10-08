import { defineConfig } from 'drizzle-kit';

// server/db/schema.ts is the single source of truth.
//   development: `pnpm db:push`     -> drizzle-kit push (no migration files)
//   production:  `pnpm db:generate` -> drizzle/migrations (generated, never hand-written),
//                applied automatically by the worker on start.
// Functions/triggers/roles/grants: drizzle/guards.sql, applied after every push/migrate.
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './drizzle/migrations',
  schemaFilter: ['cp', 'auth'], // the `bullmq` schema belongs to BullMQ
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  verbose: true,
});
