import type { ImportFormat } from '@headerbench/core';
import { IMPORT_MAX_BYTES, utf8Encode } from '@headerbench/core';
import { FileUp, Info, TriangleAlert } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ImportOutcome } from '../../messages';
import { Banner, Button } from '../components/controls';
import { Dialog } from '../components/Dialog';
import { useStore } from '../context';
import { plural } from '../format';

const FORMAT_LABELS: Record<ImportFormat, string> = {
  'modheader-a-v2': 'ModHeader export',
  'modheader-a-v1': 'ModHeader export (older format)',
  'modheader-b': 'ModHeader-compatible export',
  headerbench: 'Headerbench export',
};

/** Pasted text is analysed once typing pauses this long. */
export const PASTE_DEBOUNCE_MS = 250;

const TOO_LARGE = (what: string): string =>
  `${what} is larger than 5 MB, which is too big for a profile export.`;

interface Props {
  onClose: () => void;
  onImported: (profileIds: string[]) => void;
}

/** A preview and the exact text it was made from. */
interface Preview {
  text: string;
  outcome: ImportOutcome;
}

export function ImportDialog({ onClose, onImported }: Props) {
  const store = useStore();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [source, setSource] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pasting, setPasting] = useState(false);
  // Every analysis or import gets a number; answers to older ones are ignored.
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPending = (): number => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    return ++latest.current;
  };

  useEffect(() => () => void cancelPending(), []);

  const analyse = async (content: string): Promise<void> => {
    const id = cancelPending();
    setError(null);
    if (content.trim() === '') {
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const outcome = await store.send({ type: 'importText', text: content, apply: false });
      if (id === latest.current) setPreview({ text: content, outcome });
    } catch (e) {
      if (id === latest.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === latest.current) setBusy(false);
    }
  };

  const paste = (content: string): void => {
    setText(content);
    setSource('Pasted text');
    setPreview(null);
    cancelPending();
    // A UTF-8 character takes at most 3 bytes per UTF-16 unit, so short text skips the encoding.
    if (content.length * 3 > IMPORT_MAX_BYTES && utf8Encode(content).length > IMPORT_MAX_BYTES) {
      setBusy(false);
      setError(TOO_LARGE('The pasted text'));
      return;
    }
    setError(null);
    setBusy(content.trim() !== '');
    timer.current = setTimeout(() => {
      timer.current = null;
      void analyse(content);
    }, PASTE_DEBOUNCE_MS);
  };

  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const id = cancelPending();
    setPreview(null);
    if (file.size > IMPORT_MAX_BYTES) {
      setBusy(false);
      setError(TOO_LARGE(file.name));
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch {
      if (id === latest.current) {
        setBusy(false);
        setError(`${file.name} could not be read. Choose it again, or paste its contents instead.`);
      }
      return;
    }
    if (id !== latest.current) return;
    setText(content);
    setSource(file.name);
    await analyse(content);
  };

  const confirm = async (): Promise<void> => {
    if (!preview) return;
    const id = cancelPending();
    setBusy(true);
    try {
      const outcome = await store.call({ type: 'importText', text: preview.text, apply: true });
      if (outcome.report.errors.length > 0 || outcome.profileIds.length === 0) {
        if (id === latest.current) setPreview({ text: preview.text, outcome });
        return;
      }
      store.notify(outcome.summary);
      onImported(outcome.profileIds);
    } catch (e) {
      if (id === latest.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === latest.current) setBusy(false);
    }
  };

  // A preview of other text than what is in the box is stale until the new analysis lands.
  const current = preview !== null && preview.text === text ? preview : null;
  const report = current?.outcome.report;
  const failed = report !== undefined && report.errors.length > 0;
  const count = report?.counts.profiles ?? 0;

  return (
    <Dialog
      title="Import profiles"
      onClose={onClose}
      footer={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !current || failed || count === 0}
            onClick={() => void confirm()}
          >
            {count > 0 ? `Import ${plural(count, 'profile')}` : 'Import'}
          </Button>
        </>
      }
    >
      <p class="muted">
        Use ModHeader's Export option to save your profiles as a .json file, then drop it here.
        Headerbench exports work too. Nothing is saved until you confirm.
      </p>
      <div
        class={dragOver ? 'dropzone is-over' : 'dropzone'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void readFile(e.dataTransfer?.files[0]);
        }}
      >
        <FileUp class="icon" size={24} aria-hidden="true" />
        <div>{source && !pasting ? source : 'Drop a .json export here'}</div>
        <Button small onClick={() => fileInput.current?.click()}>
          Choose file
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          class="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            // Cleared so that choosing the same file again fires another change.
            input.value = '';
            void readFile(file);
          }}
        />
      </div>
      {pasting ? (
        <label class="field">
          <span class="field__label">Exported JSON</span>
          <textarea
            class="textarea mono"
            rows={6}
            spellcheck={false}
            value={text}
            onInput={(e) => paste(e.currentTarget.value)}
          />
        </label>
      ) : (
        <div>
          <Button small variant="text" onClick={() => setPasting(true)}>
            Paste JSON instead
          </Button>
        </div>
      )}

      {busy && !current && <p class="muted">Reading the export…</p>}
      {error && <Banner tone="error">{error}</Banner>}
      {report && failed && (
        <Banner tone="error" title="Nothing can be imported from this file">
          {report.errors.join(' ')}
        </Banner>
      )}
      {report && !failed && current && (
        <div class="import-report">
          <div class="import-report__head">
            {report.format && <span class="chip">{FORMAT_LABELS[report.format]}</span>}
            <strong>{current.outcome.summary}</strong>
          </div>
          {report.lines.length > 0 && (
            <ul class="import-report__lines">
              {report.lines.map((line, i) => (
                <li key={i} class={`issue issue--${line.level === 'warning' ? 'warning' : 'info'}`}>
                  {line.level === 'warning' ? (
                    <TriangleAlert class="icon" size={14} aria-hidden="true" />
                  ) : (
                    <Info class="icon" size={14} aria-hidden="true" />
                  )}
                  <span>
                    {line.profile && <strong>{line.profile}: </strong>}
                    {line.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
