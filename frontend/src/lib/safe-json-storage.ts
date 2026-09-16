/**
 * localStorage for a persisted zustand store that never throws on a write.
 *
 * zustand saves inside `set()`, so a full storage throws into whoever changed
 * the state — the map's camera listener, where the error stops Cesium from
 * rendering. A failed write keeps the value stored before and is reported
 * once per page load instead.
 */

import type { PersistStorage, StorageValue } from 'zustand/middleware';

export const createSafeJSONStorage = <S>(storeName: string): PersistStorage<S> => {
  let warned = false;

  return {
    getItem: (name) => {
      let raw: string | null;
      try {
        raw = localStorage.getItem(name);
      } catch {
        // Storage blocked (e.g. site data disabled): start from the defaults.
        return null;
      }
      return raw === null ? null : (JSON.parse(raw) as StorageValue<S>);
    },

    setItem: (name, value) => {
      try {
        localStorage.setItem(name, JSON.stringify(value));
      } catch (error) {
        if (warned) return;
        warned = true;
        console.error(
          `[${storeName}] Settings could not be saved in browser storage; the last saved copy is kept.`,
          error
        );
      }
    },

    removeItem: (name) => {
      try {
        localStorage.removeItem(name);
      } catch {
        // Nothing to remove when storage is blocked.
      }
    },
  };
};
