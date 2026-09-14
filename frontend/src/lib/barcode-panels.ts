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

export interface PanelStyle {
  outlineEnabled: boolean;
  outlineColor: string; // CSS colour, #rrggbb
  outlineWidth: number; // screen pixels
  fillEnabled: boolean;
  fillColor: string; // CSS colour, #rrggbb
  fillOpacity: number; // 0..1
}

/** Outlined only: the imagery underneath stays readable. */
export const DEFAULT_PANEL_STYLE: PanelStyle = {
  outlineEnabled: true,
  outlineColor: '#00e5ff',
  outlineWidth: 2,
  fillEnabled: false,
  fillColor: '#ffd400',
  fillOpacity: 0.45,
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
  /** Direction the tables run, degrees clockwise from north, 0–180. */
  tableBearing: number;
}

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
 * Modules closer than this, edge to edge, are on the same table. Measured
 * layouts have 0–3 cm between modules and 20 cm between the rows of a table,
 * while neighbouring tables of a string sit about half a metre apart.
 */
const TABLE_GAP_M = 0.3;

export const structureCode = (structure: PanelStructure) =>
  `${structure.rows}${structure.orientation === 'portrait' ? 'P' : 'L'}`;

export const describeStructure = (structure: PanelStructure) =>
  `${structure.rows} ${structure.rows === 1 ? 'row' : 'rows'} ${structure.orientation} (${structureCode(structure)})`;

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

/**
 * Group touching modules into tables and read each table's shape: how many
 * modules stand across it and along it. The configuration holding the most
 * panels describes the park; the rest are listed as variants.
 */
export const analysePanelStructure = (corners: ArrayLike<number>): PanelStructure | null => {
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

  // Neighbour search on a grid one module (plus gap) wide.
  const cellSize = maxLongSide + TABLE_GAP_M;
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
          const sideBySide =
            alongLong < 0.3 * longSide[i] && alongShort > 0.5 * shortSide[i] && alongShort < shortSide[i] + TABLE_GAP_M;
          const endToEnd =
            alongShort < 0.3 * shortSide[i] && alongLong > 0.5 * longSide[i] && alongLong < longSide[i] + TABLE_GAP_M;
          if (sideBySide || endToEnd) {
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

  interface Shape {
    panels: number;
    perRow: number[];
    bearing: number;
  }
  const shapes = new Map<string, Shape>();

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
      const lengthX = portrait ? -ay : ax;
      const lengthY = portrait ? ax : ay;
      shape = { panels: 0, perRow: [], bearing: ((Math.atan2(lengthX, lengthY) * 180) / Math.PI + 360) % 180 };
      shapes.set(key, shape);
    }
    shape.panels += members.length;
    shape.perRow.push(Math.round(members.length / rows));
  }

  let dominantKey = '';
  let dominant: Shape | null = null;
  for (const [key, shape] of shapes) {
    if (!dominant || shape.panels > dominant.panels) {
      dominant = shape;
      dominantKey = key;
    }
  }
  if (!dominant) return null;

  const variants: Record<string, number> = {};
  for (const [key, shape] of shapes) {
    if (key !== dominantKey) variants[key] = shape.perRow.length;
  }

  return {
    rows: parseInt(dominantKey, 10),
    orientation: dominantKey.endsWith('P') ? 'portrait' : 'landscape',
    tableCount: tables.size,
    modulesPerRow: mostCommon(dominant.perRow),
    minModulesPerRow: dominant.perRow.reduce((min, value) => Math.min(min, value), Infinity),
    maxModulesPerRow: dominant.perRow.reduce((max, value) => Math.max(max, value), 0),
    consistency: dominant.panels / count,
    variants,
    tableBearing: Math.round(dominant.bearing * 10) / 10,
  };
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
