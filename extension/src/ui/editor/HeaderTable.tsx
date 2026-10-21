import type { HeaderMod, HeaderOp, HeaderPreset, Profile } from '@headerbench/core';
import {
  HEADER_PRESETS,
  REQUEST_HEADER_NAMES,
  RESPONSE_HEADER_NAMES,
  newHeaderMod,
  valuePresetsFor,
} from '@headerbench/core';
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, Plus, Trash2 } from 'lucide-preact';
import { Button, EmptyState, IconButton, Switch } from '../components/controls';
import { Menu } from '../components/Menu';
import type { IssueMap, RowIssue } from './issues';
import { Cell, RuleRow, RuleTable, onEnter, memoRow, shown, useFocusRow, useStable } from './table';

interface Props {
  profile: Profile;
  direction: 'request' | 'response';
  issues: IssueMap;
  onChange: (mods: HeaderMod[]) => void;
}

const TEMPLATE = '44px minmax(210px, 1.3fr) 104px minmax(180px, 1.5fr) minmax(110px, 0.9fr) 36px';
const OPS: { value: HeaderOp; label: string }[] = [
  { value: 'set', label: 'Set' },
  { value: 'append', label: 'Append' },
  { value: 'remove', label: 'Remove' },
];

interface RowProps {
  mod: HeaderMod;
  index: number;
  issues: readonly RowIssue[] | undefined;
  listId: string;
  setRow: (id: string, patch: Partial<HeaderMod>) => void;
  addAfter: (index: number) => void;
  remove: (id: string) => void;
}

const HeaderRow = memoRow(function HeaderRow({
  mod: m,
  index,
  issues,
  listId,
  setRow,
  addAfter,
  remove,
}: RowProps) {
  const presetValues = valuePresetsFor(m.name);
  const pristine = m.name === '' && m.value === '' && m.comment === '';
  const add = onEnter(() => addAfter(index));
  return (
    <RuleRow id={m.id} enabled={m.enabled} issues={shown(issues, pristine)}>
      <Cell>
        <Switch
          small
          checked={m.enabled}
          label={m.name.trim() || 'Unnamed header'}
          onChange={(enabled) => setRow(m.id, { enabled })}
        />
      </Cell>
      <Cell>
        <input
          class="input input--dense mono"
          list={listId}
          aria-label="Header name"
          spellcheck={false}
          autocomplete="off"
          value={m.name}
          onInput={(e) => setRow(m.id, { name: e.currentTarget.value })}
          onKeyDown={add}
        />
      </Cell>
      <Cell>
        <select
          class="select select--dense"
          aria-label="Action"
          value={m.op}
          onChange={(e) => setRow(m.id, { op: e.currentTarget.value as HeaderOp })}
        >
          {OPS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Cell>
      <Cell class="rtable__cell--value">
        <input
          class="input input--dense mono"
          aria-label="Value"
          spellcheck={false}
          autocomplete="off"
          disabled={m.op === 'remove'}
          value={m.op === 'remove' ? '' : m.value}
          onInput={(e) => setRow(m.id, { value: e.currentTarget.value })}
          onKeyDown={add}
        />
        {presetValues.length > 0 && m.op !== 'remove' && (
          <Menu
            entries={presetValues.map((p) => ({
              label: p.label,
              description: p.value.length > 48 ? `${p.value.slice(0, 48)}…` : p.value,
              onSelect: () => setRow(m.id, { value: p.value }),
            }))}
            trigger={(props) => (
              <IconButton icon={ChevronDown} small label={`Common ${m.name} values`} {...props} />
            )}
          />
        )}
      </Cell>
      <Cell>
        <input
          class="input input--dense"
          aria-label="Comment"
          value={m.comment}
          title={m.comment}
          onInput={(e) => setRow(m.id, { comment: e.currentTarget.value })}
          onKeyDown={add}
        />
      </Cell>
      <Cell>
        <IconButton
          icon={Trash2}
          small
          label={`Delete ${m.name || 'this row'}`}
          onClick={() => remove(m.id)}
        />
      </Cell>
    </RuleRow>
  );
});

export function HeaderTable({ profile, direction, issues, onChange }: Props) {
  const mods = direction === 'request' ? profile.requestHeaders : profile.responseHeaders;
  const focusRow = useFocusRow();
  const listId = `header-names-${direction}`;
  const names = direction === 'request' ? REQUEST_HEADER_NAMES : RESPONSE_HEADER_NAMES;
  const presets = HEADER_PRESETS.filter((p) => p.direction === direction);
  const noun = direction === 'request' ? 'request header' : 'response header';

  const setRow = useStable((id: string, patch: Partial<HeaderMod>): void =>
    onChange(mods.map((m) => (m.id === id ? { ...m, ...patch } : m))),
  );
  const addAfter = useStable((index: number): void => {
    const row = newHeaderMod();
    const next = [...mods];
    next.splice(index + 1, 0, row);
    onChange(next);
    focusRow(row.id);
  });
  const remove = useStable((id: string): void => onChange(mods.filter((x) => x.id !== id)));
  const addPreset = (preset: HeaderPreset): void =>
    onChange([
      ...mods,
      ...preset.rows.map((r) =>
        newHeaderMod({ name: r.name, op: r.op, value: r.value, comment: r.note }),
      ),
    ]);

  const Icon = direction === 'request' ? ArrowUpFromLine : ArrowDownToLine;

  return (
    <div class="panel">
      {presets.length > 0 && (
        <div class="panel__toolbar">
          <span class="muted">Presets</span>
          {presets.map((p) => (
            <Button key={p.id} small onClick={() => addPreset(p)}>
              {p.label}
            </Button>
          ))}
        </div>
      )}
      {mods.length === 0 ? (
        <EmptyState
          icon={Icon}
          title={`No ${noun}s yet`}
          action={
            <Button variant="primary" icon={Plus} onClick={() => addAfter(-1)}>
              Add a {noun}
            </Button>
          }
        >
          {direction === 'request'
            ? 'Add a header to send with every request this profile covers: an API key, a Bearer token or a different User-Agent.'
            : 'Change what responses tell the browser, for example to allow CORS or to drop a Content-Security-Policy.'}
        </EmptyState>
      ) : (
        <>
          <datalist id={listId}>
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <RuleTable
            label={direction === 'request' ? 'Request headers' : 'Response headers'}
            template={TEMPLATE}
            columns={['On', 'Name', 'Action', 'Value', 'Comment', '']}
          >
            {mods.map((m, i) => (
              <HeaderRow
                key={m.id}
                mod={m}
                index={i}
                issues={issues.get(m.id)}
                listId={listId}
                setRow={setRow}
                addAfter={addAfter}
                remove={remove}
              />
            ))}
          </RuleTable>
          <div class="panel__actions">
            <Button small icon={Plus} onClick={() => addAfter(mods.length - 1)}>
              Add {noun}
            </Button>
            <span class="muted small">Press Enter in a row to add another below it.</span>
          </div>
        </>
      )}
      <p class="panel__help">
        {direction === 'request'
          ? 'Set replaces the header and Remove deletes it. Chrome can append only to standard list headers such as Accept-Language, Cookie, Cache-Control and User-Agent; other appends are sent as Set.'
          : 'Response headers are changed before the page sees them, so they affect CORS, Content-Security-Policy and caching. Set-Cookie changes are not visible to fetch().'}
      </p>
    </div>
  );
}
