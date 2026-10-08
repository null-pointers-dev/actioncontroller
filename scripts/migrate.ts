import { runMigrations } from '@/server/db/migrate';
import { closeDb } from '@/server/db/client';

const applied = await runMigrations();
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
await closeDb();
