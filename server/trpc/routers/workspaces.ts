import 'server-only';
import { z } from 'zod';
import { grantAddInput, repoFullName, workspaceImportInput, workspaceUpdateInput } from '@/shared/schemas';
import {
  addGrant,
  archiveWorkspace,
  attachCredential,
  detachCredential,
  getWorkspace,
  importRepository,
  listGrants,
  listWorkspaceCredentials,
  listWorkspaces,
  lookupRepository,
  removeGrant,
  requestSync,
  updateWorkspace,
} from '@/server/core/workspaces/workspaces';
import { adminProcedure, authedProcedure, router } from '../init';

const wsId = z.object({ workspaceId: z.uuid() });

export const workspacesRouter = router({
  list: authedProcedure.query(({ ctx }) => listWorkspaces(ctx.svc)),
  get: authedProcedure.input(wsId).query(({ ctx, input }) => getWorkspace(ctx.svc, input.workspaceId)),

  lookupRepository: adminProcedure.input(z.object({ fullName: repoFullName })).query(({ ctx, input }) => lookupRepository(ctx.svc, input.fullName)),
  import: adminProcedure.input(workspaceImportInput).mutation(({ ctx, input }) => importRepository(ctx.svc, input)),
  update: adminProcedure.input(workspaceUpdateInput).mutation(({ ctx, input }) => updateWorkspace(ctx.svc, input)),
  sync: adminProcedure.input(wsId).mutation(({ ctx, input }) => requestSync(ctx.svc, input.workspaceId)),
  archive: adminProcedure.input(wsId).mutation(({ ctx, input }) => archiveWorkspace(ctx.svc, input.workspaceId)),

  grants: router({
    list: adminProcedure.input(wsId).query(({ ctx, input }) => listGrants(ctx.svc, input.workspaceId)),
    add: adminProcedure.input(grantAddInput).mutation(({ ctx, input }) => addGrant(ctx.svc, input)),
    remove: adminProcedure.input(z.object({ grantId: z.uuid() })).mutation(({ ctx, input }) => removeGrant(ctx.svc, input.grantId)),
  }),

  credentials: router({
    list: adminProcedure.input(wsId).query(({ ctx, input }) => listWorkspaceCredentials(ctx.svc, input.workspaceId)),
    attach: adminProcedure
      .input(z.object({ workspaceId: z.uuid(), credentialId: z.uuid() }))
      .mutation(({ ctx, input }) => attachCredential(ctx.svc, input.workspaceId, input.credentialId)),
    detach: adminProcedure
      .input(z.object({ workspaceId: z.uuid(), credentialId: z.uuid() }))
      .mutation(({ ctx, input }) => detachCredential(ctx.svc, input.workspaceId, input.credentialId)),
  }),
});
