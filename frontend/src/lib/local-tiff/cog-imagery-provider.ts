/**
 * Cesium ImageryProvider over a local GeoTIFF orthophoto.
 *
 * Per requested tile: pick the resolution level matching the tile's ground
 * resolution -> build a source-pixel mosaic of just the covering region
 * (hardware-decoded for JPEG/WebP COGs, geotiff.js for other compressions,
 * RAM slice for preloaded normal TIFFs) -> GPU affine warp into the tile.
 * No per-pixel JavaScript work on the hot path.
 */

import {
  Credit,
  Event as CesiumEvent,
  GeographicTilingScheme,
  Rectangle,
  Math as CesiumMath,
} from 'cesium';

import { createLimiter } from './limiter';
import type { CogSource } from './cog-source';

const TILE_SIZE = 512;           // matches COG block size -> fewer requests
const NATIVE_MAX_TILES = 36;     // mosaic cap for the native-decode path
const DECODED_TILE_LRU = 512;    // decoded internal tiles kept in memory
const MAX_CONCURRENT = 16;       // simultaneous tile builds
const WATCHDOG_MS = 120000;      // only a truly stuck request trips this
const BLACK_KEY = 8;             // r,g,b all <= this -> treated as no-data

interface Mosaic {
  canvas: OffscreenCanvas;
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** Make (near-)black pixels transparent — JPEG no-data collars. */
function keyOutBlack(canvas: OffscreenCanvas): void {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] <= BLACK_KEY && d[i + 1] <= BLACK_KEY && d[i + 2] <= BLACK_KEY) d[i + 3] = 0;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Decode one raw internal COG tile with the browser's hardware decoder.
 * TIFF-JPEG tiles share tables via the JPEGTables tag:
 *   merged stream = SOI + tables + (tile stream minus its SOI)
 */
function decodeTileNative(fd: any, bytes: ArrayBuffer): Promise<ImageBitmap> | null {
  if (fd.Compression === 7) {
    const tables = fd.JPEGTables;
    const data = new Uint8Array(bytes);
    const parts = tables && tables.length > 4
      ? [new Uint8Array(tables).slice(0, tables.length - 2), data.slice(2)]
      : [data];
    return createImageBitmap(new Blob(parts as BlobPart[], { type: 'image/jpeg' }));
  }
  if (fd.Compression === 50001) {
    return createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
  }
  return null;
}

/**
 * Canvas -> ImageBitmap for Cesium, flipped vertically on purpose.
 *
 * Cesium uploads imagery with UNPACK_FLIP_Y_WEBGL = true (Texture's default
 * flipY), which assumes a top-down source like <img>. The WebGL spec says
 * that pixel-store flag is IGNORED for ImageBitmap sources, so a north-up
 * bitmap lands in the texture with row 0 at v = 0, i.e. mirrored north/south.
 * Cesium's own loader avoids this by asking createImageBitmap to flip; do the
 * same here. Without it every tile is drawn upside down inside its own
 * footprint, so the visible image jumps to a different part of the ortho at
 * each zoom level (each level has a different tile grid).
 */
function toTexture(canvas: OffscreenCanvas): Promise<ImageBitmap> {
  return createImageBitmap(canvas, { imageOrientation: 'flipY' });
}

function transparent(): Promise<ImageBitmap> {
  return createImageBitmap(new ImageData(TILE_SIZE, TILE_SIZE));
}

export interface CogImageryOptions {
  /**
   * Treat black pixels as transparent no-data.
   * Default: on when the file has no alpha band, because a JPEG-compressed
   * COG cannot carry one and its no-data collar arrives as black.
   */
  hideBlack?: boolean;
}

export class CogImageryProvider {
  private _source: CogSource;
  private _hideBlack: boolean;
  private _limit: <T>(fn: () => T | Promise<T>) => Promise<T>;
  private _tilingScheme: GeographicTilingScheme;
  private _rectangle: Rectangle;
  private _errorEvent: CesiumEvent;
  private _credit: Credit;
  private _lru: Map<string, Promise<ImageBitmap | null>>;
  private _maximumLevel: number;
  private _minimumLevel: number;

  constructor(source: CogSource, options: CogImageryOptions = {}) {
    this._source = source;
    this._hideBlack = options.hideBlack ?? !source.hasAlphaBand;
    this._limit = createLimiter(MAX_CONCURRENT);
    this._tilingScheme = new GeographicTilingScheme();
    const { west, south, east, north } = source.geoExtent;
    this._rectangle = Rectangle.fromDegrees(west, south, east, north);
    this._errorEvent = new CesiumEvent();
    this._credit = new Credit('Local GeoTIFF');
    this._lru = new Map(); // "level:tileIndex" -> Promise<ImageBitmap>

    const nativeRes = source.levelResolution(0);
    const unitsPerDeg = source.converter
      ? 111320 * Math.cos(CesiumMath.toRadians((south + north) / 2))
      : 1;
    let level = 0;
    while (this._tileResUnits(level, unitsPerDeg) > nativeRes && level < 24) level++;
    this._maximumLevel = level;

    // Coarsest level worth serving: where the data spans at least one tile.
    // Cesium then never requests the planet-sized level 0..N tiles for this
    // layer (a stuck or slow one of those blanks an entire hemisphere).
    const extentDeg = Math.max(east - west, north - south);
    let minLevel = 0;
    while (minLevel < this._maximumLevel &&
           180 / this._tilingScheme.getNumberOfYTilesAtLevel(minLevel) > extentDeg) minLevel++;
    this._minimumLevel = Math.max(0, minLevel - 1);
  }

  private _tileResUnits(level: number, unitsPerDeg: number): number {
    const degPerTile = 180 / this._tilingScheme.getNumberOfYTilesAtLevel(level);
    return (degPerTile / TILE_SIZE) * unitsPerDeg;
  }

  get tilingScheme() { return this._tilingScheme; }
  get rectangle() { return this._rectangle; }
  get tileWidth() { return TILE_SIZE; }
  get tileHeight() { return TILE_SIZE; }
  get maximumLevel() { return this._maximumLevel; }
  get minimumLevel() { return this._minimumLevel; }
  get errorEvent() { return this._errorEvent; }
  get credit() { return this._credit; }
  get proxy() { return undefined; }
  get hasAlphaChannel() { return true; }
  get tileDiscardPolicy() { return undefined; }
  get ready() { return true; }

  getTileCredits() { return undefined; }
  pickFeatures() { return undefined; }

  requestImage(x: number, y: number, level: number): Promise<ImageBitmap> {
    // watchdog: a request that never settles would freeze that part of the
    // globe forever — resolve transparent instead so the globe keeps drawing
    return this._limit(() => new Promise<ImageBitmap>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        console.warn(`imagery tile ${level}/${x}/${y} timed out`);
        resolve(transparent());
      }, WATCHDOG_MS);
      this._requestImage(x, y, level)
        .catch((err) => {
          console.warn(`imagery tile ${level}/${x}/${y} failed:`, err);
          return transparent();
        })
        .then((img) => {
          clearTimeout(timer);
          if (!done) { done = true; resolve(img); }
        });
    }));
  }

  private async _requestImage(x: number, y: number, level: number): Promise<ImageBitmap> {
    const src = this._source;
    // whole dataset smaller than one pixel of this tile -> nothing to draw
    const tileDeg = 180 / this._tilingScheme.getNumberOfYTilesAtLevel(level);
    const { west: w0, east: e0, south: s0, north: n0 } = src.geoExtent;
    if (Math.max(e0 - w0, n0 - s0) / tileDeg * TILE_SIZE < 0.5) return transparent();

    const r = this._tilingScheme.tileXYToRectangle(x, y, level);
    const rect = {
      west: CesiumMath.toDegrees(r.west), east: CesiumMath.toDegrees(r.east),
      south: CesiumMath.toDegrees(r.south), north: CesiumMath.toDegrees(r.north),
    };

    // choose pyramid level from the tile's ground resolution in SOURCE units
    const midLat = (rect.south + rect.north) / 2;
    const [cx0] = src.forward(rect.west, midLat);
    const [cx1] = src.forward(rect.east, midLat);
    const lvl = src.selectLevel(Math.abs(cx1 - cx0) / TILE_SIZE || src.levelResolution(0));
    const lw = src.levels[lvl].width;
    const lh = src.levels[lvl].height;

    // destination tile corners in source pixel coords (this level)
    const toPx = (lon: number, lat: number): [number, number] => {
      const [px, py] = src.forward(lon, lat);
      return src.projToPixel(lvl, px, py);
    };
    const p00 = toPx(rect.west, rect.north);
    const p10 = toPx(rect.east, rect.north);
    const p01 = toPx(rect.west, rect.south);
    const p11 = toPx(rect.east, rect.south);
    if (![p00, p10, p01, p11].flat().every(Number.isFinite)) return transparent();

    const x0 = Math.max(0, Math.floor(Math.min(p00[0], p10[0], p01[0], p11[0])) - 2);
    const y0 = Math.max(0, Math.floor(Math.min(p00[1], p10[1], p01[1], p11[1])) - 2);
    const x1 = Math.min(lw, Math.ceil(Math.max(p00[0], p10[0], p01[0], p11[0])) + 2);
    const y1 = Math.min(lh, Math.ceil(Math.max(p00[1], p10[1], p01[1], p11[1])) + 2);
    if (x1 - x0 < 1 || y1 - y0 < 1) return transparent();

    let mosaic: Mosaic | null = null;
    // Asked per level: an overview can be tiled and JPEG while the base image
    // is stripped, in which case only the overview takes the fast path.
    if (src.isLevelNativeDecodable(lvl)) mosaic = await this._nativeMosaic(lvl, x0, y0, x1, y1);
    if (!mosaic) mosaic = await this._rasterMosaic(lvl, x0, y0, x1, y1);
    if (!mosaic) return transparent();

    // affine: source level pixels -> destination tile pixels (GPU)
    const a = (p10[0] - p00[0]) / TILE_SIZE, b = (p10[1] - p00[1]) / TILE_SIZE;
    const c = (p01[0] - p00[0]) / TILE_SIZE, d = (p01[1] - p00[1]) / TILE_SIZE;
    const det = a * d - b * c;
    if (!det) return transparent();
    const dest = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = dest.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(
      d / det, -b / det, -c / det, a / det,
      (c * p00[1] - d * p00[0]) / det,
      (b * p00[0] - a * p00[1]) / det
    );
    ctx.drawImage(mosaic.canvas, mosaic.x0, mosaic.y0, mosaic.w, mosaic.h);
    if (this._hideBlack) keyOutBlack(dest);
    return toTexture(dest);
  }

  /** Hardware-decoded mosaic of the internal COG tiles covering the window. */
  private async _nativeMosaic(
    lvl: number, x0: number, y0: number, x1: number, y1: number
  ): Promise<Mosaic | null> {
    const src = this._source;
    const fd = src.levels[lvl].image.fileDirectory;
    const tw = fd.TileWidth, th = fd.TileLength;
    const tilesAcross = Math.ceil(src.levels[lvl].width / tw);
    const tX0 = Math.floor(x0 / tw), tX1 = Math.floor((x1 - 1) / tw);
    const tY0 = Math.floor(y0 / th), tY1 = Math.floor((y1 - 1) / th);
    if ((tX1 - tX0 + 1) * (tY1 - tY0 + 1) > NATIVE_MAX_TILES) return null;

    const canvas = new OffscreenCanvas(x1 - x0, y1 - y0);
    const ctx = canvas.getContext('2d')!;
    const jobs: Promise<void>[] = [];
    for (let ty = tY0; ty <= tY1; ty++) {
      for (let tx = tX0; tx <= tX1; tx++) {
        const idx = ty * tilesAcross + tx;
        const off = fd.TileOffsets[idx];
        const len = fd.TileByteCounts[idx];
        if (!off || !len) continue; // sparse tile -> stays transparent
        jobs.push(
          this._decodedTile(lvl, idx, off, len, fd)
            .then((bmp) => { if (bmp) ctx.drawImage(bmp, tx * tw - x0, ty * th - y0); })
        );
      }
    }
    await Promise.all(jobs);
    return { canvas, x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  /** LRU-cached hardware decode of one internal tile. */
  private _decodedTile(
    lvl: number, idx: number, off: number, len: number, fd: any
  ): Promise<ImageBitmap | null> {
    const key = `${lvl}:${idx}`;
    const hit = this._lru.get(key);
    if (hit) {
      this._lru.delete(key);
      this._lru.set(key, hit); // refresh recency
      return hit;
    }
    const p = this._source.file.slice(off, off + len).arrayBuffer()
      .then((bytes) => decodeTileNative(fd, bytes))
      .catch(() => null);
    this._lru.set(key, p);
    if (this._lru.size > DECODED_TILE_LRU) {
      const oldest = this._lru.keys().next().value;
      if (oldest !== undefined) this._lru.delete(oldest);
    }
    return p;
  }

  /**
   * Drop the decoded-tile cache. Each entry is an ImageBitmap holding memory
   * the garbage collector will not reclaim on its own, so they are closed
   * explicitly rather than just dereferenced.
   */
  async dispose(): Promise<void> {
    const pending = [...this._lru.values()];
    this._lru.clear();
    for (const entry of pending) {
      try {
        (await entry)?.close();
      } catch {
        // a tile that never decoded has nothing to close
      }
    }
  }

  /** geotiff.js / in-memory raster -> RGBA canvas (any compression). */
  private async _rasterMosaic(
    lvl: number, x0: number, y0: number, x1: number, y1: number
  ): Promise<Mosaic | null> {
    const src = this._source;
    const win = await src.readWindow(lvl, x0, y0, x1, y1, 2048);
    if (!win) return null;
    const { data, w, h, bands } = win;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const hasAlpha = src.hasAlphaBand;
    const gray = bands === 1;
    const nd = src.noData;
    const checkNd = nd !== null && nd !== undefined;
    for (let i = 0, s = 0, o = 0; i < w * h; i++, s += bands, o += 4) {
      const r = data[s];
      const g = gray ? r : data[s + 1];
      const b = gray ? r : data[s + 2];
      if (checkNd && r === nd && g === nd && b === nd) continue; // transparent
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
      rgba[o + 3] = hasAlpha ? data[s + 3] : 255;
    }
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
    // window may be downsampled: report its footprint in level pixels
    return { canvas, x0: win.x0, y0: win.y0, w: w / win.sx, h: h / win.sy };
  }
}
