/**
 * Browser-side copy of every mission, in IndexedDB.
 *
 * The project folder is where missions really live. This cache is what the app
 * shows while the folder is still being opened, and where edits land while the
 * folder cannot be written (access not re-granted yet, or a browser without the
 * File System Access API). Unlike localStorage it has no 5 MB ceiling and keeps
 * Date objects as they are.
 */

import type { Mission } from '../../stores/mission-store';

const DB_NAME = '3d-planer-missions';
const DB_VERSION = 1;
const MISSIONS = 'missions';
const META = 'meta';

/**
 * order          mission ids in list order
 * dirty          ids changed since their file was last written
 * pendingDeletes ids deleted while the folder was not writable
 * legacyBackup   raw localStorage blob from before the move to IndexedDB
 */
export type CacheMetaKey = 'order' | 'dirty' | 'pendingDeletes' | 'legacyBackup';

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MISSIONS)) db.createObjectStore(MISSIONS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
};

const run = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest
): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    // Strict durability: a write only resolves once it is flushed to disk, so a
    // crash right after "saved" cannot roll it back.
    const tx = db.transaction(storeName, mode, { durability: mode === 'readwrite' ? 'strict' : 'default' });
    const request = operation(tx.objectStore(storeName));
    let result: T;
    request.onsuccess = () => {
      result = request.result as T;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
};

export const getAllMissions = () => run<Mission[]>(MISSIONS, 'readonly', (store) => store.getAll());

export const putMission = async (mission: Mission) => {
  await run(MISSIONS, 'readwrite', (store) => store.put(mission));
};

export const deleteMission = async (id: string) => {
  await run(MISSIONS, 'readwrite', (store) => store.delete(id));
};

export const getMeta = <T>(key: CacheMetaKey) =>
  run<T | undefined>(META, 'readonly', (store) => store.get(key));

export const setMeta = async (key: CacheMetaKey, value: unknown) => {
  await run(META, 'readwrite', (store) => store.put(value, key));
};
