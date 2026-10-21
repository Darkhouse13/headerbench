import type { FilterKind, Method, Profile, ResourceType, UrlFilter } from '@headerbench/core';
import { METHODS, RESOURCE_TYPES, newId } from '@headerbench/core';
import { Filter, Plus, Trash2 } from 'lucide-preact';
import { Button, EmptyState, IconButton, Issue, Segmented, Switch } from '../components/controls';
import { useStore } from '../context';
import { FILTER_KIND_LABELS, METHOD_LABELS, RESOURCE_TYPE_LABELS } from '../format';
import type { IssueMap, RowIssue } from './issues';
import { Cell, RuleRow, RuleTable, onEnter, memoRow, shown, useFocusRow, useStable } from './table';
import { useRegexCheck } from './useRegexCheck';

const TEMPLATE = '44px 112px 132px minmax(240px, 1fr) 36px';

const KIND_HELP: Record<FilterKind, string> = {
  domain: 'Domain: api.example.com matches that host and its subdomains.',
  urlFilter:
    "URL pattern: Chrome's urlFilter syntax. || anchors a domain, ^ ends one, * matches anything. Example: ||example.com/api/*",
  regex:
    'Regex: RE2 syntax, matched against the full URL. Lookarounds and backreferences are not supported.',
};

interface Props {
  profile: Profile;
  issues: IssueMap;
  onChange: (patch: Partial<Profile>) => void;
}

function FilterValue({
  filter,
  onInput,
  onKeyDown,
}: {
  filter: UrlFilter;
  onInput: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const { platform } = useStore();
  const chromeProblem = useRegexCheck(platform, filter.value, filter.kind === 'regex');
  return (
    <div class="stack stack--tight">
      <input
        class="input input--dense mono"
        aria-label="Filter value"
        spellcheck={false}
        autocomplete="off"
        value={filter.value}
        onInput={(e) => onInput(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      {chromeProblem && <Issue tone="error">{chromeProblem}</Issue>}
    </div>
  );
}

interface FilterRowProps {
  filter: UrlFilter;
  index: number;
  issues: readonly RowIssue[] | undefined;
  setRow: (id: string, patch: Partial<UrlFilter>) => void;
  addAfter: (index: number, exclude?: boolean) => void;
  remove: (id: string) => void;
}

const FilterRow = memoRow(function FilterRow({
  filter: f,
  index: i,
  issues,
  setRow,
  addAfter,
  remove,
}: FilterRowProps) {
  return (
    <RuleRow id={f.id} enabled={f.enabled} issues={shown(issues, f.value === '')}>
      <Cell>
        <Switch
          small
          checked={f.enabled}
          label={f.value.trim() || 'Unnamed filter'}
          onChange={(enabled) => setRow(f.id, { enabled })}
        />
      </Cell>
      <Cell>
        <select
          class="select select--dense"
          aria-label="Mode"
          value={f.exclude ? 'exclude' : 'include'}
          onChange={(e) => setRow(f.id, { exclude: e.currentTarget.value === 'exclude' })}
        >
          <option value="include">Include</option>
          <option value="exclude">Exclude</option>
        </select>
      </Cell>
      <Cell>
        <select
          class="select select--dense"
          aria-label="Filter type"
          value={f.kind}
          onChange={(e) => setRow(f.id, { kind: e.currentTarget.value as FilterKind })}
        >
          {(Object.keys(FILTER_KIND_LABELS) as FilterKind[]).map((k) => (
            <option key={k} value={k}>
              {FILTER_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Cell>
      <Cell>
        <FilterValue
          filter={f}
          onInput={(value) => setRow(f.id, { value })}
          onKeyDown={onEnter(() => addAfter(i, f.exclude))}
        />
      </Cell>
      <Cell>
        <IconButton
          icon={Trash2}
          small
          label={`Delete filter ${f.value}`}
          onClick={() => remove(f.id)}
        />
      </Cell>
    </RuleRow>
  );
});

export function FiltersTab({ profile, issues, onChange }: Props) {
  const focusRow = useFocusRow();
  const filters = profile.filters;
  const setFilters = (next: UrlFilter[]): void => onChange({ filters: next });
  const setRow = useStable((id: string, patch: Partial<UrlFilter>): void =>
    setFilters(filters.map((f) => (f.id === id ? { ...f, ...patch } : f))),
  );
  const addAfter = useStable((index: number, exclude?: boolean): void => {
    const row: UrlFilter = {
      id: newId(),
      enabled: true,
      kind: 'domain',
      value: '',
      exclude: exclude ?? false,
    };
    const next = [...filters];
    next.splice(index + 1, 0, row);
    setFilters(next);
    focusRow(row.id);
  });
  const remove = useStable((id: string): void => setFilters(filters.filter((x) => x.id !== id)));
  const includes = filters.filter((f) => f.enabled && !f.exclude);
  const kindsUsed = [...new Set(filters.map((f) => f.kind))];

  const toggleType = (type: ResourceType, on: boolean): void =>
    onChange({
      resourceTypes: on
        ? RESOURCE_TYPES.filter((t) => t === type || profile.resourceTypes.includes(t))
        : profile.resourceTypes.filter((t) => t !== type),
    });
  const toggleMethod = (method: Method, on: boolean): void =>
    onChange({
      methods: on
        ? METHODS.filter((m) => m === method || profile.methods.includes(m))
        : profile.methods.filter((m) => m !== method),
    });

  return (
    <div class="panel">
      <section class="panel__section" aria-labelledby="filters-urls">
        <div class="panel__section-head">
          <h2 id="filters-urls">Sites and URLs</h2>
          <span class="muted">
            {includes.length === 0
              ? 'No include filter: header rules apply to every site.'
              : 'Header rules apply only to URLs that match an include filter.'}
          </span>
        </div>
        {filters.length === 0 ? (
          <EmptyState
            icon={Filter}
            title="Applies to all sites"
            action={
              <Button variant="primary" icon={Plus} onClick={() => addAfter(-1)}>
                Add a filter
              </Button>
            }
          >
            Limit this profile to the domains you work on. Headerbench then asks Chrome for access
            to those sites only.
          </EmptyState>
        ) : (
          <>
            <RuleTable
              label="URL filters"
              template={TEMPLATE}
              columns={['On', 'Mode', 'Type', 'Value', '']}
            >
              {filters.map((f, i) => (
                <FilterRow
                  key={f.id}
                  filter={f}
                  index={i}
                  issues={issues.get(f.id)}
                  setRow={setRow}
                  addAfter={addAfter}
                  remove={remove}
                />
              ))}
            </RuleTable>
            <div class="panel__actions">
              <Button small icon={Plus} onClick={() => addAfter(filters.length - 1)}>
                Add include
              </Button>
              <Button small icon={Plus} onClick={() => addAfter(filters.length - 1, true)}>
                Add exclude
              </Button>
            </div>
            <ul class="panel__help-list">
              {kindsUsed.map((k) => (
                <li key={k}>{KIND_HELP[k]}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section class="panel__section" aria-labelledby="filters-types">
        <div class="panel__section-head">
          <h2 id="filters-types">Request types</h2>
          <Segmented
            label="Request types"
            value={profile.resourceTypes.length === 0 ? 'all' : 'some'}
            options={[
              { value: 'all', label: 'All types' },
              { value: 'some', label: 'Only these' },
            ]}
            onChange={(v) => onChange({ resourceTypes: v === 'all' ? [] : ['xmlhttprequest'] })}
          />
        </div>
        {profile.resourceTypes.length === 0 ? (
          <p class="muted">
            Pages, iframes, fetch and XHR calls, scripts, images and every other request type.
          </p>
        ) : (
          <div class="check-grid">
            {RESOURCE_TYPES.map((t) => {
              const checked = profile.resourceTypes.includes(t);
              const last = checked && profile.resourceTypes.length === 1;
              const hint = last ? 'Keep at least one type, or choose All types.' : undefined;
              return (
                <label key={t} class="checkbox" title={hint}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onClick={(e) => last && e.preventDefault()}
                    onChange={(e) => toggleType(t, e.currentTarget.checked)}
                  />
                  {RESOURCE_TYPE_LABELS[t]}
                </label>
              );
            })}
          </div>
        )}
      </section>

      <section class="panel__section" aria-labelledby="filters-methods">
        <div class="panel__section-head">
          <h2 id="filters-methods">Methods</h2>
          <Segmented
            label="Methods"
            value={profile.methods.length === 0 ? 'all' : 'some'}
            options={[
              { value: 'all', label: 'All methods' },
              { value: 'some', label: 'Only these' },
            ]}
            onChange={(v) => onChange({ methods: v === 'all' ? [] : ['get'] })}
          />
        </div>
        {profile.methods.length === 0 ? (
          <p class="muted">GET, POST, PUT, PATCH, DELETE and every other method.</p>
        ) : (
          <div class="check-grid check-grid--narrow">
            {METHODS.map((m) => {
              const checked = profile.methods.includes(m);
              const last = checked && profile.methods.length === 1;
              const hint = last ? 'Keep at least one method, or choose All methods.' : undefined;
              return (
                <label key={m} class="checkbox" title={hint}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onClick={(e) => last && e.preventDefault()}
                    onChange={(e) => toggleMethod(m, e.currentTarget.checked)}
                  />
                  {METHOD_LABELS[m]}
                </label>
              );
            })}
          </div>
        )}
        <p class="panel__help">
          Filters and types scope header rules. Redirects, blocks and mocks use their own patterns.
        </p>
      </section>
    </div>
  );
}
