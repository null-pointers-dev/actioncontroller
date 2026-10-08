import 'server-only';
import { z } from 'zod';
import { approvalDecideInput, runActionInput, runCreateInput, runListInput, runValidateInput } from '@/shared/schemas';
import {
  approvalInbox,
  cancelRun,
  createRun,
  createRunAction,
  decideApproval,
  getRun,
  githubRunJobs,
  listGithubRuns,
  listRuns,
  runTimeline,
  validateRun,
} from '@/server/core/runs/service';
import { authedProcedure, router } from '../init';

const id = z.object({ id: z.uuid() });

export const runsRouter = router({
  validate: authedProcedure.input(runValidateInput).query(({ ctx, input }) => validateRun(ctx.svc, input)),
  create: authedProcedure.input(runCreateInput).mutation(async ({ ctx, input }) => {
    const row = await createRun(ctx.svc, input);
    return { id: row.id, phase: row.phase };
  }),
  list: authedProcedure.input(runListInput).query(({ ctx, input }) => listRuns(ctx.svc, input)),
  get: authedProcedure.input(id).query(({ ctx, input }) => getRun(ctx.svc, input.id)),
  timeline: authedProcedure.input(id).query(({ ctx, input }) => runTimeline(ctx.svc, input.id)),
  cancel: authedProcedure.input(id).mutation(({ ctx, input }) => cancelRun(ctx.svc, input.id)),
  action: authedProcedure.input(runActionInput).mutation(async ({ ctx, input }) => {
    const row = await createRunAction(ctx.svc, input);
    return { id: row.id, phase: row.phase };
  }),
});

export const githubRunsRouter = router({
  list: authedProcedure
    .input(z.object({ workspaceId: z.uuid(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(({ ctx, input }) => listGithubRuns(ctx.svc, input)),
  jobs: authedProcedure
    .input(z.object({ runId: z.number().int(), attempt: z.number().int() }))
    .query(({ ctx, input }) => githubRunJobs(ctx.svc, input)),
});

export const approvalsRouter = router({
  inbox: authedProcedure
    .input(z.object({ mode: z.enum(['waiting', 'all']).default('waiting') }))
    .query(({ ctx, input }) => approvalInbox(ctx.svc, input)),
  decide: authedProcedure.input(approvalDecideInput).mutation(({ ctx, input }) => decideApproval(ctx.svc, input)),
});
