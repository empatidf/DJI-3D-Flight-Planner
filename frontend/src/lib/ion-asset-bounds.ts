/**
 * Geographic extent of a Cesium Ion asset.
 *
 * The Ion REST asset record carries no bounds, so the extent is read from the
 * data itself: an imagery provider's rectangle, a tileset's bounding sphere, or
 * the tile availability tree of a terrain asset.
 */

import {
  Cartographic,
  Cesium3DTileset,
  CesiumTerrainProvider,
  IonImageryProvider,
  IonResource,
  Math as CesiumMath,
  type Rectangle,
} from 'cesium';

/** Degrees. */
export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type IonAssetType = 'IMAGERY' | 'TERRAIN' | '3DTILES';

/** Stop descending the terrain tree once a level holds more tiles than this. */
const MAX_TERRAIN_FRONTIER = 16;
const MAX_TERRAIN_LEVEL = 22;
const METERS_PER_DEGREE = 111_320;

const boundsCache = new Map<string, Promise<GeoBounds | null>>();

const rectangleToBounds = (rectangle: Rectangle): GeoBounds => ({
  west: CesiumMath.toDegrees(rectangle.west),
  south: CesiumMath.toDegrees(rectangle.south),
  east: CesiumMath.toDegrees(rectangle.east),
  north: CesiumMath.toDegrees(rectangle.north),
});

const loadImageryBounds = async (assetId: number, accessToken: string) => {
  const provider = await IonImageryProvider.fromAssetId(assetId, { accessToken });
  return rectangleToBounds(provider.rectangle);
};

const loadTilesetBounds = async (assetId: number, accessToken: string) => {
  const tileset = await Cesium3DTileset.fromUrl(await IonResource.fromAssetId(assetId, { accessToken }));
  try {
    const { center, radius } = tileset.boundingSphere;
    const cartographic = Cartographic.fromCartesian(center);
    const lon = CesiumMath.toDegrees(cartographic.longitude);
    const lat = CesiumMath.toDegrees(cartographic.latitude);
    const dLat = radius / METERS_PER_DEGREE;
    const dLon = dLat / Math.max(Math.cos(cartographic.latitude), 0.01);
    return { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat };
  } finally {
    tileset.destroy();
  }
};

/**
 * Walk the availability quadtree down from the root. A site DSM keeps only a
 * handful of tiles per level, so the frontier narrows onto the data; once it
 * fans out past MAX_TERRAIN_FRONTIER the tile-snapped union is already close
 * to the real extent.
 */
const loadTerrainBounds = async (assetId: number, accessToken: string) => {
  const provider = await CesiumTerrainProvider.fromUrl(IonResource.fromAssetId(assetId, { accessToken }));
  const tilingScheme = provider.tilingScheme;

  // Availability below the root arrives in tile metadata, loaded on demand.
  const isAvailable = async (x: number, y: number, level: number) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const available = provider.getTileDataAvailable(x, y, level);
      if (available !== undefined) return available;
      const pending = provider.loadTileDataAvailability(x, y, level);
      if (!pending) return false;
      await pending;
    }
    return false;
  };

  type Tile = { x: number; y: number; level: number };
  const roots: Tile[] = [];
  for (let x = 0; x < tilingScheme.getNumberOfXTilesAtLevel(0); x++) {
    for (let y = 0; y < tilingScheme.getNumberOfYTilesAtLevel(0); y++) {
      roots.push({ x, y, level: 0 });
    }
  }

  const filterAvailable = async (tiles: Tile[]) => {
    const flags = await Promise.all(tiles.map((tile) => isAvailable(tile.x, tile.y, tile.level)));
    return tiles.filter((_, index) => flags[index]);
  };

  let frontier = await filterAvailable(roots);
  for (let level = 0; level < MAX_TERRAIN_LEVEL && frontier.length > 0; level++) {
    const children = await filterAvailable(
      frontier.flatMap((tile) => [
        { x: tile.x * 2, y: tile.y * 2, level: level + 1 },
        { x: tile.x * 2 + 1, y: tile.y * 2, level: level + 1 },
        { x: tile.x * 2, y: tile.y * 2 + 1, level: level + 1 },
        { x: tile.x * 2 + 1, y: tile.y * 2 + 1, level: level + 1 },
      ])
    );
    if (children.length === 0 || children.length > MAX_TERRAIN_FRONTIER) break;
    frontier = children;
  }

  if (frontier.length === 0) return null;

  return frontier
    .map((tile) => rectangleToBounds(tilingScheme.tileXYToRectangle(tile.x, tile.y, tile.level)))
    .reduce((union, bounds) => ({
      west: Math.min(union.west, bounds.west),
      south: Math.min(union.south, bounds.south),
      east: Math.max(union.east, bounds.east),
      north: Math.max(union.north, bounds.north),
    }));
};

/**
 * Resolve (and cache) an asset's extent. Returns null when it cannot be read or
 * spans half the globe or more — a world-wide asset has no useful centre.
 */
export function getIonAssetBounds(
  assetId: number,
  assetType: IonAssetType | undefined,
  accessToken: string
): Promise<GeoBounds | null> {
  const key = `${assetId}:${assetType ?? 'IMAGERY'}`;
  const cached = boundsCache.get(key);
  if (cached) return cached;

  const loader =
    assetType === 'TERRAIN' ? loadTerrainBounds : assetType === '3DTILES' ? loadTilesetBounds : loadImageryBounds;

  const pending = loader(assetId, accessToken)
    .then((bounds) => (bounds && bounds.east - bounds.west < 180 ? bounds : null))
    .catch((error) => {
      console.warn(`Failed to read bounds of Cesium Ion asset ${assetId}:`, error);
      // Do not cache failures: a network blip should not disable the button.
      boundsCache.delete(key);
      return null;
    });

  boundsCache.set(key, pending);
  return pending;
}
