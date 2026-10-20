import type { ImportFormat } from '@headerbench/core';
import { IMPORT_MAX_BYTES } from '@headerbench/core';
import { FileUp, Info, TriangleAlert } from 'lucide-preact';
import { useRef, useState } from 'preact/hooks';
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

interface Props {
  onClose: () => void;
  onImported: (profileIds: string[]) => void;
}

export function ImportDialog({ onClose, onImported }: Props) {
  const store = useStore();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [source, setSource] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pasting, setPasting] = useState(false);

  const analyse = async (content: string, name: string): Promise<void> => {
    setText(content);
    setSource(name);
    setError(null);
    setPreview(null);
    if (content.trim() === '') return;
    setBusy(true);
    try {
      setPreview(await store.send({ type: 'importText', text: content, apply: false }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) {
      setError(`${file.name} is larger than 5 MB, which is too big for a profile export.`);
      return;
    }
    await analyse(await file.text(), file.name);
  };

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      const outcome = await store.call({ type: 'importText', text, apply: true });
      if (outcome.report.errors.length > 0 || outcome.profileIds.length === 0) {
        setPreview(outcome);
        return;
      }
      store.notify(outcome.summary);
      onImported(outcome.profileIds);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const report = preview?.report;
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
            disabled={busy || !preview || failed || count === 0}
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
          onChange={(e) => void readFile(e.currentTarget.files?.[0])}
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
            onInput={(e) => void analyse(e.currentTarget.value, 'Pasted text')}
          />
        </label>
      ) : (
        <div>
          <Button small variant="text" onClick={() => setPasting(true)}>
            Paste JSON instead
          </Button>
        </div>
      )}

      {busy && !preview && <p class="muted">Reading the file…</p>}
      {error && <Banner tone="error">{error}</Banner>}
      {report && failed && (
        <Banner tone="error" title="Nothing can be imported from this file">
          {report.errors.join(' ')}
        </Banner>
      )}
      {report && !failed && preview && (
        <div class="import-report">
          <div class="import-report__head">
            {report.format && <span class="chip">{FORMAT_LABELS[report.format]}</span>}
            <strong>{preview.summary}</strong>
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
