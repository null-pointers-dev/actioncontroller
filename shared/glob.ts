/** GitHub-style ref patterns: `*` matches within a path segment, `**` across segments. */
export function matchesRefPattern(ref: string, pattern: string): boolean {
  const source = pattern
    .split('**')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`).test(ref);
}

export function refAllowed(ref: string, patterns: readonly string[] | null | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => matchesRefPattern(ref, p));
}
