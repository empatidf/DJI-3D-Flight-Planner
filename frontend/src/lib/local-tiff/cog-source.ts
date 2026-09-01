/**
 * One local GeoTIFF (RGB orthophoto or DSM), read directly in the browser.
 *
 * Nothing is uploaded and there is no server: COG tiles are sliced straight
 * out of the picked File with File.slice(), which plays the role HTTP range
 * requests play for a remote COG.
 */

import { fromBlob, Pool } from 'geotiff';
import proj4 from 'proj4';
import { registerCRS } from '../coordinate-transform';

let sharedPool: Pool | null = null;

/** One shared decode pool (worker count = CPU cores, capped). */
export function getPool(): Pool {
  if (!sharedPool) {
    sharedPool = new Pool(Math.min(navigator.hardwareConcurrency || 4, 8));
  }
  return sharedPool;
}

/**
 * Shut the decode workers down. Worth doing once the last local file is
 * unloaded: the pool holds one worker per core for as long as it exists.
 * getPool() simply builds a new one if another file is opened later.
 */
export function destroyPool(): void {
  try {
    (sharedPool as any)?.destroy?.();
  } catch (error) {
    console.warn('[LocalTiff] Could not destroy the decode pool:', error);
  }
  sharedPool = null;
}

// Non-COG ("normal") TIFFs have no tile index / overviews, so per-view
// windowed reads would decode the whole file again and again. Instead they
// are decoded ONCE into memory at a capped resolution and served from RAM.
const PRELOAD_MAX_RGB = 8192; // px, longest side (~256 MB RGBA)
const PRELOAD_MAX_DSM = 4096; // px, longest side (~64 MB float32)

// A stripped image is still worth reading windowed while its strips are short.
// Above this a single strip covers so much of the image that every tile would
// decode most of the file, so preloading once is cheaper.
const MAX_STRIP_ROWS = 1024;

const COMPRESSION_NAMES: Record<number, string> = {
  1: 'none', 5: 'LZW', 6: 'old-JPEG', 7: 'JPEG', 8: 'DEFLATE', 32946: 'DEFLATE',
  32773: 'PackBits', 34887: 'LERC', 50000: 'ZSTD', 50001: 'WebP', 34925: 'LZMA',
  50002: 'JXL',
};
// geotiff.js cannot decode these in the browser -> tiles would fail/hang
const UNSUPPORTED_COMPRESSION = new Set([6, 34887, 50000, 34925, 50002]);

export type CogKind = 'rgb' | 'dsm';

export interface GeoExtent {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface RasterWindow {
  /** interleaved samples, band-major per pixel */
  data: any;
  w: number;
  h: number;
  x0: number;
  y0: number;
  /** window-buffer pixels per level pixel (<= 1 when downsampled) */
  sx: number;
  sy: number;
  bands: number;
}

interface Level {
  image: any;
  width: number;
  height: number;
  inMemory?: boolean;
}

/** ETRS89 is within ~1 m of WGS84 in Europe, which is how GIS tools treat it. */
const ETRS89 = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0';

export const epsgFromGeoKeys = (geoKeys: any): number | null =>
  geoKeys?.ProjectedCSTypeGeoKey ?? geoKeys?.GeographicTypeGeoKey ?? null;

/**
 * proj4 definition for the EPSG code in the GeoTIFF keys.
 * null = already WGS84 geographic (no reprojection needed).
 */
function projDefFromGeoKeys(geoKeys: any): string | null {
  const epsg = epsgFromGeoKeys(geoKeys);
  // 4326 WGS84, 4258 ETRS89: both already geographic degrees
  if (epsg === null || epsg === 4326 || epsg === 4258) return null;
  if (epsg === 3857) return 'EPSG:3857';
  // ETRS89 / LAEA Europe — the standard pan-European equal-area grid
  if (epsg === 3035) {
    return `+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 ${ETRS89} +units=m +no_defs`;
  }
  if (epsg >= 32601 && epsg <= 32660) {
    return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  }
  if (epsg >= 32701 && epsg <= 32760) {
    return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
  }
  // ETRS89 / UTM zones 28N-38N (25828-25838). EPSG:25832 is the default grid
  // for German survey data, so drone deliverables land here constantly.
  if (epsg >= 25828 && epsg <= 25838) {
    return `+proj=utm +zone=${epsg - 25800} ${ETRS89} +units=m +no_defs`;
  }
  throw new Error(
    `Unsupported CRS EPSG:${epsg}. Either reproject the file ` +
    `(gdalwarp in.tif out.tif -t_srs EPSG:25832) or add a proj4 definition in ` +
    `projDefFromGeoKeys() (lib/local-tiff/cog-source.ts).`
  );
}

/**
 * A CRS borrowed from an already-loaded file, for GeoTIFFs that carry no
 * projection tag at all (common with DSMs written by photogrammetry software).
 */
export interface CrsFallback {
  def: string | null;
  epsg: number | null;
  bboxProj: [number, number, number, number];
  sourceName: string;
}

const looksProjected = (bbox: [number, number, number, number]): boolean =>
  Math.abs(bbox[0]) > 360 || Math.abs(bbox[2]) > 360 ||
  Math.abs(bbox[1]) > 90 || Math.abs(bbox[3]) > 90;

const bboxesOverlap = (
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * Cache one proj4 converter per source. The terrain provider runs 65x65
 * forward transforms per tile, so re-resolving the projection on every call
 * (what coordinate-transform.transformCoordinate does) is far too slow here.
 */
function converterFor(epsg: number | null, def: string): any {
  if (def.startsWith('EPSG:')) return proj4(def);
  const code = `EPSG:${epsg}`;
  registerCRS(code, `${def} +type=crs`);
  return proj4(code);
}

/**
 * Exposes resolution levels, geographic extent, coordinate transforms and
 * windowed pixel reads.
 *  - COG: levels = base + overviews, reads hit only the needed bytes.
 *  - normal TIFF: one in-memory level, reads are array slices.
 */
export class CogSource {
  file!: File;
  tiff: any;
  kind: CogKind = 'rgb';
  levels: Level[] = [];
  geoKeys: any;
  /** [minX, minY, maxX, maxY] in the source CRS */
  bboxProj!: [number, number, number, number];
  samplesPerPixel = 1;
  noData: number | null = null;
  isTiled = false;
  compression = 1;
  compressionName = 'none';
  fullWidth = 0;
  fullHeight = 0;
  hasAlphaBand = false;
  converter: any = null;
  geoExtent!: GeoExtent;
  memory: { data: any; width: number; height: number } | null = null;
  /** proj4 definition actually in use, so another file can borrow it */
  projDef: string | null = null;
  crsEpsg: number | null = null;
  /** set when the CRS was borrowed because the file declared none */
  crsBorrowedFrom: string | null = null;

  private _readErrorLogged = false;

  static async open(
    file: File,
    kind: CogKind = 'rgb',
    fallback?: CrsFallback | null
  ): Promise<CogSource> {
    const tiff: any = await fromBlob(file);
    const src = new CogSource();
    src.file = file;
    src.tiff = tiff;
    src.kind = kind;

    const count = await tiff.getImageCount();
    const base: any = await tiff.getImage(0);
    src.levels = [{ image: base, width: base.getWidth(), height: base.getHeight() }];
    const baseAspect = base.getWidth() / base.getHeight();
    for (let i = 1; i < count; i++) {
      const img: any = await tiff.getImage(i);
      const aspect = img.getWidth() / img.getHeight();
      // only accept IFDs that are strictly smaller AND the same aspect: real
      // overviews, not masks / thumbnails / subdatasets
      if (img.getWidth() < src.levels[src.levels.length - 1].width &&
          Math.abs(aspect - baseAspect) / baseAspect < 0.05) {
        src.levels.push({ image: img, width: img.getWidth(), height: img.getHeight() });
      }
    }

    const fd = base.fileDirectory;
    src.geoKeys = base.getGeoKeys();
    src.bboxProj = base.getBoundingBox() as [number, number, number, number];
    src.samplesPerPixel = base.getSamplesPerPixel();
    src.noData = base.getGDALNoData();
    src.isTiled = base.isTiled;
    src.compression = fd.Compression;
    src.compressionName = COMPRESSION_NAMES[fd.Compression] || `code ${fd.Compression}`;
    if (UNSUPPORTED_COMPRESSION.has(fd.Compression)) {
      const recompress = kind === 'dsm'
        ? 'DEFLATE -co PREDICTOR=3'
        : 'JPEG -co QUALITY=85';
      throw new Error(
        `${file.name}: compression ${src.compressionName} cannot be decoded in the browser. ` +
        `Recompress: gdal_translate in.tif out.tif -of COG -co COMPRESS=${recompress} -co BLOCKSIZE=512`
      );
    }
    src.fullWidth = base.getWidth();
    src.fullHeight = base.getHeight();
    // band 4 is alpha only if the file declares it (ExtraSamples); otherwise
    // it is data (e.g. NIR) and must not make the layer transparent
    const extra: any = fd.ExtraSamples;
    // ExtraSamples is an array or typed array when present; a bare value counts
    // as declared too.
    const declaresExtra = extra != null &&
      (typeof extra.length === 'number' ? extra.length > 0 : true);
    src.hasAlphaBand = src.samplesPerPixel >= 4 && declaresExtra;

    let def = projDefFromGeoKeys(src.geoKeys);
    let epsg = epsgFromGeoKeys(src.geoKeys);

    // Some tools (photogrammetry DSM exports in particular) write the tie point
    // and pixel scale but no projection tag at all. The coordinates are then
    // plainly projected metres with nothing saying which grid. Borrow the CRS
    // from a file already loaded for this site when the two actually overlap —
    // a mismatched pair cannot pass that test.
    if (epsg === null && looksProjected(src.bboxProj) && fallback?.def &&
        bboxesOverlap(src.bboxProj, fallback.bboxProj)) {
      def = fallback.def;
      epsg = fallback.epsg;
      src.crsBorrowedFrom = fallback.sourceName;
    }

    src.projDef = def;
    src.crsEpsg = epsg;
    src.converter = def ? converterFor(epsg, def) : null;
    src._computeGeoExtent();

    if (!src.canReadWindowed) {
      await src._preload(kind === 'dsm' ? PRELOAD_MAX_DSM : PRELOAD_MAX_RGB);
    }
    return src;
  }

  /** internal overview pyramid (extra IFDs inside this file) */
  get hasOverviews(): boolean {
    return this.levels.length > 1 && !this.memory;
  }

  /** tiled base + overview pyramid: a Cloud Optimized GeoTIFF proper */
  get isCog(): boolean {
    return this.isTiled && this.levels.length > 1;
  }

  /** rows per strip of the base image, or null when it is tiled */
  get baseStripRows(): number | null {
    if (this.isTiled) return null;
    const rps = Number(this.levels[0]?.image?.fileDirectory?.RowsPerStrip);
    return Number.isFinite(rps) && rps > 0 ? rps : null;
  }

  /**
   * Can windows be read straight from the file, or must it be decoded into RAM?
   *
   * A tiled COG obviously can. So can a *stripped* file with overviews and
   * short strips: geotiff decodes whole strips, so 16-row strips cost little
   * while one strip spanning the entire image would decode everything on every
   * tile — that case still preloads.
   */
  get canReadWindowed(): boolean {
    if (this.memory) return false;
    if (this.levels.length <= 1) return false;
    if (this.isTiled) return true;
    const rows = this.baseStripRows;
    return rows !== null && rows <= MAX_STRIP_ROWS && rows < this.fullHeight;
  }

  /**
   * Whether one pyramid level's raw tiles can go straight to the browser's
   * hardware decoder. Asked per level, because an overview may be tiled and
   * JPEG-compressed while the base image is stripped.
   *
   * JPEG has no alpha channel, so handing a JPEG tile to createImageBitmap
   * throws the transparency away and the no-data collar comes back as solid
   * black. When the file actually carries an alpha band, decode through
   * geotiff instead: slower per tile, but the collar stays transparent.
   * WebP keeps its alpha, so it stays on the fast path.
   */
  isLevelNativeDecodable(levelIndex: number): boolean {
    const lvl = this.levels[levelIndex];
    if (!lvl || lvl.inMemory) return false;
    const fd = lvl.image?.fileDirectory;
    if (!fd?.TileWidth || !fd?.TileOffsets) return false;
    if (fd.Compression === 7) return !this.hasAlphaBand;
    return fd.Compression === 50001;
  }

  /** raw tiles decodable by the browser's hardware decoder (JPEG / WebP) */
  get nativeDecodable(): boolean {
    return this.isLevelNativeDecodable(0);
  }

  /** Decode a normal TIFF once into RAM (downsampled to maxDim). */
  private async _preload(maxDim: number): Promise<void> {
    const base = this.levels[0];
    const scale = Math.max(base.width, base.height) / maxDim;
    const w = scale > 1 ? Math.round(base.width / scale) : base.width;
    const h = scale > 1 ? Math.round(base.height / scale) : base.height;
    const data = await base.image.readRasters({
      width: w, height: h, interleave: true, pool: getPool(),
    });
    this.memory = { data, width: w, height: h };
    this.levels = [{ image: base.image, width: w, height: h, inMemory: true }];
  }

  forward(lon: number, lat: number): [number, number] {
    return this.converter
      ? (this.converter.forward([lon, lat]) as [number, number])
      : [lon, lat];
  }

  inverse(x: number, y: number): [number, number] {
    return this.converter
      ? (this.converter.inverse([x, y]) as [number, number])
      : [x, y];
  }

  private _computeGeoExtent(): void {
    const [minX, minY, maxX, maxY] = this.bboxProj;
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    // Sample along the edges, not just the corners: a UTM bbox edge bows in
    // geographic space, so four corners understate the true extent.
    const N = 32;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      for (const [x, y] of [
        [minX + t * (maxX - minX), minY],
        [minX + t * (maxX - minX), maxY],
        [minX, minY + t * (maxY - minY)],
        [maxX, minY + t * (maxY - minY)],
      ]) {
        const [lon, lat] = this.inverse(x, y);
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
    this.geoExtent = { west, south, east, north };

    // Bad georeferencing breaks Cesium silently (half the globe vanishes,
    // camera flies to nowhere). Fail loudly with the numbers instead.
    const bad = ![west, south, east, north].every(Number.isFinite) ||
      west >= east || south >= north ||
      west < -180 || east > 180 || south < -90 || north > 90;
    if (bad) {
      const epsg = this.crsEpsg;
      let hint: string;
      if (epsg === null) {
        hint =
          'The file carries no coordinate system at all, and these look like projected ' +
          '(metre) coordinates. Load the matching orthophoto first so its CRS can be ' +
          'reused, or stamp one on the file: ' +
          'gdal_translate -a_srs EPSG:25832 in.tif out.tif';
      } else if (epsg === 4326) {
        hint =
          'The CRS tag says degrees but these look like projected (metre) coordinates. ' +
          'Fix with: gdal_translate -a_srs EPSG:<correct code> in.tif out.tif, or ' +
          'gdalwarp -t_srs EPSG:4326.';
      } else {
        hint = 'Check the file with gdalinfo.';
      }
      throw new Error(
        `${this.file.name}: invalid georeferencing. Bounds [${minX}, ${minY}, ${maxX}, ${maxY}] ` +
        `with EPSG:${epsg ?? 'none'} give lon ${west}..${east}, lat ${south}..${north}. ${hint}`
      );
    }
  }

  /** source CRS units per pixel at a level (x direction) */
  levelResolution(levelIndex: number): number {
    const [minX, , maxX] = this.bboxProj;
    return (maxX - minX) / this.levels[levelIndex].width;
  }

  /**
   * y resolution is NOT necessarily equal to x: a geographic (EPSG:4326)
   * orthophoto with square-meter pixels has y-res = x-res / cos(lat).
   */
  levelResolutionY(levelIndex: number): number {
    const [, minY, , maxY] = this.bboxProj;
    return (maxY - minY) / this.levels[levelIndex].height;
  }

  /** coarsest level still at least as fine as targetRes */
  selectLevel(targetRes: number): number {
    let best = 0;
    for (let i = 0; i < this.levels.length; i++) {
      if (this.levelResolution(i) <= targetRes) best = i;
      else break;
    }
    return best;
  }

  projToPixel(levelIndex: number, x: number, y: number): [number, number] {
    const [minX, , , maxY] = this.bboxProj;
    return [
      (x - minX) / this.levelResolution(levelIndex),
      (maxY - y) / this.levelResolutionY(levelIndex),
    ];
  }

  /**
   * Read a clamped pixel window from a level.
   * Returns null if the window is empty or the read failed.
   */
  async readWindow(
    levelIndex: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    maxSize = 2048
  ): Promise<RasterWindow | null> {
    const lvl = this.levels[levelIndex];
    if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(lvl.width, Math.ceil(x1));
    y1 = Math.min(lvl.height, Math.ceil(y1));
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;

    let outW = x1 - x0;
    let outH = y1 - y0;
    const scale = Math.max(outW, outH) / maxSize;
    if (scale > 1) {
      outW = Math.max(1, Math.round(outW / scale));
      outH = Math.max(1, Math.round(outH / scale));
    }
    const common = {
      w: outW, h: outH, x0, y0,
      sx: outW / (x1 - x0), sy: outH / (y1 - y0),
      bands: this.samplesPerPixel,
    };

    if (lvl.inMemory) {
      return { data: this._sliceMemory(x0, y0, x1, y1, outW, outH), ...common };
    }
    try {
      const data = await lvl.image.readRasters({
        window: [x0, y0, x1, y1],
        width: outW,
        height: outH,
        interleave: true,
        pool: getPool(),
      });
      return { data, ...common };
    } catch (err) {
      if (!this._readErrorLogged) {
        this._readErrorLogged = true;
        console.error(
          `${this.file.name}: tile read failed (level ${levelIndex}, window ${x0},${y0}-${x1},${y1}):`,
          err
        );
      }
      return null; // caller renders empty; globe keeps working
    }
  }

  private _sliceMemory(
    x0: number, y0: number, x1: number, y1: number, outW: number, outH: number
  ): any {
    const { data, width } = this.memory!;
    const bands = this.samplesPerPixel;
    const stepX = (x1 - x0) / outW;
    const stepY = (y1 - y0) / outH;
    const out = new (data.constructor as any)(outW * outH * bands);
    for (let j = 0; j < outH; j++) {
      const sy = y0 + Math.floor(j * stepY);
      for (let i = 0; i < outW; i++) {
        const sx = x0 + Math.floor(i * stepX);
        const s = (sy * width + sx) * bands;
        const d = (j * outW + i) * bands;
        for (let b = 0; b < bands; b++) out[d + b] = data[s + b];
      }
    }
    return out;
  }

  /** Summary for the panel's status row. */
  describe(): string {
    const mb = (this.file.size / 1024 / 1024).toFixed(0);
    const size = `${this.fullWidth}x${this.fullHeight}`;
    const crs = this.crsEpsg === null ? 'WGS84' : `EPSG:${this.crsEpsg}`;
    const overviews = this.levels.length - 1;
    const layout = this.isTiled
      ? 'tiled'
      : `stripped (${this.baseStripRows ?? '?'} rows/strip)`;

    const lines = [
      `${this.file.name} — ${mb} MB, ${size}, ${this.samplesPerPixel} band, ${crs}`,
    ];

    if (this.memory) {
      lines.push(
        `Base image ${layout}, ${overviews === 0 ? 'no' : overviews} internal overview level${overviews === 1 ? '' : 's'} — ` +
        `decoded into memory at ${this.memory.width}x${this.memory.height}, so detail is capped.`
      );
    } else {
      lines.push(
        `Base image ${layout}, ${overviews} internal overview level${overviews === 1 ? '' : 's'}, ` +
        `${this.compressionName}, ${this.nativeDecodable ? 'native decode' : 'JS decode'} — reading windows from the file.`
      );
    }

    if (this.crsBorrowedFrom) {
      lines.push(`No CRS in this file — using ${crs} from ${this.crsBorrowedFrom}.`);
    }

    if (!this.isCog) {
      // The usual cause: QGIS "Build Pyramids" defaults to Overview format =
      // External, which writes a .ovr next to the .tif. Only the .tif itself is
      // handed to the browser, so those pyramids are invisible here.
      lines.push(
        'Not a COG. If you built pyramids in QGIS, set Overview format = Internal — ' +
        'an External .ovr sidecar cannot be read here. Best is a real COG, which also ' +
        'tiles the base image: ' +
        `gdal_translate in.tif out.tif -of COG -co COMPRESS=${this.kind === 'dsm' ? 'DEFLATE -co PREDICTOR=3' : 'JPEG -co QUALITY=85'} -co BLOCKSIZE=512 -co BIGTIFF=YES`
      );
    }
    return lines.join('\n');
  }

  /**
   * Release the raster. A preloaded plain TIFF holds its whole decoded image
   * in `memory` (hundreds of MB), so dropping it matters.
   */
  dispose(): void {
    this.memory = null;
    this.levels = [];
    try {
      this.tiff?.close?.();
    } catch {
      // a source with nothing to close is fine
    }
    this.tiff = null;
  }

  /** What another file with no CRS tag can borrow from this one. */
  asCrsFallback(): CrsFallback {
    return {
      def: this.projDef,
      epsg: this.crsEpsg,
      bboxProj: this.bboxProj,
      sourceName: this.file.name,
    };
  }
}
