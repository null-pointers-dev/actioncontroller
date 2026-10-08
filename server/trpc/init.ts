import 'server-only';
import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import { getCurrentUser } from '../auth/session';
import {
  AdmissionRejected,
  Conflict,
  CoreError,
  Forbidden,
  NotFound,
  UpstreamUnavailable,
  ValidationError,
  type Problem,
} from '../core/errors';

export async function createContext(opts: { headers: Headers }) {
  const user = await getCurrentUser(opts.headers);
  return { user, requestId: opts.headers.get('x-request-id') ?? randomUUID() };
}
export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  // SSE pings keep App Service's ~230 s idle timeout away (docs/08 §2.1).
  sse: { ping: { enabled: true, intervalMs: 15_000 }, client: { reconnectAfterInactivityMs: 40_000 } },
  errorFormatter({ shape, error, ctx }) {
    const cause = error.cause;
    let problems: Problem[] | undefined;
    if (cause instanceof CoreError && Array.isArray(cause.details['problems'])) problems = cause.details['problems'] as Problem[];
    if (cause instanceof ZodError) {
      problems = cause.issues.map((i) => ({ field: i.path.join('.'), code: i.code, message: i.message }));
    }
    return {
      ...shape,
      message: shape.data.code === 'INTERNAL_SERVER_ERROR' ? 'Something went wrong' : shape.message,
      data: {
        ...shape.data,
        stack: undefined,
        requestId: ctx?.requestId,
        problems,
        reason: cause instanceof CoreError ? cause.details['reason'] : undefined,
      },
    };
  },
});

function toTRPCError(err: CoreError): TRPCError {
  const code =
    err instanceof ValidationError
      ? 'BAD_REQUEST'
      : err instanceof AdmissionRejected
        ? 'UNPROCESSABLE_CONTENT'
        : err instanceof NotFound
          ? 'NOT_FOUND'
          : err instanceof Forbidden
            ? 'FORBIDDEN'
            : err instanceof Conflict
              ? 'CONFLICT'
              : err instanceof UpstreamUnavailable
                ? 'SERVICE_UNAVAILABLE'
                : 'INTERNAL_SERVER_ERROR';
  return new TRPCError({ code, message: err.message, cause: err });
}

const mapCoreErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof CoreError) throw toTRPCError(result.error.cause);
  if (!result.ok && result.error.code === 'INTERNAL_SERVER_ERROR') console.error('[trpc]', result.error.cause ?? result.error);
  return result;
});

// Simple per-process, per-user rate limit (300 calls / minute).
const buckets = new Map<string, { tokens: number; at: number }>();
const rateLimit = t.middleware(async ({ ctx, next, type }) => {
  if (type === 'subscription' || !ctx.user) return next();
  const now = Date.now();
  const b = buckets.get(ctx.user.id) ?? { tokens: 300, at: now };
  b.tokens = Math.min(300, b.tokens + ((now - b.at) / 60_000) * 300);
  b.at = now;
  if (b.tokens < 1) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Slow down a little' });
  b.tokens -= 1;
  buckets.set(ctx.user.id, b);
  return next();
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure.use(mapCoreErrors);

export const authedProcedure = publicProcedure.use(rateLimit).use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in' });
  return next({ ctx: { ...ctx, user: ctx.user, svc: { principal: ctx.user, correlationId: ctx.requestId } } });
});

export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: 'Admins only' });
  return next();
});
