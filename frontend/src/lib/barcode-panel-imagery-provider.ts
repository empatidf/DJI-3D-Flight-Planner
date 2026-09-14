/**
 * Barcode Scan panels as a Cesium imagery layer.
 *
 * A solar park has tens of thousands of modules. Drawn as ground-clamped
 * geometry, Cesium builds a terrain-classification volume for every panel and
 * every outline segment and renders all of them each frame, which was enough
 * to bring a workstation to its knees. Painted into imagery tiles instead, the
 * panels cost the same as an orthophoto: only tiles on screen exist, each is a
 * 256 px canvas holding just the panels inside it, and the globe drapes them
 * over whatever terrain is loaded, local DSM included, in 3D and 2D alike.
 */

import { Credit, Event as CesiumEvent, GeographicTilingScheme, Math as CesiumMath, Rectangle } from 'cesium';
import type { PanelBounds, PanelSize, PanelStyle } from './barcode-panels';

const TILE_SIZE = 256;
/** Stop refining once one tile pixel covers this much ground. */
const FINEST_METERS_PER_PIXEL = 0.015;
const MAX_LEVEL_CAP = 24;
/** Spatial grid cell in degrees (~11 m): a few dozen panels per cell. */
const GRID_CELL_DEG = 0.0001;
/** Narrower than this on screen, a panel is drawn as a solid block: an outline would only be noise. */
const OUTLINE_MIN_PIXELS = 3;
/** Extra query margin for strokes that spill over a tile edge. */
const STROKE_MARGIN_PIXELS = 8;
const METERS_PER_DEGREE_LAT = 110574;

/**
 * Panels bucketed by centre into a regular lon/lat grid, so a tile only visits
 * the panels near it. Built once per layout and reused for every style change.
 */
export class PanelTileIndex {
  readonly corners: Float64Array;
  readonly count: number;
  readonly bounds: PanelBounds;
  readonly panelSize: PanelSize;
  /** Largest half-extent of any panel in degrees, so edge panels are not missed. */
  readonly marginLon: number;
  readonly marginLat: number;
  private readonly columns: number;
  private readonly rows: number;
  /** Panels of cell c are cellPanels[cellStart[c] .. cellStart[c + 1]). */
  private readonly cellStart: Uint32Array;
  private readonly cellPanels: Uint32Array;

  constructor(corners: Float64Array, bounds: PanelBounds, panelSize: PanelSize) {
    this.corners = corners;
    this.count = Math.floor(corners.length / 8);
    this.bounds = bounds;
    this.panelSize = panelSize;
    this.columns = Math.max(1, Math.ceil((bounds.east - bounds.west) / GRID_CELL_DEG));
    this.rows = Math.max(1, Math.ceil((bounds.north - bounds.south) / GRID_CELL_DEG));

    const cellOfPanel = new Uint32Array(this.count);
    const cellStart = new Uint32Array(this.columns * this.rows + 1);
    let marginLon = 0;
    let marginLat = 0;

    for (let panel = 0; panel < this.count; panel++) {
      const offset = panel * 8;
      let minLon = Infinity;
      let maxLon = -Infinity;
      let minLat = Infinity;
      let maxLat = -Infinity;
      for (let k = 0; k < 8; k += 2) {
        const lon = corners[offset + k];
        const lat = corners[offset + k + 1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      marginLon = Math.max(marginLon, (maxLon - minLon) / 2);
      marginLat = Math.max(marginLat, (maxLat - minLat) / 2);

      const cell = this.row((minLat + maxLat) / 2) * this.columns + this.column((minLon + maxLon) / 2);
      cellOfPanel[panel] = cell;
      cellStart[cell + 1]++;
    }

    for (let cell = 1; cell < cellStart.length; cell++) cellStart[cell] += cellStart[cell - 1];

    const cursor = cellStart.slice(0, cellStart.length - 1);
    const cellPanels = new Uint32Array(this.count);
    for (let panel = 0; panel < this.count; panel++) {
      cellPanels[cursor[cellOfPanel[panel]]++] = panel;
    }

    this.cellStart = cellStart;
    this.cellPanels = cellPanels;
    this.marginLon = marginLon;
    this.marginLat = marginLat;
  }

  private column(lon: number) {
    return Math.min(this.columns - 1, Math.max(0, Math.floor((lon - this.bounds.west) / GRID_CELL_DEG)));
  }

  private row(lat: number) {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((lat - this.bounds.south) / GRID_CELL_DEG)));
  }

  /** Visit every panel that may overlap the rectangle (degrees). */
  forEachNear(west: number, south: number, east: number, north: number, visit: (panel: number) => void) {
    const w = west - this.marginLon;
    const e = east + this.marginLon;
    const s = south - this.marginLat;
    const n = north + this.marginLat;
    const { bounds } = this;
    if (e < bounds.west || w > bounds.east || n < bounds.south || s > bounds.north) return;

    const column0 = this.column(w);
    const column1 = this.column(e);
    const row0 = this.row(s);
    const row1 = this.row(n);
    for (let row = row0; row <= row1; row++) {
      for (let column = column0; column <= column1; column++) {
        const cell = row * this.columns + column;
        for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) visit(this.cellPanels[k]);
      }
    }
  }
}

/** Duck-typed Cesium ImageryProvider, like the local GeoTIFF provider. */
export class BarcodePanelImageryProvider {
  private readonly index: PanelTileIndex;
  private readonly style: PanelStyle;
  private readonly _tilingScheme = new GeographicTilingScheme();
  private readonly _rectangle: Rectangle;
  private readonly _errorEvent = new CesiumEvent();
  private readonly _credit = new Credit('Panel layout');
  private readonly _minimumLevel: number;
  private readonly _maximumLevel: number;

  constructor(index: PanelTileIndex, style: PanelStyle) {
    this.index = index;
    this.style = style;

    const { west, south, east, north } = index.bounds;
    this._rectangle = Rectangle.fromDegrees(
      Math.max(-180, west - index.marginLon * 2),
      Math.max(-90, south - index.marginLat * 2),
      Math.min(180, east + index.marginLon * 2),
      Math.min(90, north + index.marginLat * 2)
    );

    let level = 0;
    while (level < MAX_LEVEL_CAP && this.metersPerPixel(level) > FINEST_METERS_PER_PIXEL) level++;
    this._maximumLevel = level;

    // Coarsest level worth serving: where the park spans about one tile. Cesium
    // then never asks for hemisphere-sized tiles for this layer.
    const extentDeg = Math.max(east - west, north - south);
    let minLevel = 0;
    while (minLevel < level && 180 / this._tilingScheme.getNumberOfYTilesAtLevel(minLevel) > extentDeg) minLevel++;
    this._minimumLevel = Math.max(0, minLevel - 1);
  }

  private metersPerPixel(level: number) {
    return (180 / this._tilingScheme.getNumberOfYTilesAtLevel(level) / TILE_SIZE) * METERS_PER_DEGREE_LAT;
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

  requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
    return Promise.resolve(this.drawTile(x, y, level));
  }

  /**
   * A plain canvas, not an ImageBitmap: Cesium's upload flip applies to
   * canvases, so north stays up without flipping by hand.
   */
  private drawTile(x: number, y: number, level: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;

    const { style, index } = this;
    if (!style.outlineEnabled && !style.fillEnabled) return canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    const tile = this._tilingScheme.tileXYToRectangle(x, y, level);
    const west = CesiumMath.toDegrees(tile.west);
    const east = CesiumMath.toDegrees(tile.east);
    const south = CesiumMath.toDegrees(tile.south);
    const north = CesiumMath.toDegrees(tile.north);
    const scaleX = TILE_SIZE / (east - west);
    const scaleY = TILE_SIZE / (north - south);
    const panelPixels = index.panelSize.width / (((north - south) / TILE_SIZE) * METERS_PER_DEGREE_LAT);

    const marginLon = STROKE_MARGIN_PIXELS / scaleX;
    const marginLat = STROKE_MARGIN_PIXELS / scaleY;
    const { corners } = index;

    ctx.beginPath();

    if (panelPixels < OUTLINE_MIN_PIXELS) {
      // Far away: one solid block per panel keeps the rows readable.
      index.forEachNear(west, south, east, north, (panel) => {
        const offset = panel * 8;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let k = 0; k < 8; k += 2) {
          const px = (corners[offset + k] - west) * scaleX;
          const py = (north - corners[offset + k + 1]) * scaleY;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
        ctx.rect(Math.floor(minX), Math.floor(minY), Math.max(1, Math.ceil(maxX - minX)), Math.max(1, Math.ceil(maxY - minY)));
      });
      ctx.globalAlpha = style.outlineEnabled ? 1 : style.fillOpacity;
      ctx.fillStyle = style.outlineEnabled ? style.outlineColor : style.fillColor;
      ctx.fill();
      return canvas;
    }

    // One path for every panel in the tile: a single fill and a single stroke call.
    index.forEachNear(west - marginLon, south - marginLat, east + marginLon, north + marginLat, (panel) => {
      const offset = panel * 8;
      ctx.moveTo((corners[offset] - west) * scaleX, (north - corners[offset + 1]) * scaleY);
      ctx.lineTo((corners[offset + 2] - west) * scaleX, (north - corners[offset + 3]) * scaleY);
      ctx.lineTo((corners[offset + 4] - west) * scaleX, (north - corners[offset + 5]) * scaleY);
      ctx.lineTo((corners[offset + 6] - west) * scaleX, (north - corners[offset + 7]) * scaleY);
      ctx.closePath();
    });

    if (style.fillEnabled) {
      ctx.globalAlpha = style.fillOpacity;
      ctx.fillStyle = style.fillColor;
      ctx.fill();
    }
    if (style.outlineEnabled) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = style.outlineColor;
      // A stroke wider than a third of the panel would swallow it at medium zoom.
      ctx.lineWidth = Math.max(1, Math.min(style.outlineWidth, panelPixels / 3));
      ctx.lineJoin = 'miter';
      ctx.stroke();
    }

    return canvas;
  }
}
