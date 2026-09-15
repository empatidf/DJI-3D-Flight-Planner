/**
 * Solar panel layouts for Barcode Scan missions.
 *
 * The input is the digital drawing of a solar park exported as KML: every PV
 * module is its own Placemark holding one rectangular Polygon (4 corners plus
 * the closing point). A site holds tens of thousands of modules — Goirle has
 * 26 108 in a 20 MB file — so the text is scanned with regular expressions
 * instead of a DOM, and the geometry is kept as one compact string instead of
 * nested arrays: the mission file stays a few MB and serialises as one token.
 */

import JSZip from 'jszip';

/** How a barcode label is marked on the map. `label` is the sticker itself, turned with its module. */
export type BarcodeSymbol = 'diamond' | 'square' | 'label' | 'circle';

export const BARCODE_SYMBOLS: { id: BarcodeSymbol; label: string }[] = [
  { id: 'diamond', label: 'Diamond' },
  { id: 'square', label: 'Square' },
  { id: 'label', label: 'Label rectangle (turned with the module)' },
  { id: 'circle', label: 'Circle' },
];

export interface PanelStyle {
  outlineEnabled: boolean;
  outlineColor: string; // CSS colour, #rrggbb
  outlineWidth: number; // screen pixels
  fillEnabled: boolean;
  fillColor: string; // CSS colour, #rrggbb
  fillOpacity: number; // 0..1
  /** Barcode label points; only drawn once a barcode position is set. */
  barcodeEnabled: boolean;
  barcodeColor: string; // CSS colour, #rrggbb
  barcodeSize: number; // screen pixels (symbol size)
  barcodeSymbol: BarcodeSymbol;
}

/** Outlined only: the imagery underneath stays readable. */
export const DEFAULT_PANEL_STYLE: PanelStyle = {
  outlineEnabled: true,
  outlineColor: '#00e5ff',
  outlineWidth: 2,
  fillEnabled: false,
  fillColor: '#ffd400',
  fillOpacity: 0.45,
  barcodeEnabled: true,
  barcodeColor: '#ff3bd4',
  barcodeSize: 6,
  barcodeSymbol: 'diamond',
};

export interface PanelBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface PanelSize {
  width: number; // short side, meters
  length: number; // long side, meters
}

/**
 * How the modules are mounted.
 *
 * A table is a group of touching modules. Across a table there are `rows`
 * modules, along it `modulesPerRow`. Portrait means a module's long side runs
 * across the table (a "3P" table is three modules high); landscape means along
 * it. A single string of modules is 1P.
 */
export interface PanelStructure {
  rows: number;
  orientation: 'portrait' | 'landscape';
  tableCount: number;
  /** Most common count on tables of the dominant configuration, and its range. */
  modulesPerRow: number;
  minModulesPerRow: number;
  maxModulesPerRow: number;
  /** Share of panels (0..1) on tables with the dominant configuration. */
  consistency: number;
  /** Table counts of the other configurations, keyed like "2P". */
  variants: Record<string, number>;
  /** Direction the tables run, degrees clockwise from north, 0–180 (same as installationBearing). */
  tableBearing: number;
  /**
   * Installation direction, 0–180 with one decimal: the course between the
   * centres of the end modules of the longest row. The opposite course
   * (+180) is the same line flown the other way.
   */
  installationBearing: number;
  /** String gap tolerance the tables were detected with, meters. */
  tableGapM: number;
  /** The row that direction was measured on. */
  installationRow: {
    modules: number;
    lengthM: number;
    /** [lon, lat] centre of the first and last module of that row. */
    start: [number, number];
    end: [number, number];
  };
}

/* ------------------------------------------------------------------ */
/* Barcode label position                                              */
/* ------------------------------------------------------------------ */

export type BarcodeSlot = 'top-left' | 'top-middle' | 'top-right' | 'bottom-left' | 'bottom-middle' | 'bottom-right';

/** In reading order, top row first: the order of the 3 × 2 picker. */
export const BARCODE_SLOTS: { id: BarcodeSlot; label: string }[] = [
  { id: 'top-left', label: 'Top left' },
  { id: 'top-middle', label: 'Top middle' },
  { id: 'top-right', label: 'Top right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'bottom-middle', label: 'Bottom middle' },
  { id: 'bottom-right', label: 'Bottom right' },
];

export type CompassSide = 'north' | 'east' | 'south' | 'west';

export const COMPASS_SIDE_LABELS: Record<CompassSide, string> = {
  north: 'North',
  east: 'East',
  south: 'South',
  west: 'West',
};

/** Unit vectors in the local east/north frame. */
const COMPASS_VECTORS: Record<CompassSide, [number, number]> = {
  north: [0, 1],
  east: [1, 0],
  south: [0, -1],
  west: [-1, 0],
};

/** The serial-number label: 10 cm along the module's short edge, 5 cm deep. */
export const BARCODE_LABEL_WIDTH_M = 0.1;
export const BARCODE_LABEL_DEPTH_M = 0.05;
/** A break along a row wider than this restarts the pattern when "Reset on gap" is on. */
export const BARCODE_GAP_RESET_M = 0.3;
/** Default distance from a module edge to the label. */
export const DEFAULT_LABEL_INSET_M = 0.02;

export interface BarcodeLabelSettings {
  /** Spot of the label on a module seen from above with its top edge up. */
  slot: BarcodeSlot;
  /** Compass side the module's top short edge faces. */
  topEdge: CompassSide;
  /** Rows are counted along the installation bearing ('forward') or its opposite. */
  countAlong: 'forward' | 'reverse';
  /** Every next module along a row is turned 180°. */
  upsideDown: boolean;
  /** After a break in a row the pattern starts again at `slot`. */
  resetOnGap: boolean;
  /** Distance from the top/bottom (short) edge to the label, meters. */
  insetFromEndM: number;
  /** Distance from the left/right (long) edge to the label, meters. */
  insetFromSideM: number;
  /** @deprecated One inset for both directions, stored by earlier versions; read through labelInsets(). */
  insetM?: number;
}

export interface LabelInsets {
  /** from the top/bottom (short) edge, meters */
  fromEndM: number;
  /** from the left/right (long) edge, meters */
  fromSideM: number;
}

/** Insets of stored settings; settings from before the split use their single value for both. */
export const labelInsets = (
  settings: Partial<Pick<BarcodeLabelSettings, 'insetFromEndM' | 'insetFromSideM' | 'insetM'>>
): LabelInsets => ({
  fromEndM: settings.insetFromEndM ?? settings.insetM ?? DEFAULT_LABEL_INSET_M,
  fromSideM: settings.insetFromSideM ?? settings.insetM ?? DEFAULT_LABEL_INSET_M,
});

/**
 * Offset of the label centre from the module centre, in metres along the
 * module's top direction and its left direction (a quarter turn
 * counter-clockwise from top, seen from above). A flipped module is the same
 * module turned 180°, which mirrors both offsets.
 */
export const slotOffset = (slot: BarcodeSlot, flipped: boolean, size: PanelSize, insets: LabelInsets) => {
  const vertical = slot.startsWith('top') ? 1 : -1;
  const horizontal = slot.endsWith('left') ? 1 : slot.endsWith('right') ? -1 : 0;
  const alongTop = vertical * Math.max(0, size.length / 2 - insets.fromEndM - BARCODE_LABEL_DEPTH_M / 2);
  const alongLeft = horizontal * Math.max(0, size.width / 2 - insets.fromSideM - BARCODE_LABEL_WIDTH_M / 2);
  return flipped ? { alongTopM: -alongTop, alongLeftM: -alongLeft } : { alongTopM: alongTop, alongLeftM: alongLeft };
};

/** Compass bearing (0–180) of the modules' long side. */
const moduleLongAxisBearing = (structure: PanelStructure) =>
  ((structure.orientation === 'portrait' ? structure.installationBearing + 90 : structure.installationBearing) % 180 + 180) % 180;

/** The two compass sides a module's short edges can face in this park. */
export const topEdgeOptions = (structure: PanelStructure): [CompassSide, CompassSide] => {
  const bearing = moduleLongAxisBearing(structure);
  return bearing <= 45 || bearing >= 135 ? ['north', 'south'] : ['east', 'west'];
};

/**
 * Fixed-tilt modules lean towards the equator, so their high (top) edge faces
 * away from it. East–west modules give no such hint; west is only a start.
 */
export const defaultTopEdge = (structure: PanelStructure, latitude: number): CompassSide => {
  const [first] = topEdgeOptions(structure);
  if (first === 'north') return latitude >= 0 ? 'north' : 'south';
  return 'west';
};

export const describeBarcodeLabel = (settings: BarcodeLabelSettings) =>
  [
    BARCODE_SLOTS.find((option) => option.id === settings.slot)?.label.toLowerCase() ?? settings.slot,
    `top edge faces ${COMPASS_SIDE_LABELS[settings.topEdge].toLowerCase()}`,
    settings.upsideDown ? 'alternating upside-down' : null,
    settings.upsideDown && settings.resetOnGap ? 'reset on gap' : null,
  ]
    .filter(Boolean)
    .join(', ');

export interface ParsedPanelLayout {
  panelCount: number;
  /** lon,lat of the 4 corners of every panel, comma separated: 8 numbers per panel. */
  corners: string;
  /** Placemark names (e.g. "#13341"), newline separated, in the same order as `corners`. */
  names: string;
  bounds: PanelBounds;
  /** Median module size — a quick check that the right file was picked. */
  panelSize: PanelSize;
  /** Polygons that were not panel-sized rectangles. */
  skipped: number;
  documentName: string | null;
  structure: PanelStructure | null;
}

/** What a Barcode Scan mission stores. */
export interface BarcodeScanData extends Omit<ParsedPanelLayout, 'skipped' | 'documentName' | 'structure'> {
  sourceFileName: string;
  style: PanelStyle;
  /** Missing on missions imported before table detection existed; filled in when opened. */
  structure?: PanelStructure | null;
  /** Where the serial-number label sits; unset until chosen in the Barcode position pop-up. */
  label?: BarcodeLabelSettings;
}

const PLACEMARK_PATTERN = /<Placemark\b[\s\S]*?<\/Placemark>/g;
const NAME_PATTERN = /<name>([\s\S]*?)<\/name>/;
const POLYGON_COORDINATES_PATTERN = /<Polygon\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/;
const DOCUMENT_NAME_PATTERN = /<Document\b[^>]*>\s*<name>([^<]*)<\/name>/;

const METERS_PER_DEGREE_LAT = 110574;
const METERS_PER_DEGREE_LON_AT_EQUATOR = 111320;
/** |cos| of a corner angle; 0.1 allows roughly ±6° from square. */
const MAX_CORNER_COSINE = 0.1;
/** Opposite sides may differ by this share of the longer one. */
const MAX_SIDE_MISMATCH = 0.1;
const MIN_SIDE_M = 0.2;
/** Longer than this is a table or an area, not a single module. */
const MAX_SIDE_M = 6;

/** ~1 mm; keeps the stored layout short. */
const roundDegrees = (value: number) => Math.round(value * 1e8) / 1e8;

type RectangleResult =
  | { corners: number[]; shortSide: number; longSide: number }
  | { reason: 'shape' | 'size' };

const readRectangle = (coordinatesText: string): RectangleResult => {
  const lonLat: number[] = [];
  for (const token of coordinatesText.trim().split(/\s+/)) {
    const [lon, lat] = token.split(',').map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { reason: 'shape' };
    lonLat.push(lon, lat);
  }

  let count = lonLat.length / 2;
  if (count === 5 && lonLat[0] === lonLat[8] && lonLat[1] === lonLat[9]) count = 4;
  if (count !== 4) return { reason: 'shape' };

  // Local metric frame at the first corner; flat-earth is exact enough over 2 m.
  const cosLat = Math.cos((lonLat[1] * Math.PI) / 180);
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < 4; i++) {
    x.push((lonLat[i * 2] - lonLat[0]) * METERS_PER_DEGREE_LON_AT_EQUATOR * cosLat);
    y.push((lonLat[i * 2 + 1] - lonLat[1]) * METERS_PER_DEGREE_LAT);
  }

  const ex: number[] = [];
  const ey: number[] = [];
  const length: number[] = [];
  for (let i = 0; i < 4; i++) {
    const next = (i + 1) % 4;
    ex.push(x[next] - x[i]);
    ey.push(y[next] - y[i]);
    length.push(Math.hypot(ex[i], ey[i]));
  }
  if (length.some((side) => side < MIN_SIDE_M)) return { reason: 'shape' };

  for (let i = 0; i < 4; i++) {
    const next = (i + 1) % 4;
    const cosine = (ex[i] * ex[next] + ey[i] * ey[next]) / (length[i] * length[next]);
    if (Math.abs(cosine) > MAX_CORNER_COSINE) return { reason: 'shape' };
  }
  if (
    Math.abs(length[0] - length[2]) > MAX_SIDE_MISMATCH * Math.max(length[0], length[2]) ||
    Math.abs(length[1] - length[3]) > MAX_SIDE_MISMATCH * Math.max(length[1], length[3])
  ) {
    return { reason: 'shape' };
  }

  const shortSide = Math.min(length[0], length[1]);
  const longSide = Math.max(length[0], length[1]);
  if (longSide > MAX_SIDE_M) return { reason: 'size' };

  return { corners: lonLat.slice(0, 8), shortSide, longSide };
};

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Largest gap, edge to edge, between the rows of one table (across its width).
 * Measured layouts have 20 cm there; kept tight so parallel strings never merge.
 */
const ROW_GAP_M = 0.3;

/** Upper limit for the string gap tolerance a user can enter. */
export const MAX_TABLE_GAP_M = 20;

export interface StructureOptions {
  /**
   * Largest gap, edge to edge, along a string that still counts as the same
   * table. Default: one module width.
   */
  tableGapM?: number;
}

interface TableShape {
  panels: number;
  perRow: number[];
}

/** The configuration holding the most panels. */
const dominantShape = (shapes: Map<string, TableShape>) => {
  let best: { key: string; shape: TableShape } | null = null;
  for (const [key, shape] of shapes) {
    if (!best || shape.panels > best.shape.panels) best = { key, shape };
  }
  return best;
};

export const structureCode = (structure: PanelStructure) =>
  `${structure.rows}${structure.orientation === 'portrait' ? 'P' : 'L'}`;

export const describeStructure = (structure: PanelStructure) =>
  `${structure.rows} ${structure.rows === 1 ? 'row' : 'rows'} ${structure.orientation} (${structureCode(structure)})`;

/** "96.8° – 276.8°": the installation line, both ways. */
export const formatInstallationDirection = (bearing: number) =>
  `${bearing.toFixed(1)}° – ${(bearing + 180).toFixed(1)}°`;

/** Initial great-circle course from point 1 to point 2, degrees clockwise from north. */
const courseDegrees = (lon1: number, lat1: number, lon2: number, lat2: number) => {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const deltaLambda = (lon2 - lon1) * toRad;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return ((Math.atan2(y, x) / toRad) + 360) % 360;
};

const countClusters = (sorted: Float64Array, minStep: number) => {
  let clusters = sorted.length > 0 ? 1 : 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > minStep) clusters++;
  }
  return clusters;
};

/** Most frequent value; ties go to the larger one. */
const mostCommon = (values: number[]) => {
  const counts = new Map<number, number>();
  let best = values[0];
  let bestCount = 0;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
};

/* ------------------------------------------------------------------ */
/* Module geometry and table grouping, shared by structure and barcodes */
/* ------------------------------------------------------------------ */

/** Per-module centre, long axis and side lengths in a local metric frame. */
interface ModuleGeometry {
  count: number;
  lon0: number;
  lat0: number;
  /** metres per degree of longitude / latitude at the frame origin */
  kx: number;
  ky: number;
  centerX: Float64Array;
  centerY: Float64Array;
  longAxisX: Float64Array;
  longAxisY: Float64Array;
  longSide: Float64Array;
  shortSide: Float64Array;
  maxLongSide: number;
  /** median short side */
  moduleWidthM: number;
}

const prepareModules = (corners: ArrayLike<number>): ModuleGeometry | null => {
  const count = Math.floor(corners.length / 8);
  if (count === 0) return null;

  // Local metric frame; flat-earth is exact enough across a solar park.
  const lon0 = corners[0];
  const lat0 = corners[1];
  const kx = METERS_PER_DEGREE_LON_AT_EQUATOR * Math.cos((lat0 * Math.PI) / 180);
  const ky = METERS_PER_DEGREE_LAT;

  const centerX = new Float64Array(count);
  const centerY = new Float64Array(count);
  const longAxisX = new Float64Array(count);
  const longAxisY = new Float64Array(count);
  const longSide = new Float64Array(count);
  const shortSide = new Float64Array(count);
  let maxLongSide = 0;

  for (let panel = 0; panel < count; panel++) {
    const o = panel * 8;
    const x0 = (corners[o] - lon0) * kx;
    const y0 = (corners[o + 1] - lat0) * ky;
    const x1 = (corners[o + 2] - lon0) * kx;
    const y1 = (corners[o + 3] - lat0) * ky;
    const x2 = (corners[o + 4] - lon0) * kx;
    const y2 = (corners[o + 5] - lat0) * ky;
    const x3 = (corners[o + 6] - lon0) * kx;
    const y3 = (corners[o + 7] - lat0) * ky;
    centerX[panel] = (x0 + x1 + x2 + x3) / 4;
    centerY[panel] = (y0 + y1 + y2 + y3) / 4;

    const edge0 = Math.hypot(x1 - x0, y1 - y0);
    const edge1 = Math.hypot(x2 - x1, y2 - y1);
    if (edge0 >= edge1) {
      longSide[panel] = edge0;
      shortSide[panel] = edge1;
      longAxisX[panel] = (x1 - x0) / edge0;
      longAxisY[panel] = (y1 - y0) / edge0;
    } else {
      longSide[panel] = edge1;
      shortSide[panel] = edge0;
      longAxisX[panel] = (x2 - x1) / edge1;
      longAxisY[panel] = (y2 - y1) / edge1;
    }
    if (longSide[panel] > maxLongSide) maxLongSide = longSide[panel];
  }

  const sortedShortSides = Float64Array.from(shortSide).sort();

  return {
    count,
    lon0,
    lat0,
    kx,
    ky,
    centerX,
    centerY,
    longAxisX,
    longAxisY,
    longSide,
    shortSide,
    maxLongSide,
    moduleWidthM: sortedShortSides[Math.floor(count / 2)],
  };
};

const resolveTableGap = (modules: ModuleGeometry, tableGapM: number | undefined) =>
  Math.round(Math.min(MAX_TABLE_GAP_M, Math.max(0, tableGapM ?? modules.moduleWidthM)) * 100) / 100;

/**
 * Join neighbouring modules into tables. `gapBesideM` is the allowed gap
 * between modules whose long edges face each other, `gapEndToEndM` between
 * modules whose short edges face each other.
 */
const groupTables = (modules: ModuleGeometry, gapBesideM: number, gapEndToEndM: number) => {
  const { count, centerX, centerY, longAxisX, longAxisY, longSide, shortSide } = modules;

  // Neighbour search on a grid one module plus the widest allowed gap wide.
  const cellSize = modules.maxLongSide + Math.max(gapBesideM, gapEndToEndM);
  const cellKey = (gx: number, gy: number) => (gx + 1e6) * 4e6 + (gy + 1e6);
  const cellX = new Int32Array(count);
  const cellY = new Int32Array(count);
  const buckets = new Map<number, number[]>();
  for (let panel = 0; panel < count; panel++) {
    cellX[panel] = Math.floor(centerX[panel] / cellSize);
    cellY[panel] = Math.floor(centerY[panel] / cellSize);
    const key = cellKey(cellX[panel], cellY[panel]);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(panel);
    else buckets.set(key, [panel]);
  }

  const parent = new Int32Array(count);
  for (let panel = 0; panel < count; panel++) parent[panel] = panel;
  const find = (panel: number) => {
    let root = panel;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]];
      root = parent[root];
    }
    return root;
  };

  for (let i = 0; i < count; i++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = buckets.get(cellKey(cellX[i] + dx, cellY[i] + dy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const offsetX = centerX[j] - centerX[i];
          const offsetY = centerY[j] - centerY[i];
          const alongLong = Math.abs(offsetX * longAxisX[i] + offsetY * longAxisY[i]);
          const alongShort = Math.abs(-offsetX * longAxisY[i] + offsetY * longAxisX[i]);
          const beside =
            alongLong < 0.3 * longSide[i] && alongShort > 0.5 * shortSide[i] && alongShort < shortSide[i] + gapBesideM;
          const endToEnd =
            alongShort < 0.3 * shortSide[i] && alongLong > 0.5 * longSide[i] && alongLong < longSide[i] + gapEndToEndM;
          if (beside || endToEnd) {
            const a = find(i);
            const b = find(j);
            if (a !== b) parent[a] = b;
          }
        }
      }
    }
  }

  const tables = new Map<number, number[]>();
  for (let panel = 0; panel < count; panel++) {
    const root = find(panel);
    const members = tables.get(root);
    if (members) members.push(panel);
    else tables.set(root, [panel]);
  }
  return tables;
};

/** Rows and orientation of every table, collected per configuration. */
const readShapes = (modules: ModuleGeometry, tables: Map<number, number[]>) => {
  const { centerX, centerY, longAxisX, longAxisY, longSide, shortSide } = modules;
  const shapes = new Map<string, TableShape>();
  let longestTable: number[] = [];
  let longestTablePortrait = true;

  for (const members of tables.values()) {
    const first = members[0];
    const ax = longAxisX[first];
    const ay = longAxisY[first];
    const alongLong = new Float64Array(members.length);
    const alongShort = new Float64Array(members.length);
    members.forEach((panel, k) => {
      alongLong[k] = centerX[panel] * ax + centerY[panel] * ay;
      alongShort[k] = -centerX[panel] * ay + centerY[panel] * ax;
    });
    alongLong.sort();
    alongShort.sort();

    const stackedOnLongSide = countClusters(alongLong, 0.5 * longSide[first]);
    const stackedOnShortSide = countClusters(alongShort, 0.5 * shortSide[first]);
    // The table runs where more modules line up.
    const portrait = stackedOnShortSide >= stackedOnLongSide;
    const rows = portrait ? stackedOnLongSide : stackedOnShortSide;
    const key = `${rows}${portrait ? 'P' : 'L'}`;

    let shape = shapes.get(key);
    if (!shape) {
      shape = { panels: 0, perRow: [] };
      shapes.set(key, shape);
    }
    shape.panels += members.length;
    shape.perRow.push(Math.round(members.length / rows));

    if (members.length > longestTable.length) {
      longestTable = members;
      longestTablePortrait = portrait;
    }
  }

  return { shapes, longestTable, longestTablePortrait };
};

/**
 * A string may have short breaks (a post, a cable crossing) and still be one
 * table, so grouping runs twice: first with tight gaps to learn which way the
 * tables run, then allowing `tableGapM` along that direction only. Across the
 * table the tight row gap stays, so neighbouring strings are never joined.
 */
const detectTables = (modules: ModuleGeometry, tableGapM: number) => {
  let tables = groupTables(modules, ROW_GAP_M, ROW_GAP_M);
  let reading = readShapes(modules, tables);

  if (tableGapM > ROW_GAP_M) {
    const portrait = dominantShape(reading.shapes)?.key.endsWith('P') ?? true;
    // Portrait tables run along the modules' short side, so their string gaps face long edges.
    tables = portrait ? groupTables(modules, tableGapM, ROW_GAP_M) : groupTables(modules, ROW_GAP_M, tableGapM);
    reading = readShapes(modules, tables);
  }

  return { tables, reading };
};

/**
 * Group modules into tables and read each table's shape: how many modules
 * stand across it and along it. The configuration holding the most panels
 * describes the park; the rest are listed as variants.
 */
export const analysePanelStructure = (
  corners: ArrayLike<number>,
  options: StructureOptions = {}
): PanelStructure | null => {
  const modules = prepareModules(corners);
  if (!modules) return null;
  const { count, centerX, centerY, longAxisX, longAxisY, longSide, shortSide } = modules;

  const tableGapM = resolveTableGap(modules, options.tableGapM);
  const { tables, reading } = detectTables(modules, tableGapM);

  const { shapes, longestTable, longestTablePortrait } = reading;
  const dominantEntry = dominantShape(shapes);
  if (!dominantEntry) return null;
  const { key: dominantKey, shape: dominant } = dominantEntry;

  const variants: Record<string, number> = {};
  for (const [key, shape] of shapes) {
    if (key !== dominantKey) variants[key] = shape.perRow.length;
  }

  // Installation direction: course between the centres of the two end modules
  // of the longest row. Measured over the whole row it is far steadier than
  // the edge of a single module.
  const reference = longestTable[0];
  const referenceAxisX = longAxisX[reference];
  const referenceAxisY = longAxisY[reference];
  // Portrait tables run along the modules' short side, landscape along the long side.
  const lengthX = longestTablePortrait ? -referenceAxisY : referenceAxisX;
  const lengthY = longestTablePortrait ? referenceAxisX : referenceAxisY;
  const moduleAcross = longestTablePortrait ? longSide[reference] : shortSide[reference];

  const byAcross = longestTable
    .map((panel) => ({
      panel,
      across: -centerX[panel] * lengthY + centerY[panel] * lengthX,
      along: centerX[panel] * lengthX + centerY[panel] * lengthY,
    }))
    .sort((a, b) => a.across - b.across);

  let longestRow: typeof byAcross = [];
  let currentRow: typeof byAcross = [];
  byAcross.forEach((item, k) => {
    if (k > 0 && item.across - byAcross[k - 1].across > 0.5 * moduleAcross) {
      if (currentRow.length > longestRow.length) longestRow = currentRow;
      currentRow = [];
    }
    currentRow.push(item);
  });
  if (currentRow.length > longestRow.length) longestRow = currentRow;

  let rowStart = longestRow[0];
  let rowEnd = longestRow[0];
  for (const item of longestRow) {
    if (item.along < rowStart.along) rowStart = item;
    if (item.along > rowEnd.along) rowEnd = item;
  }

  const centreDegrees = (panel: number): [number, number] => {
    const o = panel * 8;
    return [
      (corners[o] + corners[o + 2] + corners[o + 4] + corners[o + 6]) / 4,
      (corners[o + 1] + corners[o + 3] + corners[o + 5] + corners[o + 7]) / 4,
    ];
  };

  let course: number;
  if (longestRow.length >= 2) {
    const [lon1, lat1] = centreDegrees(rowStart.panel);
    const [lon2, lat2] = centreDegrees(rowEnd.panel);
    course = courseDegrees(lon1, lat1, lon2, lat2);
  } else {
    // A table of one module has no row to measure; its own axis is all there is.
    course = ((Math.atan2(lengthX, lengthY) * 180) / Math.PI + 360) % 360;
  }
  let installationBearing = Math.round((course % 180) * 10) / 10;
  if (installationBearing >= 180) installationBearing -= 180;
  const rowLengthM = Math.hypot(
    centerX[rowEnd.panel] - centerX[rowStart.panel],
    centerY[rowEnd.panel] - centerY[rowStart.panel]
  );

  return {
    rows: parseInt(dominantKey, 10),
    orientation: dominantKey.endsWith('P') ? 'portrait' : 'landscape',
    tableCount: tables.size,
    modulesPerRow: mostCommon(dominant.perRow),
    minModulesPerRow: dominant.perRow.reduce((min, value) => Math.min(min, value), Infinity),
    maxModulesPerRow: dominant.perRow.reduce((max, value) => Math.max(max, value), 0),
    consistency: dominant.panels / count,
    variants,
    tableBearing: installationBearing,
    installationBearing,
    tableGapM,
    installationRow: {
      modules: longestRow.length,
      lengthM: Math.round(rowLengthM * 10) / 10,
      start: centreDegrees(rowStart.panel).map(roundDegrees) as [number, number],
      end: centreDegrees(rowEnd.panel).map(roundDegrees) as [number, number],
    },
  };
};

export interface BarcodePointOptions {
  /** Tolerance the tables were detected with, so rows match the structure shown. */
  tableGapM: number;
  installationBearing: number;
  settings: BarcodeLabelSettings;
}

/**
 * Barcode label position of every panel as lon,lat pairs (NaN if unknown),
 * indexed like the panels.
 *
 * Each row of every table is walked along the chosen course. The first module
 * keeps the chosen spot; with upside-down installation every next module is
 * turned 180°, and with reset on gap a break wider than BARCODE_GAP_RESET_M
 * starts the pattern again. Tables always start fresh.
 */
export const computeBarcodePoints = (
  corners: ArrayLike<number>,
  { tableGapM, installationBearing, settings }: BarcodePointOptions
): Float64Array => {
  const count = Math.floor(corners.length / 8);
  const points = new Float64Array(count * 2).fill(Number.NaN);
  const modules = prepareModules(corners);
  if (!modules) return points;

  const { centerX, centerY, longAxisX, longAxisY, longSide, shortSide } = modules;
  const { tables } = detectTables(modules, resolveTableGap(modules, tableGapM));

  const courseRad =
    (((settings.countAlong === 'forward' ? installationBearing : installationBearing + 180) % 360) * Math.PI) / 180;
  const dirX = Math.sin(courseRad);
  const dirY = Math.cos(courseRad);
  const [compassX, compassY] = COMPASS_VECTORS[settings.topEdge];
  const insets = labelInsets(settings);

  for (const members of tables.values()) {
    const first = members[0];
    // Share of the module's long side that lies along the counting direction.
    const longAlong = Math.abs(longAxisX[first] * dirX + longAxisY[first] * dirY);
    const moduleAlong = longAlong * longSide[first] + (1 - longAlong) * shortSide[first];
    const moduleAcross = (1 - longAlong) * longSide[first] + longAlong * shortSide[first];

    const items = members
      .map((panel) => ({
        panel,
        along: centerX[panel] * dirX + centerY[panel] * dirY,
        across: -centerX[panel] * dirY + centerY[panel] * dirX,
      }))
      .sort((a, b) => a.across - b.across);

    // Rows of the table, split across the counting direction.
    const rows: (typeof items)[] = [];
    let row: typeof items = [];
    items.forEach((item, k) => {
      if (k > 0 && item.across - items[k - 1].across > 0.5 * moduleAcross) {
        rows.push(row);
        row = [];
      }
      row.push(item);
    });
    if (row.length > 0) rows.push(row);

    for (const rowItems of rows) {
      rowItems.sort((a, b) => a.along - b.along);
      let sequence = 0;

      rowItems.forEach((item, k) => {
        if (k > 0) {
          const gap = item.along - rowItems[k - 1].along - moduleAlong;
          sequence = settings.resetOnGap && gap > BARCODE_GAP_RESET_M ? 0 : sequence + 1;
        }
        const flipped = settings.upsideDown && sequence % 2 === 1;

        const panel = item.panel;
        // Top is the end of the long axis that points towards the chosen compass side.
        const sign = longAxisX[panel] * compassX + longAxisY[panel] * compassY >= 0 ? 1 : -1;
        const topX = longAxisX[panel] * sign;
        const topY = longAxisY[panel] * sign;
        const leftX = -topY;
        const leftY = topX;
        const offset = slotOffset(
          settings.slot,
          flipped,
          { width: shortSide[panel], length: longSide[panel] },
          insets
        );

        const x = centerX[panel] + topX * offset.alongTopM + leftX * offset.alongLeftM;
        const y = centerY[panel] + topY * offset.alongTopM + leftY * offset.alongLeftM;
        points[panel * 2] = modules.lon0 + x / modules.kx;
        points[panel * 2 + 1] = modules.lat0 + y / modules.ky;
      });
    }
  }

  return points;
};

/**
 * Read a panel layout. Throws a message meant for the user when the file is not
 * one: no polygons, or polygons that are not panel-sized rectangles.
 */
export const parsePanelLayout = (kmlText: string): ParsedPanelLayout => {
  if (!/<kml\b/i.test(kmlText.slice(0, 4000))) {
    throw new Error('This is not a KML file.');
  }

  const cornerValues: number[] = [];
  const names: string[] = [];
  const shortSides: number[] = [];
  const longSides: number[] = [];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let polygons = 0;
  let notRectangular = 0;
  let tooLarge = 0;

  for (const placemark of kmlText.matchAll(PLACEMARK_PATTERN)) {
    const block = placemark[0];
    const geometry = POLYGON_COORDINATES_PATTERN.exec(block);
    if (!geometry) continue;
    polygons++;

    const rectangle = readRectangle(geometry[1]);
    if ('reason' in rectangle) {
      if (rectangle.reason === 'size') tooLarge++;
      else notRectangular++;
      continue;
    }

    for (let i = 0; i < 8; i += 2) {
      const lon = rectangle.corners[i];
      const lat = rectangle.corners[i + 1];
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      cornerValues.push(roundDegrees(lon), roundDegrees(lat));
    }
    shortSides.push(rectangle.shortSide);
    longSides.push(rectangle.longSide);

    const name = NAME_PATTERN.exec(block)?.[1].replace(/\s+/g, ' ').trim();
    names.push(name || `#${names.length + 1}`);
  }

  const panelCount = names.length;
  if (polygons === 0) {
    throw new Error('No polygons found. A Barcode Scan KML has one rectangle polygon per solar panel.');
  }
  if (panelCount === 0) {
    throw new Error(
      tooLarge >= notRectangular
        ? `The ${polygons.toLocaleString()} polygon(s) are larger than a solar panel (over ${MAX_SIDE_M} m). This looks like an area KML, not a panel layout.`
        : `None of the ${polygons.toLocaleString()} polygon(s) is a rectangle. A Barcode Scan KML has one rectangle per solar panel.`
    );
  }
  if (panelCount < polygons / 2) {
    throw new Error(
      `Only ${panelCount.toLocaleString()} of ${polygons.toLocaleString()} polygons are panel-sized rectangles — this does not look like a panel layout.`
    );
  }

  return {
    panelCount,
    corners: cornerValues.join(','),
    names: names.join('\n'),
    bounds: { west, south, east, north },
    panelSize: { width: median(shortSides), length: median(longSides) },
    skipped: notRectangular + tooLarge,
    structure: analysePanelStructure(cornerValues),
    documentName: DOCUMENT_NAME_PATTERN.exec(kmlText.slice(0, 4000))?.[1].trim() || null,
  };
};

export const importPanelLayoutFile = async (file: File): Promise<ParsedPanelLayout> => {
  const fileName = file.name.toLowerCase();
  let text: string;

  if (fileName.endsWith('.kmz')) {
    const zip = await JSZip.loadAsync(file);
    const entry = zip.file('doc.kml') ?? zip.file(/\.kml$/i)[0];
    if (!entry) throw new Error('No KML file found inside the KMZ.');
    text = await entry.async('text');
  } else if (fileName.endsWith('.kml')) {
    text = await file.text();
  } else {
    throw new Error('Choose a .kml or .kmz file.');
  }

  return parsePanelLayout(text);
};

/** The stored corner string as numbers: 8 per panel (lon,lat × 4). */
export const decodePanelCorners = (corners: string): Float64Array => {
  if (!corners) return new Float64Array(0);
  const parts = corners.split(',');
  const values = new Float64Array(parts.length);
  for (let i = 0; i < parts.length; i++) values[i] = Number(parts[i]);
  return values;
};

export const describePanelSize = (size: PanelSize) =>
  `${size.width.toFixed(2)} × ${size.length.toFixed(2)} m`;

export const describePanelLayout = (layout: ParsedPanelLayout) => {
  const parts = [`${layout.panelCount.toLocaleString()} panels`, `module ${describePanelSize(layout.panelSize)}`];
  if (layout.structure) {
    parts.push(`${layout.structure.tableCount.toLocaleString()} tables, ${describeStructure(layout.structure)}`);
  }
  if (layout.skipped > 0) parts.push(`${layout.skipped.toLocaleString()} other shapes skipped`);
  return parts.join(' · ');
};
