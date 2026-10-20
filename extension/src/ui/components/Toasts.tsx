import { useStore } from '../context';

export function Toasts() {
  const store = useStore();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {store.toasts.map((t) => (
        <div key={t.id} class={t.tone === 'error' ? 'toast toast--error' : 'toast'}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
