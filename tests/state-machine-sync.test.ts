import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canTransition, PHASES } from '@/shared/phases';

// The database guard (drizzle/guards.sql) and the app (shared/phases.ts) must agree exactly.
describe('state machine: app == database guard', () => {
  it('has the same transitions in shared/phases.ts and drizzle/guards.sql', () => {
    const sql = readFileSync(path.join(process.cwd(), 'drizzle/guards.sql'), 'utf8');
    const start = sql.indexOf('cp.phase_transition_allowed(p_from');
    const body = sql.slice(start, sql.indexOf('$$;', start));
    const fromSql = new Set([...body.matchAll(/\('(\w+)',\s*'(\w+)'\)/g)].map((m) => `${m[1]}>${m[2]}`));
    const fromTs = new Set<string>();
    for (const a of PHASES) for (const b of PHASES) if (a !== b && canTransition(a, b)) fromTs.add(`${a}>${b}`);
    expect([...fromSql].sort()).toEqual([...fromTs].sort());
  });
});
