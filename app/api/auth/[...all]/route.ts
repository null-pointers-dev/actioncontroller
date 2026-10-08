import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/server/auth/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return toNextJsHandler(getAuth()).GET(req);
}
export function POST(req: Request) {
  return toNextJsHandler(getAuth()).POST(req);
}
