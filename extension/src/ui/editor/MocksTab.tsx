import type { MockRule, Profile, ProStatus } from '@headerbench/core';
import { MOCK_CSP_NOTE, MOCK_MAX_BYTES, newId, utf8Encode } from '@headerbench/core';
import { FileJson, Plus, Trash2 } from 'lucide-preact';
import { Banner, Button, EmptyState, IconButton, Issue, Switch } from '../components/controls';
import { useStore } from '../context';
import { formatBytes } from '../format';
import { proGate } from '../pro';
import type { IssueMap, RowIssue } from './issues';
import { memoRow, shown, useFocusRow, useStable } from './table';
import { useRegexCheck } from './useRegexCheck';

const CONTENT_TYPES = [
  'application/json',
  'text/plain',
  'text/html',
  'application/javascript',
  'text/css',
  'application/xml',
  'image/svg+xml',
];

interface Props {
  profile: Profile;
  issues: IssueMap;
  pro: ProStatus;
  onChange: (patch: Partial<Profile>) => void;
  onGetPro: () => void;
}

interface MockCardProps {
  mock: MockRule;
  issues: readonly RowIssue[] | undefined;
  setMock: (id: string, patch: Partial<MockRule>) => void;
  remove: (id: string) => void;
}

const MockCard = memoRow(function MockCard({ mock, issues, setMock, remove }: MockCardProps) {
  const { platform } = useStore();
  const onChange = (patch: Partial<MockRule>): void => setMock(mock.id, patch);
  const regexProblem = useRegexCheck(platform, mock.pattern, mock.kind === 'regex');
  const bytes = utf8Encode(mock.body).length;
  const id = mock.id;
  return (
    <div class={mock.enabled ? 'mock card' : 'mock card is-off'} data-row={id}>
      <div class="mock__head">
        <Switch
          small
          checked={mock.enabled}
          label={mock.pattern.trim() || 'Unnamed mock'}
          onChange={(enabled) => onChange({ enabled })}
        />
        <select
          class="select select--dense mock__kind"
          aria-label="Match type"
          value={mock.kind}
          onChange={(e) => onChange({ kind: e.currentTarget.value as MockRule['kind'] })}
        >
          <option value="urlFilter">URL pattern</option>
          <option value="regex">Regex</option>
        </select>
        <input
          class="input input--dense mono grow"
          aria-label="URLs to mock"
          spellcheck={false}
          autocomplete="off"
          value={mock.pattern}
          onInput={(e) => onChange({ pattern: e.currentTarget.value })}
        />
        <IconButton
          icon={Trash2}
          small
          label={`Delete mock ${mock.pattern}`}
          onClick={() => remove(mock.id)}
        />
      </div>
      <div class="mock__grid">
        <label class="field">
          <span class="field__label">Content type</span>
          <input
            class="input input--dense mono"
            list="mock-content-types"
            spellcheck={false}
            value={mock.contentType}
            onInput={(e) => onChange({ contentType: e.currentTarget.value })}
          />
        </label>
        <label class="field">
          <span class="field__label">Comment</span>
          <input
            class="input input--dense"
            value={mock.comment}
            onInput={(e) => onChange({ comment: e.currentTarget.value })}
          />
        </label>
      </div>
      <div class="field">
        <div class="row">
          <label class="field__label grow" for={`mock-body-${id}`}>
            Response body
          </label>
          <span class={bytes > MOCK_MAX_BYTES ? 'small issue--error' : 'small muted'}>
            {formatBytes(bytes)} of {formatBytes(MOCK_MAX_BYTES)}
          </span>
        </div>
        <textarea
          id={`mock-body-${id}`}
          class="textarea mono"
          rows={6}
          spellcheck={false}
          value={mock.body}
          onInput={(e) => onChange({ body: e.currentTarget.value })}
        />
      </div>
      {regexProblem && <Issue tone="error">{regexProblem}</Issue>}
      {shown(issues, mock.pattern === '').map((issue, i) => (
        <Issue key={i} tone={issue.tone}>
          {issue.message}
        </Issue>
      ))}
    </div>
  );
});

export function MocksTab({ profile, issues, pro, onChange, onGetPro }: Props) {
  const { platform } = useStore();
  const focusRow = useFocusRow();
  const mocks = profile.mocks;
  const gate = proGate(pro, platform.now(), 'Mocks');
  const add = (): void => {
    const row: MockRule = {
      id: newId(),
      enabled: true,
      kind: 'urlFilter',
      pattern: '',
      contentType: 'application/json',
      body: '',
      comment: '',
    };
    onChange({ mocks: [...mocks, row] });
    focusRow(row.id);
  };
  const setMock = useStable((id: string, patch: Partial<MockRule>): void =>
    onChange({ mocks: mocks.map((m) => (m.id === id ? { ...m, ...patch } : m)) }),
  );
  const remove = useStable((id: string): void =>
    onChange({ mocks: mocks.filter((x) => x.id !== id) }),
  );

  return (
    <div class="panel">
      <datalist id="mock-content-types">
        {CONTENT_TYPES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
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
      {mocks.length === 0 ? (
        <EmptyState
          icon={FileJson}
          title="No mocks yet"
          action={
            <Button variant="primary" icon={Plus} onClick={add}>
              Add a mock
            </Button>
          }
        >
          Return your own body for matching fetch and XHR calls, for example a JSON fixture for
          /api/user. The page receives it with status 200.
        </EmptyState>
      ) : (
        <>
          <div class="stack mocks">
            {mocks.map((m) => (
              <MockCard
                key={m.id}
                mock={m}
                issues={issues.get(m.id)}
                setMock={setMock}
                remove={remove}
              />
            ))}
          </div>
          <div class="panel__actions">
            <Button small icon={Plus} onClick={add}>
              Add mock
            </Button>
          </div>
        </>
      )}
      <p class="panel__help">
        Chrome serves a mock as a data: URL, so the status is always 200 and response headers cannot
        be set. Mocks apply to fetch, XHR, scripts, styles, images, fonts and media, not to whole
        pages.
      </p>
      <p class="panel__help">{MOCK_CSP_NOTE}</p>
    </div>
  );
}
