/** One UI app for three pages: html[data-route] picks popup, app (editor) or welcome. */
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { AppShell } from './editor/AppShell';
import { StoreContext, useStore } from './context';
import { Banner } from './components/controls';
import { chromePlatform } from './platform';
import { Popup } from './popup/Popup';
import { Store } from './store';
import { Welcome } from './welcome/Welcome';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/popup.css';
import './styles/app.css';
import './styles/welcome.css';

type PageRoute = 'popup' | 'app' | 'welcome';

function Page({ route }: { route: PageRoute }) {
  const store = useStore();
  const theme = store.snapshot?.state.settings.theme ?? 'system';

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  if (store.loadError) {
    return (
      <div class="load-error">
        <Banner tone="error" title="Headerbench could not load your profiles">
          {store.loadError} Reload this page. If it keeps happening, reload the extension from
          chrome://extensions.
        </Banner>
      </div>
    );
  }
  if (!store.snapshot) return <div class="loading" aria-busy="true" />;
  if (route === 'popup') return <Popup />;
  if (route === 'welcome') return <Welcome />;
  return <AppShell />;
}

function mount(root: HTMLElement, route: PageRoute, store: Store): void {
  render(
    <StoreContext.Provider value={store}>
      <Page route={route} />
    </StoreContext.Provider>,
    root,
  );
}

const root = document.getElementById('root');
const route = document.documentElement.dataset.route as PageRoute | undefined;
if (root && route) {
  document.body.classList.add(`page-${route}`);
  const store = new Store(chromePlatform(route === 'popup'));
  mount(root, route, store);
  void store.init();
  window.addEventListener('pagehide', () => void store.flush());
}
