import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { Snapshot } from '../messages';
import type { Store } from './store';

export const StoreContext = createContext<Store | null>(null);

/** The store, re-rendering the caller whenever it changes. */
export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore needs a StoreContext provider');
  const [, setVersion] = useState(store.version);
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setVersion(store.version));
    // Catch up on changes made between this render and the subscription.
    setVersion(store.version);
    return unsubscribe;
  }, [store]);
  return store;
}

/** The latest snapshot; only use below the loading gate in Root. */
export function useSnapshot(): Snapshot {
  const store = useStore();
  if (!store.snapshot) throw new Error('Snapshot not loaded');
  return store.snapshot;
}
