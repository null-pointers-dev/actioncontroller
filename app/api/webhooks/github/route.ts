import { sql } from 'drizzle-orm';
import { getDb } from '@/server/db/client';
import { getEnv } from '@/server/env';
import { verifyWebhookSignature } from '@/server/github/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GitHub deliveries: verify signature -> dedupe + store -> 202. Nothing else happens here
 * (GitHub expects an answer within 10 s); the worker processes stored deliveries.
 */
export async function POST(req: Request): Promise<Response> {
  const secret = getEnv().GITHUB_WEBHOOK_SECRET;
  if (!secret) return new Response('Webhooks are not configured', { status: 404 });

  const raw = await req.text();
  if (!verifyWebhookSignature(raw, req.headers.get('x-hub-signature-256'), secret)) {
    return new Response('Invalid signature', { status: 401 });
  }
  const guid = req.headers.get('x-github-delivery');
  const event = req.headers.get('x-github-event');
  if (!guid || !event) return new Response('Missing delivery headers', { status: 400 });

  let payload: { action?: string; repository?: { id?: number } };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  await getDb().execute(
    sql`select cp.ingest_webhook(${guid}::uuid, ${event}, ${payload.action ?? null}, ${payload.repository?.id ?? null}, ${raw}::jsonb)`,
  );
  return new Response(null, { status: 202 });
}
