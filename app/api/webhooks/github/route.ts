import { getDb } from '@/server/db/client';
import { webhookDeliveries } from '@/server/db/schema';
import { getEnv } from '@/server/env';
import { verifyWebhookSignature } from '@/server/github/webhook';
import { enqueue, Queues } from '@/server/jobs/queues';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GitHub deliveries: verify signature -> store (PK = delivery GUID, so duplicates are no-ops)
 * -> enqueue a BullMQ job -> 202. GitHub expects an answer within 10 s; the worker does the work.
 * If the enqueue fails after the insert, the checker's sweeper re-enqueues pending deliveries.
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

  let payload: Record<string, unknown> & { action?: string; repository?: { id?: number } };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  const inserted = await getDb()
    .insert(webhookDeliveries)
    .values({
      deliveryGuid: guid,
      eventType: event,
      action: payload.action ?? null,
      githubRepoId: payload.repository?.id ?? null,
      payload,
    })
    .onConflictDoNothing()
    .returning({ guid: webhookDeliveries.deliveryGuid });
  if (inserted.length > 0) {
    await enqueue(Queues.webhook, guid, { jobId: guid }).catch((err) =>
      console.error('[webhook] enqueue failed; sweeper will retry', (err as Error).message),
    );
  }
  return new Response(null, { status: 202 });
}
