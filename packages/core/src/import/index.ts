import { isHeaderbench, importHeaderbench } from './headerbench.js';
import { importModHeaderA, isModHeaderA } from './modheaderA.js';
import { importModHeaderB, isModHeaderB } from './modheaderB.js';
import type { ImportResult } from './report.js';
import { ReportBuilder } from './report.js';

/** Files above this size are refused; real exports are a few KB. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Detects the format of `text` and converts it. Never throws: problems are reported in
 * `report.errors` (nothing imported) or `report.lines` (imported with notes).
 */
export function importAny(text: string, now: number = Date.now()): ImportResult {
  const report = new ReportBuilder();
  if (text.length > IMPORT_MAX_BYTES) {
    report.error('The file is larger than 5 MB, which is too big for a profile export.');
    return report.build(null, [], []);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    report.error(
      'The file is not valid JSON. Export it again from ModHeader or Headerbench and paste the whole file.',
    );
    return report.build(null, [], []);
  }
  try {
    if (isHeaderbench(json)) {
      const { profiles, variables } = importHeaderbench(json, report, now);
      return report.build('headerbench', profiles, variables);
    }
    if (isModHeaderB(json)) {
      return report.build(
        'modheader-b',
        importModHeaderB(json as Record<string, unknown>, report, now),
        [],
      );
    }
    if (isModHeaderA(json)) {
      const { format, profiles } = importModHeaderA(json, report, now);
      return report.build(format, profiles, []);
    }
  } catch (err) {
    report.error(`The file could not be read: ${(err as Error).message}`);
    return report.build(null, [], []);
  }
  report.error(
    'This is not a ModHeader or Headerbench export. Expected a list of ModHeader profiles, a ModHeader clone export, or a Headerbench export.',
  );
  return report.build(null, [], []);
}
