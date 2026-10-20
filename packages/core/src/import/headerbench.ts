/** Headerbench's own export: `{ headerbench: 1, exportedAt, profiles, variables }`. */
import type { Profile, Variable } from '../model.js';
import { newId } from '../model.js';
import { isRecord, sanitizeProfile, sanitizeVariables } from '../migrate.js';
import type { ReportBuilder } from './report.js';
import { finalizeProfile } from './shared.js';

export const EXPORT_FORMAT_VERSION = 1;

const TOP_KEYS = ['headerbench', 'exportedAt', 'profiles', 'variables'];
const PROFILE_KEYS = [
  'id',
  'name',
  'badge',
  'color',
  'env',
  'requestHeaders',
  'responseHeaders',
  'filters',
  'resourceTypes',
  'methods',
  'redirects',
  'blocks',
  'mocks',
  'createdAt',
  'updatedAt',
];

export function isHeaderbench(json: unknown): json is Record<string, unknown> {
  return isRecord(json) && 'headerbench' in json;
}

export function importHeaderbench(
  json: Record<string, unknown>,
  report: ReportBuilder,
  now: number,
): { profiles: Profile[]; variables: Variable[] } {
  if (json.headerbench !== EXPORT_FORMAT_VERSION) {
    report.error(
      `This Headerbench export uses format ${String(json.headerbench)}. Update Headerbench to import it.`,
    );
    return { profiles: [], variables: [] };
  }
  report.unknownKeys(json, TOP_KEYS);
  if (!Array.isArray(json.profiles)) {
    report.error('The export has no "profiles" list.');
    return { profiles: [], variables: [] };
  }
  const profiles: Profile[] = [];
  json.profiles.forEach((entry, i) => {
    if (!isRecord(entry)) {
      report.error(`Profile ${i + 1} in the file is not an object.`);
      return;
    }
    report.unknownKeys(entry, PROFILE_KEYS);
    // Fresh ids so an import never collides with profiles that already exist.
    const profile = {
      ...sanitizeProfile(entry, i, now),
      id: newId(),
      createdAt: now,
      updatedAt: now,
    };
    profiles.push(finalizeProfile(profile, report));
  });
  return { profiles, variables: sanitizeVariables(json.variables) };
}
