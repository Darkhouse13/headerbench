import { EXPORT_FORMAT_VERSION } from './import/headerbench.js';
import type { Profile, State, Variable } from './model.js';

export interface HeaderbenchExport {
  headerbench: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  profiles: Profile[];
  variables: Variable[];
}

/**
 * Pretty-printed Headerbench JSON. The licence and settings are never exported.
 * `profileIds` limits the export to those profiles (all by default).
 */
export function exportJson(
  state: State,
  options: { profileIds?: readonly string[]; now?: number } = {},
): string {
  const ids = options.profileIds ? new Set(options.profileIds) : null;
  const data: HeaderbenchExport = {
    headerbench: EXPORT_FORMAT_VERSION,
    exportedAt: new Date(options.now ?? Date.now()).toISOString(),
    profiles: state.profiles.filter((p) => ids === null || ids.has(p.id)),
    variables: state.settings.variables,
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** File name for a download, e.g. `headerbench-2026-10-11.json`. */
export function exportFileName(now: number = Date.now()): string {
  return `headerbench-${new Date(now).toISOString().slice(0, 10)}.json`;
}
