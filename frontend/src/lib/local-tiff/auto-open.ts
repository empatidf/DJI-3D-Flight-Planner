/**
 * Re-open the local GeoTIFF layers after a page load.
 *
 * The app stores only a handle to the file on disk, so a reload starts with
 * the layer rows but no raster. Chrome keeps the read permission for a handle
 * it granted before, and a permission that is still granted may be used
 * without a click — so the files can simply be opened again.
 *
 * Deliberately outside the layer panel: that panel only exists while the Map
 * section is open, and the files must come back whether the user opens it or
 * not. Anything that needs a click (permission withdrawn, file moved) is left
 * to the Restore button, and the state per layer tells the panel which it is.
 */

import { useMissionStore, type Layer } from '../../stores/mission-store';
import { buildLocalLayer, hasLocalEntry, setLocalEntry, setLocalOpenState } from './registry';
import { getHandle } from './local-file-store';

let started = false;
const tried = new Set<string>();
/** One file at a time: decoding a GeoTIFF's overviews is heavy. */
let queue: Promise<void> = Promise.resolve();

const openLayer = async (layer: Layer): Promise<'opened' | 'needs-click' | 'missing'> => {
  const stored = layer.localHandleKey ? await getHandle(layer.localHandleKey) : null;
  if (!stored?.handle) return 'missing';

  if (stored.handle.queryPermission && (await stored.handle.queryPermission({ mode: 'read' })) !== 'granted') {
    return 'needs-click';
  }

  let file: File;
  try {
    file = await stored.handle.getFile();
  } catch (error) {
    // Moved, renamed or deleted since it was picked.
    console.warn('[LocalTiff] Stored file could not be opened:', error);
    return 'missing';
  }

  setLocalEntry(layer.id, await buildLocalLayer(file, layer.localKind ?? 'IMAGERY'));
  return 'opened';
};

const openPending = (layers: Layer[]) => {
  const pending = layers.filter(
    (layer) => layer.type === 'local-tiff' && layer.visible && !hasLocalEntry(layer.id) && !tried.has(layer.id)
  );

  for (const layer of pending) {
    tried.add(layer.id);
    setLocalOpenState(layer.id, 'opening');
    queue = queue.then(async () => {
      try {
        const result = await openLayer(layer);
        setLocalOpenState(layer.id, result === 'opened' ? null : result);
      } catch (error) {
        console.error('[LocalTiff] Could not re-open the file automatically:', error);
        setLocalOpenState(layer.id, 'needs-click');
      }
    });
  }
};

/** Start once, from the app shell, like the mission persistence. */
export const startLocalFileAutoOpen = () => {
  if (started) return;
  started = true;

  openPending(useMissionStore.getState().layers);
  // Layers also arrive later: a mission carrying its own layer snapshot, or a
  // hidden layer switched on while the Map section is closed.
  useMissionStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) openPending(state.layers);
  });
};

/** After the user restored a file by hand, that layer may be opened again later. */
export const forgetAutoOpenAttempt = (layerId: string) => {
  tried.delete(layerId);
  setLocalOpenState(layerId, null);
};
