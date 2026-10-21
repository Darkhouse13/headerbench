import type { BlockRule, Profile, ProStatus, RedirectRule } from '@headerbench/core';
import { checkRegex, checkRegexSubstitution, newId, toRegexSubstitution } from '@headerbench/core';
import { ArrowRight, Ban, Plus, Trash2, Waypoints } from 'lucide-preact';
import { Banner, Button, EmptyState, IconButton, Issue, Switch } from '../components/controls';
import { useStore } from '../context';
import { proGate } from '../pro';
import type { IssueMap, RowIssue } from './issues';
import { Cell, RuleRow, RuleTable, onEnter, memoRow, shown, useFocusRow, useStable } from './table';
import { useRegexCheck } from './useRegexCheck';

const REDIRECT_TEMPLATE =
  '44px 148px minmax(180px, 1.2fr) 20px minmax(180px, 1.2fr) minmax(110px, 0.8fr) 36px';
const BLOCK_TEMPLATE = '44px 148px minmax(240px, 1.6fr) minmax(120px, 1fr) 36px';

interface Props {
  profile: Profile;
  issues: IssueMap;
  pro: ProStatus;
  onChange: (patch: Partial<Profile>) => void;
  onGetPro: () => void;
}

function PatternInput(props: {
  value: string;
  regex: boolean;
  label: string;
  onInput: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const { platform } = useStore();
  const problem = useRegexCheck(platform, props.value, props.regex);
  return (
    <div class="stack stack--tight">
      <input
        class="input input--dense mono"
        aria-label={props.label}
        spellcheck={false}
        autocomplete="off"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={props.onKeyDown}
      />
      {problem && <Issue tone="error">{problem}</Issue>}
    </div>
  );
}

/** For a regex redirect with a valid pattern: why Chrome would refuse its `$N` target. */
function targetProblem(rule: RedirectRule): string | null {
  if (rule.kind !== 'regex' || rule.to.trim() === '' || checkRegex(rule.from) !== null) return null;
  return checkRegexSubstitution(rule.from, toRegexSubstitution(rule.to));
}

interface RedirectRowProps {
  rule: RedirectRule;
  index: number;
  issues: readonly RowIssue[] | undefined;
  setRow: (id: string, patch: Partial<RedirectRule>) => void;
  addAfter: (index: number) => void;
  remove: (id: string) => void;
}

const RedirectRow = memoRow(function RedirectRow({
  rule: r,
  index,
  issues,
  setRow,
  addAfter,
  remove,
}: RedirectRowProps) {
  const target = targetProblem(r);
  // The target's own problem is shown under the target field instead of under the row.
  const rowIssues = shown(issues, r.from === '' && r.to === '').filter((i) => i.message !== target);
  const add = onEnter(() => addAfter(index));
  return (
    <RuleRow id={r.id} enabled={r.enabled} issues={rowIssues}>
      <Cell>
        <Switch
          small
          checked={r.enabled}
          label={r.from.trim() || 'Unnamed redirect'}
          onChange={(enabled) => setRow(r.id, { enabled })}
        />
      </Cell>
      <Cell>
        <select
          class="select select--dense"
          aria-label="Match type"
          value={r.kind}
          onChange={(e) => setRow(r.id, { kind: e.currentTarget.value as RedirectRule['kind'] })}
        >
          <option value="url">Exact URL</option>
          <option value="urlFilter">URL pattern</option>
          <option value="regex">Regex (Pro)</option>
        </select>
      </Cell>
      <Cell>
        <PatternInput
          label="Redirect from"
          value={r.from}
          regex={r.kind === 'regex'}
          onInput={(from) => setRow(r.id, { from })}
          onKeyDown={add}
        />
      </Cell>
      <Cell class="rtable__cell--arrow">
        <ArrowRight class="icon" size={16} aria-hidden="true" />
      </Cell>
      <Cell>
        <div class="stack stack--tight">
          <input
            class="input input--dense mono"
            aria-label="Redirect to"
            spellcheck={false}
            autocomplete="off"
            value={r.to}
            onInput={(e) => setRow(r.id, { to: e.currentTarget.value })}
            onKeyDown={add}
          />
          {target && <Issue tone="error">{target}</Issue>}
        </div>
      </Cell>
      <Cell>
        <input
          class="input input--dense"
          aria-label="Comment"
          value={r.comment}
          onInput={(e) => setRow(r.id, { comment: e.currentTarget.value })}
        />
      </Cell>
      <Cell>
        <IconButton
          icon={Trash2}
          small
          label={`Delete redirect ${r.from}`}
          onClick={() => remove(r.id)}
        />
      </Cell>
    </RuleRow>
  );
});

interface BlockRowProps {
  rule: BlockRule;
  index: number;
  issues: readonly RowIssue[] | undefined;
  setRow: (id: string, patch: Partial<BlockRule>) => void;
  addAfter: (index: number) => void;
  remove: (id: string) => void;
}

const BlockRow = memoRow(function BlockRow({
  rule: b,
  index,
  issues,
  setRow,
  addAfter,
  remove,
}: BlockRowProps) {
  return (
    <RuleRow id={b.id} enabled={b.enabled} issues={shown(issues, b.pattern === '')}>
      <Cell>
        <Switch
          small
          checked={b.enabled}
          label={b.pattern.trim() || 'Unnamed block'}
          onChange={(enabled) => setRow(b.id, { enabled })}
        />
      </Cell>
      <Cell>
        <select
          class="select select--dense"
          aria-label="Match type"
          value={b.kind}
          onChange={(e) => setRow(b.id, { kind: e.currentTarget.value as BlockRule['kind'] })}
        >
          <option value="urlFilter">URL pattern</option>
          <option value="regex">Regex</option>
        </select>
      </Cell>
      <Cell>
        <PatternInput
          label="Block pattern"
          value={b.pattern}
          regex={b.kind === 'regex'}
          onInput={(pattern) => setRow(b.id, { pattern })}
          onKeyDown={onEnter(() => addAfter(index))}
        />
      </Cell>
      <Cell>
        <input
          class="input input--dense"
          aria-label="Comment"
          value={b.comment}
          onInput={(e) => setRow(b.id, { comment: e.currentTarget.value })}
        />
      </Cell>
      <Cell>
        <IconButton
          icon={Trash2}
          small
          label={`Delete block ${b.pattern}`}
          onClick={() => remove(b.id)}
        />
      </Cell>
    </RuleRow>
  );
});

export function RedirectsTab({ profile, issues, pro, onChange, onGetPro }: Props) {
  const { platform } = useStore();
  const focusRow = useFocusRow();
  const { redirects, blocks } = profile;
  const setRedirect = useStable((id: string, patch: Partial<RedirectRule>): void =>
    onChange({ redirects: redirects.map((r) => (r.id === id ? { ...r, ...patch } : r)) }),
  );
  const setBlock = useStable((id: string, patch: Partial<BlockRule>): void =>
    onChange({ blocks: blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }),
  );
  const addRedirect = useStable((index: number): void => {
    const row: RedirectRule = {
      id: newId(),
      enabled: true,
      kind: 'url',
      from: '',
      to: '',
      comment: '',
    };
    const next = [...redirects];
    next.splice(index + 1, 0, row);
    onChange({ redirects: next });
    focusRow(row.id);
  });
  const addBlock = useStable((index: number): void => {
    const row: BlockRule = {
      id: newId(),
      enabled: true,
      kind: 'urlFilter',
      pattern: '',
      comment: '',
    };
    const next = [...blocks];
    next.splice(index + 1, 0, row);
    onChange({ blocks: next });
    focusRow(row.id);
  });
  const removeRedirect = useStable((id: string): void =>
    onChange({ redirects: redirects.filter((x) => x.id !== id) }),
  );
  const removeBlock = useStable((id: string): void =>
    onChange({ blocks: blocks.filter((x) => x.id !== id) }),
  );
  const usesRegex = redirects.some((r) => r.kind === 'regex');
  const gate = usesRegex ? proGate(pro, platform.now(), 'Regex redirects') : null;

  return (
    <div class="panel">
      <section class="panel__section" aria-labelledby="redirects-h">
        <div class="panel__section-head">
          <h2 id="redirects-h">Redirects</h2>
          <span class="muted">Send matching requests to another URL, such as a local build.</span>
        </div>
        {gate && (
          <Banner
            tone={gate.tone}
            actions={
              gate.offerPro && (
                <Button small onClick={onGetPro}>
                  Get Pro
                </Button>
              )
            }
          >
            {gate.text}
          </Banner>
        )}
        {redirects.length === 0 ? (
          <EmptyState
            icon={Waypoints}
            title="No redirects yet"
            action={
              <Button variant="primary" icon={Plus} onClick={() => addRedirect(-1)}>
                Add a redirect
              </Button>
            }
          >
            Point a production script or API at localhost, or swap one URL for another.
          </EmptyState>
        ) : (
          <>
            <RuleTable
              label="Redirects"
              template={REDIRECT_TEMPLATE}
              columns={['On', 'Match', 'From', '', 'To', 'Comment', '']}
            >
              {redirects.map((r, i) => (
                <RedirectRow
                  key={r.id}
                  rule={r}
                  index={i}
                  issues={issues.get(r.id)}
                  setRow={setRedirect}
                  addAfter={addRedirect}
                  remove={removeRedirect}
                />
              ))}
            </RuleTable>
            <div class="panel__actions">
              <Button small icon={Plus} onClick={() => addRedirect(redirects.length - 1)}>
                Add redirect
              </Button>
            </div>
            <p class="panel__help">
              Exact URL matches one address. A regex can capture parts of the URL and reuse them in
              the target as $1, $2, for example <code>^https://cdn\.example\.com/(.*)$</code> to{' '}
              <code>http://localhost:3000/$1</code>.
            </p>
          </>
        )}
      </section>

      <section class="panel__section" aria-labelledby="blocks-h">
        <div class="panel__section-head">
          <h2 id="blocks-h">Blocks</h2>
          <span class="muted">Matching requests fail as if the network were down.</span>
        </div>
        {blocks.length === 0 ? (
          <EmptyState
            icon={Ban}
            title="No blocks yet"
            action={
              <Button icon={Plus} onClick={() => addBlock(-1)}>
                Add a block
              </Button>
            }
          >
            Block a tracker, a slow third-party script or an endpoint to test how your app handles
            failure.
          </EmptyState>
        ) : (
          <>
            <RuleTable
              label="Blocks"
              template={BLOCK_TEMPLATE}
              columns={['On', 'Match', 'Pattern', 'Comment', '']}
            >
              {blocks.map((b, i) => (
                <BlockRow
                  key={b.id}
                  rule={b}
                  index={i}
                  issues={issues.get(b.id)}
                  setRow={setBlock}
                  addAfter={addBlock}
                  remove={removeBlock}
                />
              ))}
            </RuleTable>
            <div class="panel__actions">
              <Button small icon={Plus} onClick={() => addBlock(blocks.length - 1)}>
                Add block
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
