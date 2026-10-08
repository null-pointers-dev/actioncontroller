import { describe, expect, it } from 'vitest';
import { matchesRefPattern, refAllowed } from '@/shared/glob';

describe('ref patterns', () => {
  it('matches within a segment', () => {
    expect(matchesRefPattern('release/1.9', 'release/*')).toBe(true);
    expect(matchesRefPattern('release/1.9/hotfix', 'release/*')).toBe(false);
  });
  it('matches across segments with **', () => {
    expect(matchesRefPattern('release/1.9/hotfix', 'release/**')).toBe(true);
  });
  it('treats an empty list as "any ref"', () => {
    expect(refAllowed('anything', null)).toBe(true);
    expect(refAllowed('main', ['main', 'release/*'])).toBe(true);
    expect(refAllowed('feature/x', ['main', 'release/*'])).toBe(false);
  });
});
