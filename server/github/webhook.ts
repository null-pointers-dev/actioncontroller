import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verifies X-Hub-Signature-256 over the exact raw body. */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`);
  const received = Buffer.from(signatureHeader);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
