/**
 * Cesium TerrainProvider producing HeightmapTerrainData from a local DSM
 * GeoTIFF, at two levels of service:
 *
 *  - up to _gridLevel: sampled from one in-memory grid built by load(), so
 *    tiles are pure RAM resamples with no I/O and no latency.
 *  - beyond it: windowed reads straight from the COG pyramid, so detail is
 *    bounded by the source pixel size rather than by the grid. Decoded blocks
 *    are cached, and neighbouring tiles share them.
 *
 * Tiles outside the DSM extent are flat at the dataset's base height.
 *
 * Note: the DSM's Z values are handed to Cesium as WGS84 ellipsoidal heights
 * with no geoid correction, so a DSM stored in orthometric heights sits off
 * by the local geoid separation.
 */

import {
  Credit,
  Ellipsoid,
  Event as CesiumEvent,
  GeographicTilingScheme,
  HeightmapTerrainData,
  Rectangle,
  TerrainProvider,
  TileAvailability,
  Math as CesiumMath,
} from 'cesium';

import { createLimiter } from './limiter';
import type { CogSource, RasterWindow } from './cog-source';

const GRID = 65;              // heightmap posts per tile side
const OUTSIDE_MAX_LEVEL = 6;  // stop refining flat tiles far from the DSM

// Coarse whole-extent grid, decoded once at load. It answers every tile up to
// the level its post spacing supports (~0.3 m on a 1.3 km site) with no file
// I/O at all, which keeps low and mid zoom instant. Closer than that it is the
// limiting factor, so those tiles read the DSM directly instead.
const HEIGHT_GRID_MAX = 4096;

// Deepest terrain level. A 65-post tile at level 22 has ~7 cm posts, finer
// than the imagery pixel, and Cesium's screen-space error only asks for it
// within ~40 m of the camera — so this is a floor on detail, not a tile-count
// problem. Without a cap the loop below would refine indefinitely.
const MAX_TERRAIN_LEVEL = 22;

const BLOCK_LRU = 48;         // decoded DSM blocks kept in RAM
const MAX_CONCURRENT = 8;     // simultaneous DSM block reads
const BLOCK_FALLBACK = 512;   // block size for stripped (non-tiled) sources

interface HeightGrid {
  data: Float32Array;
  w: number;
  h: number;
}

interface HeightWindow {
  data: Float32Array;
  w: number;
  h: number;
  x0: number;
  y0: number;
}

interface TileDegrees {
  north: number;
  south: number;
  west: number;
  east: number;
}

function valid(v: number, noData: number | null | undefined): boolean {
  if (Number.isNaN(v)) return false;
  if (noData !== null && noData !== undefined && v === noData) return false;
  if (v < -10000 || v > 100000) return false; // stray sentinels
  return true;
}

export class CogTerrainProvider {
  private _source: CogSource;
  private _baseHeight = 0;
  private _grid: HeightGrid | null = null;
  private _blocks: Map<string, Promise<RasterWindow | null>>;
  private _limit: <T>(fn: () => T | Promise<T>) => Promise<T>;
  private _tilingScheme: GeographicTilingScheme;
  private _rectangle: Rectangle;
  private _errorEvent: CesiumEvent;
  private _credit: Credit;
  private _levelZeroError: number;
  private _unitsPerDeg: number;
  private _maximumLevel: number;
  private _gridLevel: number;
  private _availability: TileAvailability;

  constructor(source: CogSource) {
    this._source = source;
    this._blocks = new Map(); // "lvl:bx:by" -> Promise<window>
    this._limit = createLimiter(MAX_CONCURRENT);
    this._tilingScheme = new GeographicTilingScheme();
    const { west, south, east, north } = source.geoExtent;
    this._rectangle = Rectangle.fromDegrees(west, south, east, north);
    this._errorEvent = new CesiumEvent();
    this._credit = new Credit('Local DSM GeoTIFF');
    this._levelZeroError =
      TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
        Ellipsoid.WGS84, GRID, this._tilingScheme.getNumberOfXTilesAtLevel(0));

    this._unitsPerDeg = source.converter
      ? 111320 * Math.cos(CesiumMath.toRadians((south + north) / 2))
      : 1;
    // Refine until a tile's posts are at least as fine as the source pixel.
    this._maximumLevel = this._levelForResolution(source.levelResolution(0));
    this._gridLevel = this._maximumLevel; // provisional until load()
    this._availability = this._buildAvailability(this._maximumLevel);
  }

  /**
   * Tile availability over the DSM footprint.
   *
   * sampleTerrainMostDetailed refuses to run without this, so leaving it
   * undefined made every height query throw: waypoints silently fell back to a
   * constant altitude and ended up sitting on the base map instead of the DSM.
   *
   * The level it reports is capped at _gridLevel, where tiles are answered from
   * the in-memory height grid. Queries then cost no file I/O at all, which
   * matters because terrain-follow and collision analysis probe thousands of
   * points. Rendering is unaffected — getTileDataAvailable still refines to the
   * source resolution, so the visible surface keeps its full detail.
   */
  private _buildAvailability(maxLevel: number): TileAvailability {
    const availability = new TileAvailability(this._tilingScheme, maxLevel);
    const sw = Rectangle.southwest(this._rectangle);
    const ne = Rectangle.northeast(this._rectangle);
    for (let level = 0; level <= maxLevel; level++) {
      const swTile = this._tilingScheme.positionToTileXY(sw, level);
      const neTile = this._tilingScheme.positionToTileXY(ne, level);
      if (!swTile || !neTile) continue;
      // Tile Y grows southwards, so the north-east tile supplies the start row.
      availability.addAvailableTileRange(level, swTile.x, neTile.y, neTile.x, swTile.y);
    }
    return availability;
  }

  /** Height used for no-data and for tiles outside the DSM extent. */
  get baseHeight(): number { return this._baseHeight; }
  get gridSize(): { w: number; h: number } | null {
    return this._grid ? { w: this._grid.w, h: this._grid.h } : null;
  }

  /**
   * Coarsest tile level whose GRID posts are at least as fine as targetRes
   * (source CRS units per post), bounded by MAX_TERRAIN_LEVEL.
   */
  private _levelForResolution(targetRes: number): number {
    let level = 0;
    while (this._sampleResUnits(level, this._unitsPerDeg) > targetRes &&
           level < MAX_TERRAIN_LEVEL) level++;
    return level;
  }

  private _sampleResUnits(level: number, unitsPerDeg: number): number {
    const degPerTile = 180 / this._tilingScheme.getNumberOfYTilesAtLevel(level);
    return (degPerTile / (GRID - 1)) * unitsPerDeg;
  }

  /**
   * Decode the DSM once into a single grid covering the whole extent.
   * Must be awaited before the provider is handed to Cesium.
   */
  async load(onProgress?: (msg: string) => void): Promise<CogTerrainProvider> {
    const src = this._source;
    const aspect = src.fullWidth / src.fullHeight;
    let gw = HEIGHT_GRID_MAX;
    let gh = Math.round(HEIGHT_GRID_MAX / aspect);
    if (gh > HEIGHT_GRID_MAX) {
      gh = HEIGHT_GRID_MAX;
      gw = Math.round(HEIGHT_GRID_MAX * aspect);
    }
    // read from the overview closest to (but not coarser than) the target grid
    const lvl = src.levels.reduce((best, l, i) => (l.width >= gw ? i : best), 0);
    onProgress?.(`Decoding DSM into a ${gw}x${gh} height grid…`);
    const win = await src.readWindow(
      lvl, 0, 0, src.levels[lvl].width, src.levels[lvl].height, Math.max(gw, gh));
    if (!win) throw new Error('DSM could not be read');

    const { data, w, h, bands } = win;
    const heights = new Float32Array(w * h);
    const vals: number[] = [];
    for (let i = 0; i < w * h; i++) {
      const v = data[i * bands];
      const ok = valid(v, src.noData);
      heights[i] = ok ? v : NaN;
      if (ok && (i & 63) === 0) vals.push(v); // 1-in-64 sample for the percentile
    }
    if (vals.length) {
      vals.sort((a, b) => a - b);
      this._baseHeight = vals[Math.floor(vals.length * 0.02)]; // 2nd percentile
    }
    // no-data -> base height, so the data sits on the ground, no cliffs
    for (let i = 0; i < heights.length; i++) {
      if (Number.isNaN(heights[i])) heights[i] = this._baseHeight;
    }
    this._grid = { data: heights, w, h };

    // Past this level the grid is coarser than the tile asks for and would
    // smooth away detail the file still holds (panel rows turn into a lumpy
    // ridge that no longer matches the orthophoto) — those tiles read the COG.
    // Use the finer axis: Cesium tiles are square in degrees.
    const [gMinX, gMinY, gMaxX, gMaxY] = src.bboxProj;
    this._gridLevel = this._levelForResolution(
      Math.min((gMaxX - gMinX) / w, (gMaxY - gMinY) / h));

    // Now that the grid exists, point height queries at it.
    this._availability = this._buildAvailability(this._gridLevel);
    return this;
  }

  /**
   * Release the height grid and block cache. Cesium may still hold this
   * provider for a frame or two while it swaps to another one, so the tile
   * methods stay callable: with no grid every tile answers flat base height.
   */
  dispose(): void {
    this._grid = null;
    this._blocks.clear();
  }

  get tilingScheme() { return this._tilingScheme; }
  get errorEvent() { return this._errorEvent; }
  get credit() { return this._credit; }
  get hasWaterMask() { return false; }
  get hasVertexNormals() { return false; }
  get availability() { return this._availability; }
  get ready() { return true; }
  get rectangle() { return this._rectangle; }

  getLevelMaximumGeometricError(level: number): number {
    return this._levelZeroError / (1 << level);
  }

  getTileDataAvailable(x: number, y: number, level: number): boolean {
    const tileRect = this._tilingScheme.tileXYToRectangle(x, y, level);
    if (Rectangle.intersection(tileRect, this._rectangle)) {
      return level <= this._maximumLevel;
    }
    return level <= OUTSIDE_MAX_LEVEL;
  }

  loadTileDataAvailability() { return undefined; }

  private _childTileMask(x: number, y: number, level: number): number {
    let mask = 0;
    for (const [cx, cy, bit] of [
      [2 * x, 2 * y + 1, 1],     // SW
      [2 * x + 1, 2 * y + 1, 2], // SE
      [2 * x, 2 * y, 4],         // NW
      [2 * x + 1, 2 * y, 8],     // NE
    ]) {
      if (this.getTileDataAvailable(cx, cy, level + 1)) mask |= bit;
    }
    return mask;
  }

  /**
   * Cesium's heightmap buffer is row-major from NORTH to SOUTH, west to east
   * (see HeightmapTerrainData docs), which is the order written here.
   */
  requestTileGeometry(x: number, y: number, level: number): Promise<HeightmapTerrainData> {
    const childTileMask = this._childTileMask(x, y, level);
    const tileRect = this._tilingScheme.tileXYToRectangle(x, y, level);
    const inData = this._grid && Rectangle.intersection(tileRect, this._rectangle);

    if (!inData) return Promise.resolve(this._flatTile(childTileMask));

    const deg: TileDegrees = {
      north: CesiumMath.toDegrees(tileRect.north),
      south: CesiumMath.toDegrees(tileRect.south),
      west: CesiumMath.toDegrees(tileRect.west),
      east: CesiumMath.toDegrees(tileRect.east),
    };
    if (level <= this._gridLevel) {
      return Promise.resolve(new HeightmapTerrainData({
        buffer: this._fromGrid(deg), width: GRID, height: GRID, childTileMask,
      }));
    }
    return this._fromCog(deg).then((buffer) => new HeightmapTerrainData({
      buffer: buffer || new Float32Array(GRID * GRID).fill(this._baseHeight),
      width: GRID, height: GRID, childTileMask,
    }));
  }

  private _flatTile(childTileMask: number): HeightmapTerrainData {
    return new HeightmapTerrainData({
      buffer: new Float32Array(GRID * GRID).fill(this._baseHeight),
      width: GRID, height: GRID, childTileMask,
    });
  }

  /** Post positions of a tile, as source-CRS coordinates (row 0 = north). */
  private _posts(deg: TileDegrees): Float64Array {
    const src = this._source;
    const pts = new Float64Array(GRID * GRID * 2);
    for (let j = 0; j < GRID; j++) {
      const lat = deg.north + (j / (GRID - 1)) * (deg.south - deg.north);
      for (let i = 0; i < GRID; i++) {
        const lon = deg.west + (i / (GRID - 1)) * (deg.east - deg.west);
        const [px, py] = src.forward(lon, lat);
        const k = (j * GRID + i) * 2;
        pts[k] = px;
        pts[k + 1] = py;
      }
    }
    return pts;
  }

  private _fromGrid(deg: TileDegrees): Float32Array {
    const pts = this._posts(deg);
    const heights = new Float32Array(GRID * GRID).fill(this._baseHeight);
    for (let n = 0; n < GRID * GRID; n++) {
      const px = pts[n * 2];
      const py = pts[n * 2 + 1];
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      heights[n] = this._sampleAt(px, py);
    }
    return heights;
  }

  /** Bilinear sample of the in-memory grid at source-CRS coordinates. */
  private _sampleAt(x: number, y: number): number {
    const g = this._grid;
    if (!g) return this._baseHeight;
    const [minX, minY, maxX, maxY] = this._source.bboxProj;
    const fx = ((x - minX) / (maxX - minX)) * (g.w - 1);
    const fy = ((maxY - y) / (maxY - minY)) * (g.h - 1);
    if (!(fx >= 0 && fy >= 0 && fx <= g.w - 1 && fy <= g.h - 1)) return this._baseHeight;
    const ix = Math.min(Math.floor(fx), g.w - 2);
    const iy = Math.min(Math.floor(fy), g.h - 2);
    const tx = fx - ix;
    const ty = fy - iy;
    const d = g.data;
    const h00 = d[iy * g.w + ix];
    const h10 = d[iy * g.w + ix + 1];
    const h01 = d[(iy + 1) * g.w + ix];
    const h11 = d[(iy + 1) * g.w + ix + 1];
    return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) +
           h01 * (1 - tx) * ty + h11 * tx * ty;
  }

  /** Internal block size of a pyramid level, in that level's pixels. */
  private _blockGeom(lvl: number): { bw: number; bh: number } {
    const fd = this._source.levels[lvl].image.fileDirectory;
    return {
      bw: fd.TileWidth || BLOCK_FALLBACK,
      bh: fd.TileLength || BLOCK_FALLBACK,
    };
  }

  /**
   * One decoded DSM block, LRU-cached. Terrain tiles are much smaller than a
   * block at high zoom, so neighbours reuse the same decode instead of paying
   * for it each time.
   */
  private _block(lvl: number, bx: number, by: number): Promise<RasterWindow | null> {
    const key = `${lvl}:${bx}:${by}`;
    const hit = this._blocks.get(key);
    if (hit) {
      this._blocks.delete(key);
      this._blocks.set(key, hit); // refresh recency
      return hit;
    }
    const { bw, bh } = this._blockGeom(lvl);
    const lvlObj = this._source.levels[lvl];
    const p = this._limit(() => this._source.readWindow(
      lvl, bx * bw, by * bh,
      Math.min(lvlObj.width, (bx + 1) * bw),
      Math.min(lvlObj.height, (by + 1) * bh),
      Math.max(bw, bh) // no downsampling: this is the finest data we have
    )).catch(() => null);
    this._blocks.set(key, p);
    if (this._blocks.size > BLOCK_LRU) {
      const oldest = this._blocks.keys().next().value;
      if (oldest !== undefined) this._blocks.delete(oldest);
    }
    return p;
  }

  /**
   * Gather the level-pixel rect [x0,x1) x [y0,y1) into one contiguous height
   * buffer, pulling from the block cache. No-data becomes the base height.
   */
  private async _readHeights(
    lvl: number, x0: number, y0: number, x1: number, y1: number
  ): Promise<HeightWindow> {
    const src = this._source;
    const { bw, bh } = this._blockGeom(lvl);
    const w = x1 - x0;
    const h = y1 - y0;
    const out = new Float32Array(w * h).fill(this._baseHeight);
    const jobs: Promise<void>[] = [];
    for (let by = Math.floor(y0 / bh); by <= Math.floor((y1 - 1) / bh); by++) {
      for (let bx = Math.floor(x0 / bw); bx <= Math.floor((x1 - 1) / bw); bx++) {
        jobs.push(this._block(lvl, bx, by).then((blk) => {
          if (!blk) return;
          const bands = blk.bands;
          const cx0 = Math.max(x0, blk.x0);
          const cy0 = Math.max(y0, blk.y0);
          const cx1 = Math.min(x1, blk.x0 + blk.w);
          const cy1 = Math.min(y1, blk.y0 + blk.h);
          for (let yy = cy0; yy < cy1; yy++) {
            let s = ((yy - blk.y0) * blk.w + (cx0 - blk.x0)) * bands;
            let d = (yy - y0) * w + (cx0 - x0);
            for (let xx = cx0; xx < cx1; xx++, s += bands, d++) {
              const v = blk.data[s];
              out[d] = valid(v, src.noData) ? v : this._baseHeight;
            }
          }
        }));
      }
    }
    await Promise.all(jobs);
    return { data: out, w, h, x0, y0 };
  }

  /** Bilinear sample of a gathered window, in that level's pixel coords. */
  private static _sampleWindow(win: HeightWindow, px: number, py: number): number {
    const fx = px - win.x0;
    const fy = py - win.y0;
    const ix = Math.max(0, Math.min(Math.floor(fx), win.w - 2));
    const iy = Math.max(0, Math.min(Math.floor(fy), win.h - 2));
    const tx = Math.max(0, Math.min(1, fx - ix));
    const ty = Math.max(0, Math.min(1, fy - iy));
    const d = win.data;
    const h00 = d[iy * win.w + ix];
    const h10 = d[iy * win.w + ix + 1];
    const h01 = d[(iy + 1) * win.w + ix];
    const h11 = d[(iy + 1) * win.w + ix + 1];
    return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) +
           h01 * (1 - tx) * ty + h11 * tx * ty;
  }

  /** Full-resolution tile: read the covering DSM window and sample it. */
  private async _fromCog(deg: TileDegrees): Promise<Float32Array | null> {
    const src = this._source;
    const pts = this._posts(deg);
    // pyramid level whose pixels are at least as fine as the post spacing
    const [cx0] = src.forward(deg.west, (deg.south + deg.north) / 2);
    const [cx1] = src.forward(deg.east, (deg.south + deg.north) / 2);
    const lvl = src.selectLevel(
      Math.abs(cx1 - cx0) / (GRID - 1) || src.levelResolution(0));
    const lw = src.levels[lvl].width;
    const lh = src.levels[lvl].height;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const px = new Float64Array(GRID * GRID * 2);
    for (let n = 0; n < GRID * GRID; n++) {
      const [ex, ey] = src.projToPixel(lvl, pts[n * 2], pts[n * 2 + 1]);
      px[n * 2] = ex;
      px[n * 2 + 1] = ey;
      if (!Number.isFinite(ex) || !Number.isFinite(ey)) continue;
      if (ex < minX) minX = ex;
      if (ex > maxX) maxX = ex;
      if (ey < minY) minY = ey;
      if (ey > maxY) maxY = ey;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    // +/-1 px so the bilinear taps at the tile edge stay inside the window
    const x0 = Math.max(0, Math.floor(minX) - 1);
    const y0 = Math.max(0, Math.floor(minY) - 1);
    const x1 = Math.min(lw, Math.ceil(maxX) + 2);
    const y1 = Math.min(lh, Math.ceil(maxY) + 2);
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;

    const win = await this._readHeights(lvl, x0, y0, x1, y1);
    const heights = new Float32Array(GRID * GRID).fill(this._baseHeight);
    for (let n = 0; n < GRID * GRID; n++) {
      const ex = px[n * 2];
      const ey = px[n * 2 + 1];
      if (!Number.isFinite(ex) || !Number.isFinite(ey)) continue;
      // outside the raster -> base height, same as the grid path
      if (ex < 0 || ey < 0 || ex > lw - 1 || ey > lh - 1) continue;
      heights[n] = CogTerrainProvider._sampleWindow(win, ex, ey);
    }
    return heights;
  }
}
