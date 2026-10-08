import 'server-only';
import { z } from 'zod';
import { workflowUpdateInput } from '@/shared/schemas';
import { getDefinitionForForm, getWorkflow, listWorkflows, searchRefs, updateWorkflow } from '@/server/core/workspaces/workspaces';
import { adminProcedure, authedProcedure, router } from '../init';

export const workflowsRouter = router({
  list: authedProcedure.input(z.object({ workspaceId: z.uuid() })).query(({ ctx, input }) => listWorkflows(ctx.svc, input.workspaceId)),
  get: authedProcedure.input(z.object({ workflowId: z.number().int() })).query(({ ctx, input }) => getWorkflow(ctx.svc, input.workflowId)),
  definition: authedProcedure
    .input(z.object({ workflowId: z.number().int(), ref: z.string().min(1).optional() }))
    .query(({ ctx, input }) => getDefinitionForForm(ctx.svc, input.workflowId, input.ref)),
  refs: authedProcedure
    .input(z.object({ workflowId: z.number().int(), q: z.string().max(100).default('') }))
    .query(({ ctx, input }) => searchRefs(ctx.svc, input.workflowId, input.q)),
  update: adminProcedure.input(workflowUpdateInput).mutation(({ ctx, input }) => updateWorkflow(ctx.svc, input)),
});
