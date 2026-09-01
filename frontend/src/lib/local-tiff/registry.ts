/**
 * Live objects for the local GeoTIFF layers, keyed by layer id.
 *
 * Deliberately outside zustand: a CogSource holds an open File and megabytes
 * of decoded raster, none of which may be persisted to localStorage. The store
 * keeps only the serialisable descriptor (file name, handle key, bounds); this
 * module keeps everything that cannot survive a reload.
 *
 * Same idea as the customTilesetsRef map in CesiumMap, but shared between the
 * map and the layer panel, so both can tell whether a layer is live yet.
 */

import { CogSource, destroyPool, type CogKind, type CrsFallback, type GeoExtent } from './cog-source';
import { CogImageryProvider } from './cog-imagery-provider';
import { CogTerrainProvider } from './cog-terrain-provider';

export type LocalLayerKind = 'IMAGERY' | 'TERRAIN';

export interface LocalLayerEntry {
  kind: LocalLayerKind;
  source: CogSource;
  imageryProvider?: CogImageryProvider;
  terrainProvider?: CogTerrainProvider;
  /** describe() output, shown in the panel status line */
  summary: string;
  extent: GeoExtent;
}

const entries = new Map<string, LocalLayerEntry>();

// Restoring a file after a reload does not change the `layers` array, so the
// map effect would never re-run. Bump a version instead and let React
// subscribe to it.
let version = 0;
const listeners = new Set<() => void>();

const emit = () => {
  version++;
  listeners.forEach((listener) => listener());
};

export const subscribeLocalRegistry = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getLocalRegistryVersion = (): number => version;

export const getLocalEntry = (layerId: string): LocalLayerEntry | undefined =>
  entries.get(layerId);

export const hasLocalEntry = (layerId: string): boolean => entries.has(layerId);

export const setLocalEntry = (layerId: string, entry: LocalLayerEntry): void => {
  entries.set(layerId, entry);
  emit();
};

export const getLocalLayerIds = (): string[] => [...entries.keys()];

/**
 * Unload a layer and hand its memory back: the decoded raster, the imagery
 * tile cache and the DSM height grid together run into hundreds of MB.
 *
 * Call this only once the layer is off the viewer — see the local-layer effect
 * in CesiumMap, which owns the ordering.
 */
export const disposeLocalLayer = (layerId: string): void => {
  const entry = entries.get(layerId);
  if (!entry) return;
  entries.delete(layerId);

  void entry.imageryProvider?.dispose();
  entry.terrainProvider?.dispose();
  entry.source.dispose();

  // Nothing local left to decode — stop paying for the worker pool.
  if (entries.size === 0) destroyPool();

  emit();
};

/**
 * CRS candidates for a file that declares none, newest first. Only sources
 * with a real projected definition can lend one.
 */
const crsFallbacks = (): CrsFallback[] =>
  [...entries.values()]
    .filter((entry) => entry.source.projDef)
    .map((entry) => entry.source.asCrsFallback())
    .reverse();

/**
 * Open a picked file and build the provider for it. The DSM's grid is decoded
 * here (terrain.load) so the provider is ready the moment Cesium gets it.
 */
export const buildLocalLayer = async (
  file: File,
  kind: LocalLayerKind,
  onProgress?: (msg: string) => void
): Promise<LocalLayerEntry> => {
  const sourceKind: CogKind = kind === 'TERRAIN' ? 'dsm' : 'rgb';
  onProgress?.(`Opening ${file.name}…`);

  // Try each already-loaded CRS in turn; CogSource only adopts one whose
  // projected bounds actually overlap this file.
  const candidates = crsFallbacks();
  let source: CogSource | null = null;
  let lastError: unknown = null;
  for (const fallback of [...candidates, null]) {
    try {
      source = await CogSource.open(file, sourceKind, fallback);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!source) throw lastError instanceof Error ? lastError : new Error(String(lastError));

  if (kind === 'TERRAIN') {
    const terrainProvider = new CogTerrainProvider(source);
    await terrainProvider.load(onProgress);
    return {
      kind,
      source,
      terrainProvider,
      summary: source.describe(),
      extent: source.geoExtent,
    };
  }

  return {
    kind,
    source,
    imageryProvider: new CogImageryProvider(source),
    summary: source.describe(),
    extent: source.geoExtent,
  };
};
