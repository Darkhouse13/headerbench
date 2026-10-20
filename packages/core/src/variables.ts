import type { Variable } from './model.js';

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Names of `{{name}}` placeholders in `text`, in order of first appearance. */
export function variableRefs(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1] as string);
  return [...names];
}

export function usesVariables(text: string): boolean {
  return variableRefs(text).length > 0;
}

export interface Substitution {
  text: string;
  /** Placeholder names with no matching variable; their literal `{{name}}` is kept. */
  unresolved: string[];
}

export function substituteVariables(text: string, variables: readonly Variable[]): Substitution {
  const byName = new Map(variables.map((v) => [v.name, v.value]));
  const unresolved = new Set<string>();
  const out = text.replace(PLACEHOLDER, (literal, name: string) => {
    const value = byName.get(name);
    if (value === undefined) {
      unresolved.add(name);
      return literal;
    }
    return value;
  });
  return { text: out, unresolved: [...unresolved] };
}
