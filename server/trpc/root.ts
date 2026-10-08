import 'server-only';
import { createCallerFactory, router } from './init';
import { credentialsRouter, systemRouter } from './routers/admin';
import { liveRouter } from './routers/live';
import { meRouter } from './routers/me';
import { approvalsRouter, githubRunsRouter, runsRouter } from './routers/runs';
import { workflowsRouter } from './routers/workflows';
import { workspacesRouter } from './routers/workspaces';

export const appRouter = router({
  me: meRouter,
  workspaces: workspacesRouter,
  workflows: workflowsRouter,
  runs: runsRouter,
  githubRuns: githubRunsRouter,
  approvals: approvalsRouter,
  credentials: credentialsRouter,
  system: systemRouter,
  live: liveRouter,
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
