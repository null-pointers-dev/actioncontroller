import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/server/auth/session';
import { authorize } from '@/server/core/access/access';
import { CoreError } from '@/server/core/errors';
import { getDb } from '@/server/db/client';
import { workflowJobs, workspaces } from '@/server/db/schema';
import { jobLogs } from '@/server/github/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Streams a job log through the server (the browser never sees tokens or signed URLs). */
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const user = await getCurrentUser(req.headers);
  if (!user) return new Response('Unauthorized', { status: 401 });
  const jobId = Number((await params).jobId);
  if (!Number.isFinite(jobId)) return new Response('Bad job id', { status: 400 });

  const [job] = await getDb()
    .select({ workspaceId: workflowJobs.workspaceId, fullName: workspaces.fullName })
    .from(workflowJobs)
    .innerJoin(workspaces, eq(workspaces.id, workflowJobs.workspaceId))
    .where(eq(workflowJobs.id, jobId))
    .limit(1);
  if (!job) return new Response('Not found', { status: 404 });
  try {
    await authorize(user, 'view', job.workspaceId);
  } catch (err) {
    return new Response('Not found', { status: err instanceof CoreError ? 404 : 500 });
  }
  try {
    const upstream = await jobLogs(job.workspaceId, job.fullName, jobId);
    return new Response(upstream.body, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=30' },
    });
  } catch (err) {
    return new Response(`Logs unavailable: ${(err as Error).message}`, { status: 502 });
  }
}
