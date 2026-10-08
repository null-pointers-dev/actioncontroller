import 'server-only';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  DATABASE_AUTH: z.enum(['password', 'entra']).default('password'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Role every pooled connection switches to (cp_web / cp_worker). Empty locally. */
  DATABASE_ROLE: z.string().optional().transform((v) => v || undefined),
  /** Role used for migrations and partition DDL (owner of the schemas). Empty locally. */
  DATABASE_MIGRATION_ROLE: z.string().optional().transform((v) => v || undefined),

  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.url(),
  MICROSOFT_CLIENT_ID: z.string().min(1),
  MICROSOFT_CLIENT_SECRET: z.string().min(1),
  MICROSOFT_TENANT_ID: z.string().min(1),
  CP_ADMIN_GROUP_ID: z.string().optional().transform((v) => v || undefined),

  GITHUB_API_URL: z.url().default('https://api.github.com'),
  GITHUB_API_VERSION: z.string().default('2026-03-10'),
  GITHUB_WEBHOOK_SECRET: z.string().optional().transform((v) => v || undefined),
  PUBLIC_BASE_URL: z.string().optional().transform((v) => v || undefined),
  CP_SAML_ORG: z.string().optional().transform((v) => v || undefined),

  KEY_VAULT_URL: z.string().optional().transform((v) => v || undefined),

  CP_WORKER_PROCESSING: z.enum(['on', 'off']).default('on'),
  WORKER_HEALTH_PORT: z.coerce.number().int().default(8081),
  DISPATCH_VERIFY_WINDOW_SECONDS: z.coerce.number().int().default(90),
  DISPATCH_MAX_ATTEMPTS: z.coerce.number().int().default(3),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed lazily so `next build` can import server modules without runtime secrets. */
export function getEnv(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
      throw new Error(`Invalid configuration:\n  ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
