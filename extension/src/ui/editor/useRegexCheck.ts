/**
 * Asks Chrome's RE2 engine (isRegexSupported) about a regex, only once core's `checkRegex` accepts
 * it. Core is authoritative first: Chrome says yes to non-ASCII patterns it then refuses to install,
 * and core's message for those is shown with the row's other issues.
 */
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
