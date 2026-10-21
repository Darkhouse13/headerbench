import { useStore } from '../context';

export function Toasts() {
  const store = useStore();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {store.toasts.map((t) => (
        <div key={t.id} class={t.tone === 'error' ? 'toast toast--error' : 'toast'}>
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              class="toast__action"
              onClick={() => {
                store.dismiss(t.id);
                t.action?.run();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
