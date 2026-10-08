import { describe, expect, it } from 'vitest';
import { canTransition, githubStatusRank, phaseForGithubRun, PHASES } from '@/shared/phases';

describe('run-request state machine', () => {
  it('allows the happy path', () => {
    expect(canTransition('pending', 'dispatching')).toBe(true);
    expect(canTransition('dispatching', 'dispatched')).toBe(true);
    expect(canTransition('dispatched', 'running')).toBe(true);
    expect(canTransition('running', 'succeeded')).toBe(true);
  });
  it('never leaves a terminal phase', () => {
    for (const to of PHASES) {
      if (to !== 'succeeded') expect(canTransition('succeeded', to)).toBe(false);
    }
  });
  it('lets observation jump ahead of the dispatcher', () => {
    expect(canTransition('dispatching', 'running')).toBe(true);
    expect(canTransition('verifying', 'succeeded')).toBe(true);
  });
  it('cannot go from running back to pending', () => {
    expect(canTransition('running', 'pending')).toBe(false);
  });
});

describe('GitHub status ranks', () => {
  it('treats waiting and in_progress as the same rank', () => {
    expect(githubStatusRank('waiting', null)).toBe(githubStatusRank('in_progress', null));
  });
  it('treats action_required as not terminal', () => {
    expect(githubStatusRank('completed', 'action_required')).toBeLessThan(githubStatusRank('completed', 'success'));
  });
  it('maps GitHub states to request phases', () => {
    expect(phaseForGithubRun('queued', null)).toBe('dispatched');
    expect(phaseForGithubRun('in_progress', null)).toBe('running');
    expect(phaseForGithubRun('completed', 'success')).toBe('succeeded');
    expect(phaseForGithubRun('completed', 'cancelled')).toBe('cancelled');
    expect(phaseForGithubRun('completed', 'timed_out')).toBe('failed');
    expect(phaseForGithubRun('completed', 'action_required')).toBeNull();
  });
});
