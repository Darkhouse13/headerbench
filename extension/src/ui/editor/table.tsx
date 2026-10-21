/** Grid-based rule tables: one column template per table, inline issues under each row. */
import type { ComponentChildren, FunctionComponent } from 'preact';
import { Component, h } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Issue } from '../components/controls';
import type { RowIssue } from './issues';

interface TableProps {
  label: string;
  /** CSS grid-template-columns for header and rows. */
  template: string;
  columns: readonly string[];
  children: ComponentChildren;
}

export function RuleTable({ label, template, columns, children }: TableProps) {
  return (
    <div class="rtable" role="table" aria-label={label} style={{ '--cols': template }}>
      <div class="rtable__head" role="row">
        {columns.map((c, i) => (
          <div key={i} class="rtable__th" role="columnheader">
            {c}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

interface RowProps {
  id: string;
  enabled: boolean;
  issues: readonly RowIssue[];
  children: ComponentChildren;
}

export function RuleRow({ id, enabled, issues, children }: RowProps) {
  return (
    <div class={enabled ? 'rtable__row' : 'rtable__row is-off'} role="row" data-row={id}>
      <div class="rtable__cells">{children}</div>
      {issues.length > 0 && (
        <div class="rtable__issues" role="cell">
          {issues.map((issue, i) => (
            <Issue key={i} tone={issue.tone}>
              {issue.message}
            </Issue>
          ))}
        </div>
      )}
    </div>
  );
}

export function Cell({
  children,
  class: className,
}: {
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <div class={className ? `rtable__cell ${className}` : 'rtable__cell'} role="cell">
      {children}
    </div>
  );
}

/** Returns a function that focuses the first field of a row once it has rendered. */
export function useFocusRow(): (rowId: string) => void {
  const [pending, setPending] = useState<string | null>(null);
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (pending === null || done.current === pending) return;
    const field = document.querySelector<HTMLElement>(
      `[data-row="${CSS.escape(pending)}"] input:not([type="checkbox"]), [data-row="${CSS.escape(pending)}"] textarea`,
    );
    if (field) {
      field.focus();
      done.current = pending;
      setPending(null);
    }
  });
  return setPending;
}

/** Enter in a row field adds a row after it (ARCHITECTURE: "Enter adds a row"). */
export function onEnter(add: () => void) {
  return (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      add();
    }
  };
}

/** A just-added row has no content yet; its "empty" errors would only be noise. */
export function shown(issues: readonly RowIssue[] | undefined, pristine: boolean): RowIssue[] {
  return pristine ? [] : [...(issues ?? [])];
}

/**
 * A callback that keeps its identity across renders but always runs the latest `fn`, so rows
 * memoised with `memo` do not re-render just because a parent closure changed.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

const sameIssues = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/**
 * Props equality for rule rows: compared by identity (the row object changes only when that row
 * is edited), except `issues`, which is rebuilt on every edit and compared by content.
 */
export function rowPropsEqual<P extends object>(prev: P, next: P): boolean {
  const keys = Object.keys(next) as (keyof P)[];
  if (keys.length !== Object.keys(prev).length) return false;
  return keys.every((k) =>
    k === 'issues' ? sameIssues(prev[k], next[k]) : Object.is(prev[k], next[k]),
  );
}

/**
 * A rule row that re-renders only when `rowPropsEqual` says its props changed. (Preact's own
 * `memo` lives in preact/compat, which also rewrites event handlers app-wide.)
 */
export function memoRow<P extends object>(render: FunctionComponent<P>): FunctionComponent<P> {
  class MemoRow extends Component<P> {
    override shouldComponentUpdate(next: P): boolean {
      return !rowPropsEqual(this.props, next);
    }
    override render() {
      return h(render, this.props);
    }
  }
  return MemoRow as unknown as FunctionComponent<P>;
}
