import type { State, Variable } from '@headerbench/core';
import { checkVariableName, newId, variableRefs } from '@headerbench/core';
import { Braces, Plus, Trash2 } from 'lucide-preact';
import { Banner, Button, EmptyState, IconButton } from '../components/controls';
import { useSnapshot, useStore } from '../context';
import { RuleRow, RuleTable, Cell, onEnter, useFocusRow } from '../editor/table';
import type { RowIssue } from '../editor/issues';
import { navigate } from '../editor/router';
import { plural } from '../format';
import { proGate } from '../pro';

const TEMPLATE = 'minmax(160px, 0.8fr) minmax(240px, 2fr) 140px 36px';

/** How many rows reference `{{name}}`. */
function usage(state: State, name: string): number {
  let count = 0;
  for (const p of state.profiles) {
    const texts = [
      ...p.requestHeaders.map((h) => h.value),
      ...p.responseHeaders.map((h) => h.value),
      ...p.redirects.map((r) => r.to),
      ...p.mocks.map((m) => m.body),
    ];
    count += texts.filter((t) => variableRefs(t).includes(name)).length;
  }
  return count;
}

export function VariablesPage() {
  const store = useStore();
  const { pro } = useSnapshot();
  const state = store.state;
  const variables = state.settings.variables;
  const focusRow = useFocusRow();
  const gate = proGate(pro, store.platform.now(), 'Variables');

  const setVariables = (next: Variable[]): void =>
    store.update((s) => ({ ...s, settings: { ...s.settings, variables: next } }));
  const setRow = (id: string, patch: Partial<Variable>): void =>
    setVariables(variables.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const add = (index: number): void => {
    const row: Variable = { id: newId(), name: '', value: '' };
    const next = [...variables];
    next.splice(index + 1, 0, row);
    setVariables(next);
    focusRow(row.id);
  };

  const issuesFor = (v: Variable): RowIssue[] => {
    if (v.name === '') return [];
    const problem = checkVariableName(v.name);
    if (problem) return [{ tone: 'error', message: problem }];
    if (variables.some((o) => o.id !== v.id && o.name === v.name)) {
      return [
        {
          tone: 'error',
          message: `Another variable is already called ${v.name}. The first one wins.`,
        },
      ];
    }
    return [];
  };

  return (
    <div class="page">
      <header class="page__head">
        <h1>Variables</h1>
        <p class="muted">
          Write <code>{'{{name}}'}</code> in a header value, redirect target or mock body. Change
          the value here and every rule that uses it updates.
        </p>
      </header>
      {gate && (
        <Banner
          tone={gate.tone}
          actions={
            gate.offerPro && (
              <Button small onClick={() => navigate('#/pro')}>
                Get Pro
              </Button>
            )
          }
        >
          {gate.text}
        </Banner>
      )}
      <section class="card card__section">
        {variables.length === 0 ? (
          <EmptyState
            icon={Braces}
            title="No variables yet"
            action={
              <Button variant="primary" icon={Plus} onClick={() => add(-1)}>
                Add a variable
              </Button>
            }
          >
            Keep a token or a host name in one place, for example <code>{'{{api_token}}'}</code> in
            the Authorization header of every staging profile.
          </EmptyState>
        ) : (
          <>
            <RuleTable
              label="Variables"
              template={TEMPLATE}
              columns={['Name', 'Value', 'Used in', '']}
            >
              {variables.map((v, i) => {
                const uses = v.name ? usage(state, v.name) : 0;
                return (
                  <RuleRow key={v.id} id={v.id} enabled issues={issuesFor(v)}>
                    <Cell>
                      <input
                        class="input input--dense mono"
                        aria-label="Variable name"
                        spellcheck={false}
                        autocomplete="off"
                        value={v.name}
                        onInput={(e) => setRow(v.id, { name: e.currentTarget.value.trim() })}
                        onKeyDown={onEnter(() => add(i))}
                      />
                    </Cell>
                    <Cell>
                      <input
                        class="input input--dense mono"
                        aria-label="Variable value"
                        spellcheck={false}
                        autocomplete="off"
                        value={v.value}
                        onInput={(e) => setRow(v.id, { value: e.currentTarget.value })}
                        onKeyDown={onEnter(() => add(i))}
                      />
                    </Cell>
                    <Cell class="muted">{uses === 0 ? 'Not used yet' : plural(uses, 'row')}</Cell>
                    <Cell>
                      <IconButton
                        icon={Trash2}
                        small
                        label={`Delete ${v.name || 'this variable'}`}
                        onClick={() => setVariables(variables.filter((x) => x.id !== v.id))}
                      />
                    </Cell>
                  </RuleRow>
                );
              })}
            </RuleTable>
            <div class="panel__actions">
              <Button small icon={Plus} onClick={() => add(variables.length - 1)}>
                Add variable
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
