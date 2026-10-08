/**
 * Database lifecycle CLI — no hand-written migrations anywhere.
 *
 *   pnpm db:push      drizzle-kit push (schema.ts -> DB) + guards + BullMQ schema
 *   pnpm db:reset     DROP everything, then push + guards + BullMQ + schema checks   (local only)
 *   pnpm db:check     run drizzle/checks/schema-checks.sql (on an empty database)
 *   pnpm db:generate  drizzle-kit generate (production migrations, generated from schema.ts)
 *   pnpm db:deploy    apply generated migrations + guards + BullMQ (what the worker does on start)
 */
import { closeDb } from '@/server/db/client';
import {
  applyGuards,
  migrateQueue,
  pushSchema,
  resetDatabase,
  runSchemaChecks,
  setupDatabaseOnStart,
} from '@/server/db/setup';
import { closeQueues } from '@/server/jobs/queues';

const command = process.argv[2];
const force = process.argv.includes('--force');

function assertLocalDatabase(): void {
  const url = new URL(process.env.DATABASE_URL ?? '');
  const local = ['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(url.hostname);
  if (process.env.NODE_ENV === 'production' || (!local && !force)) {
    console.error(`Refusing to reset ${url.hostname}: only local databases can be reset (use --force if you really mean it).`);
    process.exit(1);
  }
}

async function checks(): Promise<void> {
  const report = await runSchemaChecks();
  if (!report.passed) {
    console.error('\n✗ Schema checks FAILED:', report.error);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ ${report.lines.filter((l) => l.startsWith('ok')).length} schema checks passed`);
  }
}

try {
  switch (command) {
    case 'push':
      await pushSchema();
      await applyGuards();
      await migrateQueue();
      break;
    case 'reset':
      assertLocalDatabase();
      await resetDatabase();
      await pushSchema();
      await applyGuards();
      await migrateQueue();
      await checks();
      break;
    case 'check':
      await checks();
      break;
    case 'deploy':
      await setupDatabaseOnStart('migrate');
      break;
    default:
      console.error('Usage: tsx scripts/db.ts <push|reset|check|deploy> [--force]');
      process.exitCode = 1;
  }
} finally {
  await closeQueues();
  await closeDb();
}
