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
  /** Table numbers written at the table centres on the map. */
  tableNamesEnabled: boolean;
  /**
   * Draw the strings in their own two colours instead of the outline colour:
   * one for every string, and one for the strings marked by hand. Marking is
   * free to mean anything on site — a cable run, a group already checked —
   * and says nothing about the barcode orientation.
   */
  stringColorsEnabled: boolean;
  /** Colour of the strings, unless marked. */
  stringColor: string;
  /** Colour of the strings marked by hand ("Change colour to red"). */
  markedStringColor: string;
}

/** String colours drawn instead of the outline colour: all strings, and the marked ones. */
export const STRING_COLOR = '#7bf59b';
export const MARKED_STRING_COLOR = '#ff3b30';

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
  tableNamesEnabled: false,
  stringColorsEnabled: true,
  stringColor: STRING_COLOR,
  markedStringColor: MARKED_STRING_COLOR,
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
  /** Distance from the top/bottom (short) edge to the label, meters. */
  insetFromEndM: number;
  /** Distance from the left/right (long) edge to the label, meters. */
  insetFromSideM: number;
  /** @deprecated One inset for both directions, stored by earlier versions; read through labelInsets(). */
  insetM?: number;
  /**
   * 4 Corner Mode: a point at every module corner instead of one label spot,
   * for sites where the labels do not follow a readable pattern. Corners of
   * modules that touch become one point on their shared border.
   */
  fourCorners?: boolean;
  /** Modules with an edge-to-edge gap up to this share their corner points, meters. */
  nextPanelGapM?: number;
  /**
   * Extra inset for points on a module edge with no neighbour — the ends of a
   * string and the outer sides — so they do not sit on the very rim, meters.
   */
  cornerInsetM?: number;
  /**
   * Manual position, a setting of 4 Corner Mode: fly only every so many of the
   * scan points of a line, for remote controllers that cannot hold a route
   * with thousands of waypoints. The route is planned exactly as it otherwise
   * would be, heights and all, and points are left out of it afterwards. The
   * first and the last point of every line stay, and every line gains a
   * lead-in and a lead-out point one module beyond its ends.
   */
  manualPosition?: boolean;
  /** Scan points passed over between two flown ones, in Manual position. */
  skipPanels?: number;
}

/** Points one panel can carry: one label spot, or its four corners. */
export const BARCODE_POINT_SLOTS = 4;
const BARCODE_POINT_STRIDE = BARCODE_POINT_SLOTS * 2;

/** Default edge-to-edge gap up to which two modules count as touching. */
export const DEFAULT_NEXT_PANEL_GAP_M = 0.15;
/** Default extra inset of the points on a free module edge (4 Corner Mode). */
export const DEFAULT_CORNER_INSET_M = 0.2;
/** Default number of scan points passed over between two flown ones. */
export const DEFAULT_SKIP_PANELS = 1;
export const MAX_SKIP_PANELS = 99;

/** Scan points passed over between two flown ones, as a whole number in range. */
export const skipPanelsOf = (settings: Pick<BarcodeLabelSettings, 'skipPanels'>): number =>
  Math.min(MAX_SKIP_PANELS, Math.max(0, Math.round(settings.skipPanels ?? DEFAULT_SKIP_PANELS)));

/**
 * Whether the point at this place in a barcode line is flown. The first and
 * the last one always are: they are the ends of the line, however the count
 * comes out.
 */
export const isFlownInLine = (index: number, lineLength: number, skip: number): boolean =>
  index === 0 || index === lineLength - 1 || index % (skip + 1) === 0;
export const MAX_NEXT_PANEL_GAP_M = 5;

/** Every point of one panel: up to BARCODE_POINT_SLOTS, unused slots are NaN. */
export const forEachBarcodePoint = (
  points: Float64Array,
  panel: number,
  visit: (lon: number, lat: number, slot: number) => void
): void => {
  for (let slot = 0; slot < BARCODE_POINT_SLOTS; slot++) {
    const offset = panel * BARCODE_POINT_STRIDE + slot * 2;
    const lon = points[offset];
    const lat = points[offset + 1];
    if (Number.isFinite(lon) && Number.isFinite(lat)) visit(lon, lat, slot);
  }
};

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

export const describeBarcodeLabel = (settings: BarcodeLabelSettings): string =>
  settings.fourCorners
    ? `4 corner mode, shared borders merged up to ${Math.round(
        (settings.nextPanelGapM ?? DEFAULT_NEXT_PANEL_GAP_M) * 100
      )} cm, outer points ${Math.round((settings.cornerInsetM ?? DEFAULT_CORNER_INSET_M) * 100)} cm further in${
        settings.manualPosition
          ? `, manual position, ${
              skipPanelsOf(settings) === 0 ? 'every point flown' : `1 of every ${skipPanelsOf(settings) + 1} points flown`
            }`
          : ''
      }`
    : [
    BARCODE_SLOTS.find((option) => option.id === settings.slot)?.label.toLowerCase() ?? settings.slot,
    `top edge faces ${COMPASS_SIDE_LABELS[settings.topEdge].toLowerCase()}`,
    settings.upsideDown ? 'alternating upside-down' : null,
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

/** Default safe jump height for barcode scan flights, meters. */
export const DEFAULT_SAFE_JUMP_M = 2;
/** Default scan altitude for barcode scan flights, meters (a decimal value). */
export const DEFAULT_SCAN_ALTITUDE_M = 0.8;
/** Default flight speed for barcode scan flights, m/s (a decimal value). */
export const DEFAULT_SCAN_SPEED_MPS = 1;
/** Default speed away from the panels: to the first barcode, and between runs. */
export const DEFAULT_SCAN_TRANSIT_SPEED_MPS = 5;
/** Default hover time at a barcode point, seconds (a decimal value). */
export const DEFAULT_SCAN_HOVER_SECONDS = 1;

/**
 * Scan flight settings of a Barcode Scan mission. Every field is optional:
 * a setting that was never changed uses its DEFAULT_* value.
 */
export interface BarcodeScanSettings {
  /** Safe jump height, meters. */
  safeJumpM?: number;
  /** Scan altitude, meters. */
  scanAltitudeM?: number;
  /** Flight speed, m/s. */
  flightSpeedMps?: number;
  /**
   * Which heading the aircraft holds: along the panel rows in the installation
   * direction, the opposite course, or the angle typed in `droneYawDeg`.
   */
  droneYawMode?: DroneYawMode;
  /** Aircraft heading when the mode is `manual`, degrees clockwise from north. */
  droneYawDeg?: number;
  /** Speed of the legs that are not scanning, m/s. */
  transitSpeedMps?: number;
  /** Take a photo with the wide camera at every barcode point. */
  takePhotoEnabled?: boolean;
  /** Hover at every barcode point before the photo. */
  hoverEnabled?: boolean;
  /** Hover time at a barcode point, seconds. */
  hoverSeconds?: number;
  /**
   * Leave the takeoff point out of the route, so the first waypoint is the
   * first barcode. The takeoff point is still needed — every height is
   * measured from its ground — it is simply not flown to. The aircraft climbs
   * to the safe takeoff height and heads for the first barcode from there.
   */
  excludeTakeoffPoint?: boolean;
  /** Table numbers to scan, in flight order (the order they were picked). */
  tables?: number[];
  /**
   * Tables mounted the other way round: every module of these is turned 180°,
   * so their labels sit at the opposite corner. Sub-strings are often joined
   * into one string on site, and only the eye can tell which way they run.
   */
  flippedTables?: number[];
  /** Tables marked by hand, drawn in the marked colour. Meaning is up to the user. */
  markedTables?: number[];
  /** Corner of every table where its scan starts, as seen on a north-up map. */
  startCorner?: ScanStartCorner;
  /** Inputs the stored route was generated from, to tell when it is out of date. */
  routeKey?: string;
}

/** `forward` = the installation direction, `reverse` = the opposite course. */
export type DroneYawMode = 'forward' | 'reverse' | 'manual';

export const DEFAULT_DRONE_YAW_MODE: DroneYawMode = 'forward';

export type ScanStartCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const SCAN_START_CORNERS: { id: ScanStartCorner; label: string }[] = [
  { id: 'top-left', label: 'Top left' },
  { id: 'top-right', label: 'Top right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'bottom-right', label: 'Bottom right' },
];

export const DEFAULT_SCAN_START_CORNER: ScanStartCorner = 'bottom-left';

/** What a Barcode Scan mission stores. */
export interface BarcodeScanData extends Omit<ParsedPanelLayout, 'skipped' | 'documentName' | 'structure'> {
  sourceFileName: string;
  style: PanelStyle;
  /** Missing on missions imported before table detection existed; filled in when opened. */
  structure?: PanelStructure | null;
  /** Where the serial-number label sits; unset until chosen in the Barcode position pop-up. */
  label?: BarcodeLabelSettings;
  /** Scan flight settings; unset until one is changed, defaults apply meanwhile. */
  scan?: BarcodeScanSettings;
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

/**
 * Every pair of modules that touch, i.e. whose edges are at most `gapM` apart.
 * Same neighbour test as groupTables, but the pairs themselves are needed to
 * merge the corner points they share.
 */
const forEachAdjacentPair = (
  modules: ModuleGeometry,
  gapM: number,
  visit: (a: number, b: number) => void
) => {
  const { count, centerX, centerY, longAxisX, longAxisY, longSide, shortSide } = modules;
  const cellSize = modules.maxLongSide + gapM;
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
            alongLong < 0.3 * longSide[i] && alongShort > 0.5 * shortSide[i] && alongShort < shortSide[i] + gapM;
          const endToEnd =
            alongShort < 0.3 * shortSide[i] && alongLong > 0.5 * longSide[i] && alongLong < longSide[i] + gapM;
          if (beside || endToEnd) visit(i, j);
        }
      }
    }
  }
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
  /** Table number of every panel, from numberTables; needed for flipped tables. */
  tableOfPanel?: Int32Array;
  /** Tables turned the other way round. */
  flippedTables?: Iterable<number>;
}

/**
 * Barcode positions of every panel: BARCODE_POINT_SLOTS lon,lat pairs per
 * panel (NaN where a slot is unused), indexed like the panels. Normally only
 * the first slot is used; 4 Corner Mode fills the corners it keeps.
 * Read it through forEachBarcodePoint.
 *
 * Each row of every table is walked along the chosen course. The first module
 * keeps the chosen spot; with upside-down installation every next module is
 * turned 180°, and with reset on gap a break wider than BARCODE_GAP_RESET_M
 * starts the pattern again. Tables always start fresh.
 */
/**
 * 4 Corner Mode: a point at each of a module's four corners, with the corners
 * of touching modules merged into one point on their shared border.
 *
 * Two modules side by side already carry their labels on the same joint, so a
 * point per module there would sit centimetres from its twin. A corner only
 * stays on its own where the module has no neighbour — the end of a string,
 * or a module standing alone.
 */
const writeCornerPoints = (
  modules: ModuleGeometry,
  points: Float64Array,
  settings: BarcodeLabelSettings
): void => {
  const { count, centerX, centerY, longAxisX, longAxisY, longSide, shortSide } = modules;
  const insets = labelInsets(settings);
  const gapM = Math.min(MAX_NEXT_PANEL_GAP_M, Math.max(0, settings.nextPanelGapM ?? DEFAULT_NEXT_PANEL_GAP_M));
  const cornerInsetM = Math.max(0, settings.cornerInsetM ?? DEFAULT_CORNER_INSET_M);

  /**
   * Which of a module's four sides have a neighbour: top and bottom are the
   * ends of its long axis, left and right the ends of its short axis. A side
   * without one is an outer edge of the array, where the point is pulled in
   * by the corner inset.
   */
  const occupied = new Uint8Array(count * 4); // 0 top, 1 bottom, 2 left, 3 right
  const markSide = (panel: number, offsetX: number, offsetY: number) => {
    const towardsTop = offsetX * longAxisX[panel] + offsetY * longAxisY[panel];
    const towardsLeft = -offsetX * longAxisY[panel] + offsetY * longAxisX[panel];
    if (Math.abs(towardsTop) >= Math.abs(towardsLeft)) occupied[panel * 4 + (towardsTop > 0 ? 0 : 1)] = 1;
    else occupied[panel * 4 + (towardsLeft > 0 ? 2 : 3)] = 1;
  };
  forEachAdjacentPair(modules, gapM, (a, b) => {
    markSide(a, centerX[b] - centerX[a], centerY[b] - centerY[a]);
    markSide(b, centerX[a] - centerX[b], centerY[a] - centerY[b]);
  });

  // The four corner points of every module, in the local metric frame.
  const cornerX = new Float64Array(count * BARCODE_POINT_SLOTS);
  const cornerY = new Float64Array(count * BARCODE_POINT_SLOTS);
  for (let panel = 0; panel < count; panel++) {
    const topX = longAxisX[panel];
    const topY = longAxisY[panel];
    const leftX = -topY;
    const leftY = topX;
    const alongTop = Math.max(0, longSide[panel] / 2 - insets.fromEndM - BARCODE_LABEL_DEPTH_M / 2);
    const alongLeft = Math.max(0, shortSide[panel] / 2 - insets.fromSideM - BARCODE_LABEL_WIDTH_M / 2);
    const signs: [number, number][] = [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    signs.forEach(([top, left], slot) => {
      // A free side pulls its points further in; a shared one keeps the joint.
      const freeTop = occupied[panel * 4 + (top > 0 ? 0 : 1)] === 0;
      const freeLeft = occupied[panel * 4 + (left > 0 ? 2 : 3)] === 0;
      const reachTop = Math.max(0, alongTop - (freeTop ? cornerInsetM : 0));
      const reachLeft = Math.max(0, alongLeft - (freeLeft ? cornerInsetM : 0));
      const index = panel * BARCODE_POINT_SLOTS + slot;
      cornerX[index] = centerX[panel] + topX * reachTop * top + leftX * reachLeft * left;
      cornerY[index] = centerY[panel] + topY * reachTop * top + leftY * reachLeft * left;
    });
  }

  // Corners of touching modules that face each other become one point.
  const parent = new Int32Array(count * BARCODE_POINT_SLOTS);
  for (let index = 0; index < parent.length; index++) parent[index] = index;
  const find = (index: number) => {
    let root = index;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]];
      root = parent[root];
    }
    return root;
  };

  const distanceSquared = (a: number, b: number) =>
    (cornerX[a] - cornerX[b]) ** 2 + (cornerY[a] - cornerY[b]) ** 2;
  const nearestCorner = (from: number, panel: number) => {
    let best = panel * BARCODE_POINT_SLOTS;
    let bestDistance = Infinity;
    for (let slot = 0; slot < BARCODE_POINT_SLOTS; slot++) {
      const candidate = panel * BARCODE_POINT_SLOTS + slot;
      const distance = distanceSquared(from, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return { index: best, distance: bestDistance };
  };

  forEachAdjacentPair(modules, gapM, (a, b) => {
    // Far enough for a facing pair across a joint, short of the distance
    // between two corners of the same module.
    const limit = (0.5 * (longSide[a] + shortSide[a])) ** 2;
    for (let slot = 0; slot < BARCODE_POINT_SLOTS; slot++) {
      const corner = a * BARCODE_POINT_SLOTS + slot;
      const towards = nearestCorner(corner, b);
      if (towards.distance > limit) continue;
      // Only a mutually nearest pair faces across the joint.
      if (nearestCorner(towards.index, a).index !== corner) continue;
      const rootA = find(corner);
      const rootB = find(towards.index);
      if (rootA !== rootB) parent[rootA] = rootB;
    }
  });

  // One point per group, at the middle of the corners it stands for.
  const sumX = new Float64Array(parent.length);
  const sumY = new Float64Array(parent.length);
  const members = new Int32Array(parent.length);
  for (let index = 0; index < parent.length; index++) {
    const root = find(index);
    sumX[root] += cornerX[index];
    sumY[root] += cornerY[index];
    members[root]++;
  }

  for (let root = 0; root < parent.length; root++) {
    if (members[root] === 0) continue;
    const panel = Math.floor(root / BARCODE_POINT_SLOTS);
    const slot = root % BARCODE_POINT_SLOTS;
    const offset = panel * BARCODE_POINT_STRIDE + slot * 2;
    points[offset] = modules.lon0 + sumX[root] / members[root] / modules.kx;
    points[offset + 1] = modules.lat0 + sumY[root] / members[root] / modules.ky;
  }
};

export const computeBarcodePoints = (
  corners: ArrayLike<number>,
  { tableGapM, installationBearing, settings, tableOfPanel, flippedTables }: BarcodePointOptions
): Float64Array => {
  const count = Math.floor(corners.length / 8);
  const points = new Float64Array(count * BARCODE_POINT_STRIDE).fill(Number.NaN);
  const modules = prepareModules(corners);
  if (!modules) return points;

  if (settings.fourCorners) {
    writeCornerPoints(modules, points, settings);
    return points;
  }

  const { centerX, centerY, longAxisX, longAxisY, longSide, shortSide } = modules;
  const { tables } = detectTables(modules, resolveTableGap(modules, tableGapM));

  const courseRad =
    (((settings.countAlong === 'forward' ? installationBearing : installationBearing + 180) % 360) * Math.PI) / 180;
  const dirX = Math.sin(courseRad);
  const dirY = Math.cos(courseRad);
  const [compassX, compassY] = COMPASS_VECTORS[settings.topEdge];
  const insets = labelInsets(settings);
  const flipped = new Set(flippedTables ?? []);
  const isFlippedPanel = (panel: number) => !!tableOfPanel && flipped.has(tableOfPanel[panel]);

  for (const members of tables.values()) {
    const first = members[0];
    // Share of the module's long side that lies along the counting direction.
    const longAlong = Math.abs(longAxisX[first] * dirX + longAxisY[first] * dirY);
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
        if (k > 0) sequence += 1;
        const panel = item.panel;
        // A table mounted the other way round turns every one of its modules.
        const turned = (settings.upsideDown && sequence % 2 === 1) !== isFlippedPanel(panel);
        // Top is the end of the long axis that points towards the chosen compass side.
        const sign = longAxisX[panel] * compassX + longAxisY[panel] * compassY >= 0 ? 1 : -1;
        const topX = longAxisX[panel] * sign;
        const topY = longAxisY[panel] * sign;
        const leftX = -topY;
        const leftY = topX;
        const offset = slotOffset(
          settings.slot,
          turned,
          { width: shortSide[panel], length: longSide[panel] },
          insets
        );

        const x = centerX[panel] + topX * offset.alongTopM + leftX * offset.alongLeftM;
        const y = centerY[panel] + topY * offset.alongTopM + leftY * offset.alongLeftM;
        points[panel * BARCODE_POINT_STRIDE] = modules.lon0 + x / modules.kx;
        points[panel * BARCODE_POINT_STRIDE + 1] = modules.lat0 + y / modules.ky;
      });
    }
  }

  return points;
};

export interface NumberedTable {
  /** 1-based, line by line from the top left of the map. */
  number: number;
  /** [lon, lat] mean of the table's module centres */
  center: [number, number];
  panels: number;
  /** [lon, lat] corners of the rectangle around the table, aligned with the installation direction */
  outline: [number, number][];
}

/**
 * Unit vectors of the table lines: along the installation direction towards
 * east (east–west tables) or north (north–south tables), and across the lines
 * towards north or east. Local metric frame, x east and y north.
 */
const tableLineAxes = (installationBearing: number) => {
  const bearingRad = (installationBearing * Math.PI) / 180;
  let alongX = Math.sin(bearingRad);
  let alongY = Math.cos(bearingRad);
  const runsEastWest = Math.abs(alongX) >= Math.abs(alongY);
  if (runsEastWest ? alongX < 0 : alongY < 0) {
    alongX = -alongX;
    alongY = -alongY;
  }
  return {
    runsEastWest,
    alongX,
    alongY,
    acrossX: runsEastWest ? -alongY : alongY,
    acrossY: runsEastWest ? alongX : -alongX,
  };
};

export interface TableNumbering {
  tables: NumberedTable[];
  /** Table number of every panel, indexed like the panels. */
  tableOfPanel: Int32Array;
}

/**
 * Number the tables so they can be referred to, in map reading order.
 *
 * Tables first form lines along the installation direction. East–west lines
 * are numbered from the northernmost down, each from west to east; north–south
 * lines from the westernmost to the right, each from north to south. Uses the
 * same table detection as the structure, so the count matches what is shown.
 */
export const numberTables = (
  corners: ArrayLike<number>,
  { tableGapM, installationBearing }: { tableGapM: number; installationBearing: number }
): TableNumbering => {
  const count = Math.floor(corners.length / 8);
  const tableOfPanel = new Int32Array(count);
  const modules = prepareModules(corners);
  if (!modules) return { tables: [], tableOfPanel };

  const { centerX, centerY, lon0, lat0, kx, ky } = modules;
  const { tables } = detectTables(modules, resolveTableGap(modules, tableGapM));

  const { runsEastWest, alongX, alongY, acrossX, acrossY } = tableLineAxes(installationBearing);
  const toDegrees = (along: number, across: number): [number, number] => [
    lon0 + (along * alongX + across * acrossX) / kx,
    lat0 + (along * alongY + across * acrossY) / ky,
  ];

  const summaries = [...tables.values()].map((members) => {
    let sumX = 0;
    let sumY = 0;
    let minAcross = Infinity;
    let maxAcross = -Infinity;
    // Extent of the module corners, for the outline.
    let edgeMinAlong = Infinity;
    let edgeMaxAlong = -Infinity;
    let edgeMinAcross = Infinity;
    let edgeMaxAcross = -Infinity;
    for (const panel of members) {
      sumX += centerX[panel];
      sumY += centerY[panel];
      const across = centerX[panel] * acrossX + centerY[panel] * acrossY;
      if (across < minAcross) minAcross = across;
      if (across > maxAcross) maxAcross = across;
      const o = panel * 8;
      for (let c = 0; c < 8; c += 2) {
        const x = (corners[o + c] - lon0) * kx;
        const y = (corners[o + c + 1] - lat0) * ky;
        const cornerAlong = x * alongX + y * alongY;
        const cornerAcross = x * acrossX + y * acrossY;
        if (cornerAlong < edgeMinAlong) edgeMinAlong = cornerAlong;
        if (cornerAlong > edgeMaxAlong) edgeMaxAlong = cornerAlong;
        if (cornerAcross < edgeMinAcross) edgeMinAcross = cornerAcross;
        if (cornerAcross > edgeMaxAcross) edgeMaxAcross = cornerAcross;
      }
    }
    const cx = sumX / members.length;
    const cy = sumY / members.length;
    const acrossPosition = cx * acrossX + cy * acrossY;
    const alongPosition = cx * alongX + cy * alongY;
    return {
      members,
      cx,
      cy,
      // Top line first (east–west) or left line first (north–south) ...
      lineKey: runsEastWest ? -acrossPosition : acrossPosition,
      // ... then west to east, or north to south.
      alongKey: runsEastWest ? alongPosition : -alongPosition,
      width: maxAcross - minAcross + modules.maxLongSide,
      outline: [
        toDegrees(edgeMinAlong, edgeMinAcross),
        toDegrees(edgeMaxAlong, edgeMinAcross),
        toDegrees(edgeMaxAlong, edgeMaxAcross),
        toDegrees(edgeMinAlong, edgeMaxAcross),
      ],
    };
  });

  // Table centres closer than half a table width across the lines share a line.
  const lineBreak = 0.5 * median(summaries.map((summary) => summary.width));
  summaries.sort((a, b) => a.lineKey - b.lineKey);
  const lines: (typeof summaries)[] = [];
  summaries.forEach((summary, index) => {
    if (index === 0 || summary.lineKey - summaries[index - 1].lineKey > lineBreak) lines.push([]);
    lines[lines.length - 1].push(summary);
  });

  const numbered: NumberedTable[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.alongKey - b.alongKey);
    for (const summary of line) {
      const number = numbered.length + 1;
      for (const panel of summary.members) tableOfPanel[panel] = number;
      numbered.push({
        number,
        center: [lon0 + summary.cx / kx, lat0 + summary.cy / ky],
        panels: summary.members.length,
        outline: summary.outline,
      });
    }
  }

  return { tables: numbered, tableOfPanel };
};

const numberingCache: { corners: string; tableGapM: number; installationBearing: number; result: TableNumbering }[] = [];
const NUMBERING_CACHE_SIZE = 4;

/**
 * numberTables for a stored layout, remembered for the last few layouts: the
 * map labels, table picking and the scan panel all ask for the same numbers.
 */
export const numberTablesCached = (
  corners: string,
  options: { tableGapM: number; installationBearing: number }
): TableNumbering => {
  const hit = numberingCache.find(
    (entry) =>
      entry.corners === corners &&
      entry.tableGapM === options.tableGapM &&
      entry.installationBearing === options.installationBearing
  );
  if (hit) return hit.result;

  const result = numberTables(decodePanelCorners(corners), options);
  numberingCache.unshift({ corners, ...options, result });
  if (numberingCache.length > NUMBERING_CACHE_SIZE) numberingCache.pop();
  return result;
};

/** Number of the table whose outline holds the point, allowing `toleranceM` around it; null if none. */
export const findTableAt = (tables: NumberedTable[], lon: number, lat: number, toleranceM = 0.3): number | null => {
  const kx = METERS_PER_DEGREE_LON_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);
  let best: { number: number; outside: number } | null = null;

  for (const table of tables) {
    const x = table.outline.map(([cornerLon]) => (cornerLon - lon) * kx);
    const y = table.outline.map(([, cornerLat]) => (cornerLat - lat) * METERS_PER_DEGREE_LAT);
    // Shoelace sign tells which side of each edge is inside.
    let area = 0;
    for (let i = 0; i < 4; i++) area += x[i] * y[(i + 1) % 4] - x[(i + 1) % 4] * y[i];
    const orientation = area >= 0 ? 1 : -1;

    // Largest distance of the point outside any edge; <= 0 means inside.
    let outside = -Infinity;
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      const edgeX = x[next] - x[i];
      const edgeY = y[next] - y[i];
      const length = Math.hypot(edgeX, edgeY) || 1;
      // Signed distance of the origin (the point) to the edge line, positive inside.
      const inside = (orientation * (edgeX * -y[i] - edgeY * -x[i])) / length;
      outside = Math.max(outside, -inside);
    }
    if (outside <= toleranceM && (!best || outside < best.outside)) best = { number: table.number, outside };
  }

  return best?.number ?? null;
};

export interface ScanPathOptions {
  /** Detection settings, so rows and numbers match what is shown. */
  tableGapM: number;
  installationBearing: number;
  label: BarcodeLabelSettings;
  /** Table numbers in flight order. */
  tables: number[];
  startCorner: ScanStartCorner;
  /** From numberTables with the same detection settings. */
  tableOfPanel: Int32Array;
  /** Tables turned the other way round. */
  flippedTables?: Iterable<number>;
}

export interface ScanTablePath {
  /** First table of the run, kept for messages. */
  number: number;
  /** Every table flown in this run, in the order they are scanned. */
  tables: number[];
  /**
   * The table starts straight ahead of where the previous one ended, in the
   * same barcode line: the aircraft can fly on at scan altitude instead of
   * climbing over the panels. False for the first table.
   */
  continuesAhead: boolean;
  /** Straight barcode lines flown along the table */
  lines: number;
  /** Barcodes on the table; close pairs share one scan point, so `points` can be fewer. */
  barcodes: number;
  /** Points that read no barcode: the lead-in and lead-out of every line. */
  leads: number;
  /**
   * Per scan point, the point whose height it has to take, or null for the
   * usual case of a point that reads its own. A lead-in and a lead-out hold
   * the height of the barcode beside them: nothing is measured where they sit,
   * off the end of the table.
   */
  heightFrom: (number | null)[];
  /**
   * Per scan point, whether it is flown. Manual position leaves some out, and
   * they stay in `points` so that heights are read and smoothed over the whole
   * line, exactly as they are without it.
   */
  flown: boolean[];
  /** [lon, lat] scan points in scan order */
  points: [number, number][];
  /** Per scan point, the one or two places its height may be read at. */
  heightRefs: [number, number][][];
}

/** A barcode or scan point in the table's frame, metres along and across the table line. */
interface ScanItem {
  lon: number;
  lat: number;
  along: number;
  across: number;
  /**
   * [lon, lat] places the height of this point may be read at: the point
   * moved onto the panel, a quarter of a module in and a quarter to each
   * side.
   *
   * A barcode sits centimetres from the edge, where a surface model easily
   * reads the ground between the rows, and a tilted module is a good half
   * metre lower at its bottom edge than at its top — so the height cannot be
   * read at the barcode, nor at the middle of the whole module. Moving only
   * sideways keeps the reference at the point's own place along the string,
   * which is what keeps a line of waypoints smooth. A point shared by two
   * panels keeps one reference per panel, and the higher one wins.
   */
  heightRefs: [number, number][];
}

/**
 * Two barcodes of a line closer than `distanceM` become one scan point halfway
 * between them. With upside-down modules, neighbouring rows put their labels
 * face to face on the lines inside the table; one stop reads both.
 */
const mergeClosePairs = (line: ScanItem[], distanceM: number): ScanItem[] => {
  const stops: ScanItem[] = [];
  for (let i = 0; i < line.length; i++) {
    const item = line[i];
    const next = line[i + 1];
    if (next && Math.hypot(next.along - item.along, next.across - item.across) < distanceM) {
      stops.push({
        lon: (item.lon + next.lon) / 2,
        lat: (item.lat + next.lat) / 2,
        along: (item.along + next.along) / 2,
        across: (item.across + next.across) / 2,
        // Both panels keep a say in the height; the higher roof wins later.
        heightRefs: [...item.heightRefs, ...next.heightRefs].slice(0, 4),
      });
      i++;
    } else {
      stops.push(item);
    }
  }
  return stops;
};

/**
 * Barcode positions of the chosen tables in the order they are scanned.
 *
 * The aircraft flies straight lines along the table, one per line of barcodes,
 * not one per module row: with upside-down modules the labels of one row sit
 * on both of its edges, and labels of neighbouring rows that face each other
 * only centimetres apart share one line. On such a line two barcodes closer
 * than half a module are scanned from one point halfway between them.
 *
 * Tables that follow each other on the same line are flown as one run: the
 * near line of each table one after another, then back along their far lines.
 * A run that begins straight ahead of the previous one is marked
 * `continuesAhead` so the route can keep the scan altitude there.
 *
 * Every table starts at the chosen corner of a north-up map, with one
 * exception: a table lying on the line the aircraft is already on — in front
 * of it or behind it — is entered at its nearer end, so no stretch is flown
 * twice. Lines are flown back and forth: after a line the aircraft moves to
 * the nearest next line and flies it the other way, so there are no empty
 * return legs. Tables keep the given order; numbers that no longer exist are
 * left out.
 */
export const planScanPath = (corners: ArrayLike<number>, options: ScanPathOptions): ScanTablePath[] => {
  const modules = prepareModules(corners);
  if (!modules || options.tables.length === 0) return [];
  const { longAxisX, longAxisY, longSide, shortSide } = modules;

  const points = computeBarcodePoints(corners, {
    tableGapM: options.tableGapM,
    installationBearing: options.installationBearing,
    settings: options.label,
    tableOfPanel: options.tableOfPanel,
    flippedTables: options.flippedTables,
  });

  const membersOf = new Map<number, number[]>();
  for (const number of options.tables) membersOf.set(number, []);
  for (let panel = 0; panel < modules.count; panel++) {
    membersOf.get(options.tableOfPanel[panel])?.push(panel);
  }

  const { alongX, alongY, acrossX, acrossY } = tableLineAxes(options.installationBearing);
  // The corner as a compass direction; lines and line ends nearest to it come first.
  const cornerX = options.startCorner.endsWith('right') ? 1 : -1;
  const cornerY = options.startCorner.startsWith('top') ? 1 : -1;
  const acrossSign = acrossX * cornerX + acrossY * cornerY >= 0 ? 1 : -1;
  const alongSign = alongX * cornerX + alongY * cornerY >= 0 ? 1 : -1;
  const { lon0, lat0, kx, ky } = modules;

  /** One picked table: its barcode points in the frame of the table lines. */
  interface TableItems {
    number: number;
    items: ScanItem[];
    minAcross: number;
    maxAcross: number;
    moduleAcross: number;
    moduleAlong: number;
  }

  const readTable = (number: number): TableItems | null => {
    const members = membersOf.get(number);
    if (!members || members.length === 0) return null;

    const first = members[0];
    const longAlong = Math.abs(longAxisX[first] * alongX + longAxisY[first] * alongY);
    const items: ScanItem[] = [];
    for (const panel of members) {
      // Two places to read the height, a quarter of a module to each side of
      // the point and a quarter towards the module's middle. A point on the
      // joint between two modules then has one reading well inside each of
      // them, and the end of a string has one inside its last module.
      const quarterLong = longSide[panel] / 4;
      const quarterShort = shortSide[panel] / 4;
      const sideX = -longAxisY[panel];
      const sideY = longAxisX[panel];
      forEachBarcodePoint(points, panel, (lon, lat) => {
        const x = (lon - lon0) * kx;
        const y = (lat - lat0) * ky;
        const offsetX = x - modules.centerX[panel];
        const offsetY = y - modules.centerY[panel];
        const towardsTop = offsetX * longAxisX[panel] + offsetY * longAxisY[panel] >= 0 ? 1 : -1;
        const inwardX = x - longAxisX[panel] * quarterLong * towardsTop;
        const inwardY = y - longAxisY[panel] * quarterLong * towardsTop;
        const heightRefs: [number, number][] = [1, -1].map((side) => [
          lon0 + (inwardX + sideX * quarterShort * side) / kx,
          lat0 + (inwardY + sideY * quarterShort * side) / ky,
        ]);
        items.push({
          lon,
          lat,
          along: x * alongX + y * alongY,
          across: x * acrossX + y * acrossY,
          heightRefs,
        });
      });
    }
    if (items.length === 0) return null;

    const acrossValues = items.map((item) => item.across);
    return {
      number,
      items,
      minAcross: Math.min(...acrossValues),
      maxAcross: Math.max(...acrossValues),
      moduleAcross: (1 - longAlong) * longSide[first] + longAlong * shortSide[first],
      moduleAlong: longAlong * longSide[first] + (1 - longAlong) * shortSide[first],
    };
  };

  // Tables that follow each other on the same line are flown as one run: every
  // near line first, then back along the far lines. Scanning each table on its
  // own would end it where it started and leave a long leg back to the next.
  const chains: TableItems[][] = [];
  const done = new Set<number>();
  for (const number of options.tables) {
    if (done.has(number)) continue;
    done.add(number);
    const table = readTable(number);
    if (!table) continue;

    const chain = chains[chains.length - 1];
    const previous = chain?.[chain.length - 1];
    const sameLine =
      !!previous &&
      table.minAcross <= previous.maxAcross + 0.5 * table.moduleAcross &&
      table.maxAcross >= previous.minAcross - 0.5 * table.moduleAcross;
    if (sameLine) chain.push(table);
    else chains.push([table]);
  }

  const nearerSign = (value: number, min: number, max: number) =>
    Math.abs(value - max) <= Math.abs(value - min) ? 1 : -1;

  const paths: ScanTablePath[] = [];
  // Where the previous run ended, as [along, across].
  let previousEnd: [number, number] | null = null;
  const leadPoints = options.label.fourCorners === true && options.label.manualPosition === true;
  const skip = skipPanelsOf(options.label);

  for (const chain of chains) {
    const items = chain.flatMap((table) => table.items);
    const { moduleAcross, moduleAlong } = chain[0];
    // Labels facing each other across a row gap merge; the two edges of one module stay apart.
    const lineGapM = Math.max(0.35, 0.3 * moduleAcross);
    // Neighbours along one row are a whole module apart, so they never pair up.
    const pairDistanceM = 0.5 * moduleAlong;
    const minAcross = Math.min(...chain.map((table) => table.minAcross));
    const maxAcross = Math.max(...chain.map((table) => table.maxAcross));

    // Every run after the first is entered at the corner nearest to where the
    // last one ended, so the aircraft snakes on instead of returning. A table
    // with an odd number of lines — a 2P table has three, its two outer edges
    // and the border its rows share — ends at the far end of its run, and
    // starting the next one at a fixed corner would fly its whole length twice.
    // The chosen start corner still decides where the first run begins.
    const lineSign = previousEnd ? nearerSign(previousEnd[1], minAcross, maxAcross) : acrossSign;
    // First line: the one furthest towards lineSign.
    items.sort((a, b) => (b.across - a.across) * lineSign);
    const lines: ScanItem[][] = [];
    items.forEach((item, k) => {
      if (k === 0 || Math.abs(item.across - items[k - 1].across) > lineGapM) lines.push([]);
      lines[lines.length - 1].push(item);
    });

    let endSign = alongSign;
    if (previousEnd) {
      const alongValues = lines[0].map((item) => item.along);
      endSign = nearerSign(previousEnd[0], Math.min(...alongValues), Math.max(...alongValues));
    }

    /**
     * A module further on: where the next module's point would be if the row
     * carried on. It keeps the height of the point it is taken from, so the
     * aircraft holds the scan height over it instead of following whatever the
     * surface model reads off the end of the table.
     */
    const beyond = (from: ScanItem, towards: ScanItem | undefined, fallbackSign: number): ScanItem => {
      let dx = alongX * fallbackSign;
      let dy = alongY * fallbackSign;
      if (towards) {
        const ux = (from.lon - towards.lon) * kx;
        const uy = (from.lat - towards.lat) * ky;
        const length = Math.hypot(ux, uy);
        if (length > 1e-6) {
          dx = ux / length;
          dy = uy / length;
        }
      }
      const lon = from.lon + (dx * moduleAlong) / kx;
      const lat = from.lat + (dy * moduleAlong) / ky;
      const x = (lon - lon0) * kx;
      const y = (lat - lat0) * ky;
      return {
        lon,
        lat,
        along: x * alongX + y * alongY,
        across: x * acrossX + y * acrossY,
        heightRefs: from.heightRefs,
      };
    };

    const chainPoints: [number, number][] = [];
    const chainRefs: [number, number][][] = [];
    const chainHeightFrom: (number | null)[] = [];
    const chainFlown: boolean[] = [];
    let entryStop = items[0];
    let lastStop = items[0];
    lines.forEach((line, lineIndex) => {
      line.sort((a, b) => (b.along - a.along) * endSign);
      const merged = mergeClosePairs(line, pairDistanceM);
      if (lineIndex % 2 === 1) merged.reverse();
      // Manual position: the aircraft is still gathering or shedding speed at
      // the ends of a row, so the first and the last barcode are passed at a
      // steady speed only if the row is entered and left one module further out.
      const travelSign = (lineIndex % 2 === 1 ? 1 : -1) * endSign;
      const stops = leadPoints
        ? [
            beyond(merged[0], merged[1], -travelSign),
            ...merged,
            beyond(merged[merged.length - 1], merged[merged.length - 2], travelSign),
          ]
        : merged;
      if (lineIndex === 0) entryStop = stops[0];
      const lineStart = chainPoints.length;
      stops.forEach((stop, k) => {
        chainPoints.push([stop.lon, stop.lat]);
        chainRefs.push(stop.heightRefs);
        chainHeightFrom.push(null);
        // Manual position: one point of every so many along the line, the ends
        // always. The lead-in and lead-out are the ends here, and the count
        // runs over the barcodes between them.
        chainFlown.push(!leadPoints || isFlownInLine(k - 1, merged.length, skip));
      });
      if (leadPoints) {
        chainFlown[lineStart] = true;
        chainFlown[chainPoints.length - 1] = true;
        chainHeightFrom[lineStart] = lineStart + 1;
        chainHeightFrom[chainPoints.length - 1] = chainPoints.length - 2;
      }
      lastStop = stops[stops.length - 1];
    });

    // Ahead in the same line: the aircraft would only move along the line, so
    // it stays between the strings instead of crossing over the panels.
    const continuesAhead = previousEnd !== null && Math.abs(entryStop.across - previousEnd[1]) <= 0.5 * moduleAcross;

    previousEnd = [lastStop.along, lastStop.across];
    paths.push({
      number: chain[0].number,
      tables: chain.map((table) => table.number),
      continuesAhead,
      lines: lines.length,
      barcodes: items.length,
      leads: leadPoints ? lines.length * 2 : 0,
      points: chainPoints,
      heightRefs: chainRefs,
      heightFrom: chainHeightFrom,
      flown: chainFlown,
    });
  }

  return paths;
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
