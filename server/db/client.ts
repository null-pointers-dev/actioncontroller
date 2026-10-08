import 'server-only';
import { DefaultAzureCredential } from '@azure/identity';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getEnv } from '../env';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

/** Scope for Microsoft Entra tokens accepted by Azure Database for PostgreSQL. */
const AZURE_PG_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

function connectionConfig(): pg.PoolConfig {
  const env = getEnv();
  const config: pg.PoolConfig = {
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    application_name: process.env.CP_PROCESS_NAME ?? 'control-plane',
  };
  if (env.DATABASE_AUTH === 'entra') {
    // Passwordless: the App Service managed identity gets a short-lived token per new connection.
    const credential = new DefaultAzureCredential();
    config.password = async () => (await credential.getToken(AZURE_PG_SCOPE)).token;
    config.ssl = { rejectUnauthorized: true };
  }
  return config;
}

interface DbGlobals {
  pool?: pg.Pool;
  db?: Db;
}
// Survives Next.js dev hot-reload (one pool per process).
const globals = globalThis as typeof globalThis & { __cpDb?: DbGlobals };
globals.__cpDb ??= {};

export function getPool(): pg.Pool {
  const g = globals.__cpDb!;
  if (!g.pool) {
    g.pool = new pg.Pool(connectionConfig());
    g.pool.on('error', (err) => console.error('[db] idle client error', err));
    const role = getEnv().DATABASE_ROLE;
    if (role) {
      // Least privilege: the login identity is a member of cp_web / cp_worker (docs/08 §2.2).
      g.pool.on('connect', (client) => {
        client.query(`set role ${pg.escapeIdentifier(role)}`).catch((err) => console.error('[db] set role failed', err));
      });
    }
  }
  return g.pool;
}

export function getDb(): Db {
  const g = globals.__cpDb!;
  g.db ??= drizzle(getPool(), { schema });
  return g.db;
}

/** A dedicated connection for LISTEN (must not go through a transaction-mode pooler). */
export async function createListenClient(): Promise<pg.Client> {
  const client = new pg.Client(connectionConfig());
  await client.connect();
  return client;
}

/** Runs DDL (migrations, partitions) as the schema owner role, if one is configured. */
export async function withOwnerRole<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const owner = getEnv().DATABASE_MIGRATION_ROLE;
  try {
    if (owner) {
      await client.query('reset role');
      await client.query(`set role ${pg.escapeIdentifier(owner)}`);
    }
    return await fn(client);
  } finally {
    if (owner) await client.query('reset role').catch(() => undefined);
    const role = getEnv().DATABASE_ROLE;
    if (role) await client.query(`set role ${pg.escapeIdentifier(role)}`).catch(() => undefined);
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  const g = globals.__cpDb!;
  await g.pool?.end();
  g.pool = undefined;
  g.db = undefined;
}
