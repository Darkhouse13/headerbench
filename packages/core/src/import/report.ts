import type { Profile, Variable } from '../model.js';

export type ImportFormat = 'modheader-a-v2' | 'modheader-a-v1' | 'modheader-b' | 'headerbench';

export interface ImportReportLine {
  level: 'info' | 'warning';
  /** Profile name the line is about, or null for file-level lines. */
  profile: string | null;
  message: string;
}

export interface ImportCounts {
  profiles: number;
  requestHeaders: number;
  responseHeaders: number;
  filters: number;
  redirects: number;
  blocks: number;
  mocks: number;
  variables: number;
  /** Items imported but switched off because they cannot run as-is. */
  disabled: number;
}

export interface ImportReport {
  format: ImportFormat | null;
  counts: ImportCounts;
  /** Number of unknown keys that were ignored, and their distinct names. */
  ignoredKeys: number;
  ignoredKeyNames: string[];
  lines: ImportReportLine[];
  /** Any error means nothing is imported from the file. */
  errors: string[];
}

export interface ImportResult {
  profiles: Profile[];
  variables: Variable[];
  report: ImportReport;
}

/** Collects report lines and unknown keys while an importer runs. */
export class ReportBuilder {
  readonly lines: ImportReportLine[] = [];
  readonly errors: string[] = [];
  private ignored = 0;
  private readonly ignoredNames = new Set<string>();

  info(profile: string | null, message: string): void {
    this.lines.push({ level: 'info', profile, message });
  }

  warn(profile: string | null, message: string): void {
    this.lines.push({ level: 'warning', profile, message });
  }

  error(message: string): void {
    this.errors.push(message);
  }

  /** Counts keys of `obj` that are not in `known`. */
  unknownKeys(obj: Record<string, unknown>, known: readonly string[]): void {
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) {
        this.ignored++;
        this.ignoredNames.add(key);
      }
    }
  }

  build(format: ImportFormat | null, profiles: Profile[], variables: Variable[]): ImportResult {
    const failed = this.errors.length > 0;
    const kept = failed ? [] : profiles;
    const keptVariables = failed ? [] : variables;
    const sum = (pick: (p: Profile) => { enabled: boolean }[]): number =>
      kept.reduce((n, p) => n + pick(p).length, 0);
    const disabled = kept.reduce(
      (n, p) =>
        n +
        [
          ...p.requestHeaders,
          ...p.responseHeaders,
          ...p.filters,
          ...p.redirects,
          ...p.blocks,
          ...p.mocks,
        ].filter((item) => !item.enabled).length,
      0,
    );
    return {
      profiles: kept,
      variables: keptVariables,
      report: {
        format,
        counts: {
          profiles: kept.length,
          requestHeaders: sum((p) => p.requestHeaders),
          responseHeaders: sum((p) => p.responseHeaders),
          filters: sum((p) => p.filters),
          redirects: sum((p) => p.redirects),
          blocks: sum((p) => p.blocks),
          mocks: sum((p) => p.mocks),
          variables: keptVariables.length,
          disabled,
        },
        ignoredKeys: this.ignored,
        ignoredKeyNames: [...this.ignoredNames].sort(),
        lines: this.lines,
        errors: this.errors,
      },
    };
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One-line summary, e.g. "3 profiles, 14 headers, 1 redirect imported; 1 row imported switched off". */
export function summarizeImport(report: ImportReport): string {
  if (report.errors.length > 0) return `Nothing imported: ${report.errors[0]}`;
  const c = report.counts;
  const parts = [
    plural(c.profiles, 'profile'),
    plural(c.requestHeaders + c.responseHeaders, 'header'),
  ];
  if (c.filters > 0) parts.push(plural(c.filters, 'filter'));
  if (c.redirects > 0) parts.push(plural(c.redirects, 'redirect'));
  if (c.blocks > 0) parts.push(plural(c.blocks, 'block'));
  if (c.mocks > 0) parts.push(plural(c.mocks, 'mock'));
  if (c.variables > 0) parts.push(plural(c.variables, 'variable'));
  let text = `${parts.join(', ')} imported`;
  if (c.disabled > 0) text += `; ${plural(c.disabled, 'item')} switched off (see details)`;
  if (report.ignoredKeys > 0) text += `; ${plural(report.ignoredKeys, 'unknown field')} ignored`;
  return text;
}
