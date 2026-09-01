/**
 * Persistence for locally picked GeoTIFFs.
 *
 * The raster itself must never reach the zustand store: `layers` is
 * JSON-serialised into localStorage, so a File or a decoded raster there would
 * blow the ~5 MB quota and silently break all mission persistence. Instead we
 * keep only a File System Access handle in IndexedDB and re-open the file from
 * disk on demand — no copy, no size limit.
 *
 * Browsers without the File System Access API (Firefox) simply get no handle;
 * the caller falls back to asking the user to pick the file again.
 */

const DB_NAME = '3d-planer-local-files';
const DB_VERSION = 1;
const STORE = 'handles';

export interface StoredFileHandle {
  /** FileSystemFileHandle — typed loosely, the API is not in every lib.dom */
  handle: any;
  name: string;
  savedAt: number;
}

/** File System Access API available (Chrome / Edge). */
export const isFsaSupported = (): boolean =>
  typeof window !== 'undefined' && typeof (window as any).showOpenFilePicker === 'function';

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
};

const withStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest
): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
};

export const makeHandleKey = (): string =>
  `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/**
 * Store a file handle. Returns the key to put on the layer, or null when the
 * browser cannot persist handles — the layer then still works for this
 * session, it just cannot be restored after a reload.
 */
export const putHandle = async (key: string, handle: any, name: string): Promise<boolean> => {
  if (!handle) return false;
  try {
    const record: StoredFileHandle = { handle, name, savedAt: Date.now() };
    await withStore('readwrite', (store) => store.put(record, key));
    return true;
  } catch (error) {
    console.warn('[LocalTiff] Could not persist the file handle:', error);
    return false;
  }
};

export const getHandle = async (key: string): Promise<StoredFileHandle | null> => {
  try {
    const record = await withStore<StoredFileHandle | undefined>(
      'readonly', (store) => store.get(key));
    return record ?? null;
  } catch (error) {
    console.warn('[LocalTiff] Could not read the file handle:', error);
    return null;
  }
};

export const deleteHandle = async (key: string): Promise<void> => {
  try {
    await withStore('readwrite', (store) => store.delete(key));
  } catch (error) {
    console.warn('[LocalTiff] Could not delete the file handle:', error);
  }
};

/**
 * Make sure we may read the handle. Chrome drops the grant between sessions,
 * so requestPermission() has to run inside a user gesture (a button click).
 */
export const ensurePermission = async (handle: any): Promise<boolean> => {
  if (!handle?.queryPermission) return true; // nothing to ask on this browser
  try {
    const opts = { mode: 'read' as const };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch (error) {
    console.warn('[LocalTiff] Permission request failed:', error);
    return false;
  }
};

const TIFF_PICKER_TYPES = [
  { description: 'GeoTIFF', accept: { 'image/tiff': ['.tif', '.tiff'] } },
];

/**
 * Pick one GeoTIFF. Prefers the File System Access API so the choice can be
 * remembered; falls back to a plain input, matching the pattern used by the
 * KML importers in FlightPlanner.
 */
export const pickTiffFile = async (): Promise<{ file: File; handle: any } | null> => {
  if (isFsaSupported()) {
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        types: TIFF_PICKER_TYPES,
        multiple: false,
      });
      if (!handle) return null;
      return { file: await handle.getFile(), handle };
    } catch (error) {
      // AbortError = the user closed the dialog; anything else falls through
      if ((error as DOMException)?.name === 'AbortError') return null;
      console.warn('[LocalTiff] File picker failed, falling back to <input>:', error);
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tif,.tiff';
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? { file, handle: null } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
};
