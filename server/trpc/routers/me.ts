import 'server-only';
import { setGithubUsernameInput } from '@/shared/schemas';
import { setGithubUsername } from '@/server/core/identity/identity';
import { authedProcedure, router } from '../init';

export const meRouter = router({
  get: authedProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    name: ctx.user.name,
    email: ctx.user.email,
    image: ctx.user.image,
    role: ctx.user.role,
    githubLogin: ctx.user.githubLogin,
    githubAvatarUrl: ctx.user.githubAvatarUrl,
    githubIdentitySource: ctx.user.githubIdentitySource,
  })),
  setGithubUsername: authedProcedure.input(setGithubUsernameInput).mutation(({ ctx, input }) => setGithubUsername(ctx.user, input.username)),
});
