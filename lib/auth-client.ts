'use client';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();
export const signInWithMicrosoft = () => authClient.signIn.social({ provider: 'microsoft', callbackURL: '/' });
export const signOut = () => authClient.signOut({ fetchOptions: { onSuccess: () => window.location.assign('/sign-in') } });
