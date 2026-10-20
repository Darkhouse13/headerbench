/**
 * "Copy diagnostics" text for support emails. It contains counts, warnings and granted origins,
 * never header values, variable values or the licence key.
 */
import type { Snapshot } from '../messages';

export interface DiagnosticsInput {
  snapshot: Snapshot;
  origins: string[];
  userAgent: string;
  e2e: boolean;
  now: number;
}

const iso = (ms: number | null): string => (ms === null ? 'none' : new Date(ms).toISOString());

export function buildDiagnostics(input: DiagnosticsInput): string {
  const { snapshot: s, origins } = input;
  const { state, pro, stats } = s;
  const activations = state.settings.activations;
  const tabScoped = activations.filter((a) => a.tabId !== null).length;
  const timed = activations.filter((a) => a.pauseAt !== null).length;
  const lines = [
    `Headerbench ${s.version}${input.e2e ? ' (E2E build)' : ''}`,
    `Browser: ${input.userAgent}`,
    `Generated: ${new Date(input.now).toISOString()}`,
    `Profiles: ${state.profiles.length}; on: ${activations.length} (${tabScoped} this-tab-only, ${timed} with auto-pause); paused: ${state.settings.paused ? 'yes' : 'no'}`,
    `Rules: ${stats.dynamic} dynamic, ${stats.session} session, ${stats.unsafe} header/redirect, ${stats.regex} regex`,
    `Rule error: ${s.ruleError ?? 'none'}`,
    `Pro: ${pro.pro ? pro.source : 'off'}; plan: ${pro.plan ?? 'none'}; licence expires: ${iso(pro.licenseExpiresAt)}; trial ends: ${iso(pro.trialEndsAt)}`,
    `Sync: ${state.settings.sync ? 'on' : 'off'}${s.sync.error ? ` (${s.sync.error})` : ''}`,
    `Variables: ${state.settings.variables.length}`,
    `Unreadable data kept: ${s.hasCorruptData ? 'yes' : 'no'}`,
    `Site access: ${origins.length > 0 ? origins.join(', ') : 'none'}`,
    `Warnings (${s.warnings.length}):`,
    ...s.warnings.map((w) => {
      const profile = state.profiles.find((p) => p.id === w.profileId)?.name ?? 'all';
      return `- [${w.code}] ${profile}: ${w.message}`;
    }),
  ];
  return lines.join('\n');
}
