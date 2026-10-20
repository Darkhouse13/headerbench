/** Grid-based rule tables: one column template per table, inline issues under each row. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
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
        <div class="rtable__issues">
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
