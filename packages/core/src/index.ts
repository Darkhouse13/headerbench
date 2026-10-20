/**
 * @headerbench/core public API. Platform-free: no chrome.*, DOM or Node APIs beyond
 * URL, TextEncoder/TextDecoder and crypto.randomUUID.
 */
export * from './model.js';
export * from './dnr.js';
export * from './encoding.js';
export * from './validate.js';
export * from './variables.js';
export * from './items.js';
export * from './migrate.js';
export * from './compile.js';
export * from './urlfilter.js';
export * from './tester.js';
export * from './origins.js';
export * from './license.js';
export * from './presets.js';
export * from './export.js';
export { importAny, IMPORT_MAX_BYTES } from './import/index.js';
export { EXPORT_FORMAT_VERSION } from './import/headerbench.js';
export { regexToDomain } from './import/shared.js';
export { summarizeImport } from './import/report.js';
export type {
  ImportCounts,
  ImportFormat,
  ImportReport,
  ImportReportLine,
  ImportResult,
} from './import/report.js';
