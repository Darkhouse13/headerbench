/** Asks Chrome's own RE2 engine whether a regex is usable, after local checks pass. */
import { checkRegex } from '@headerbench/core';
import { useEffect, useState } from 'preact/hooks';
import type { Platform } from '../platform';

export function useRegexCheck(platform: Platform, pattern: string, active: boolean): string | null {
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setProblem(null);
    if (!active || pattern.trim() === '' || checkRegex(pattern) !== null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      platform.regexProblem(pattern).then(
        (p) => !cancelled && setProblem(p),
        () => undefined,
      );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [platform, pattern, active]);
  return problem;
}
