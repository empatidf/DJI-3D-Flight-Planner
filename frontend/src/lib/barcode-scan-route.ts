/**
 * The flight route of a Barcode Scan mission.
 *
 * The aircraft visits every barcode of the chosen tables at the scan altitude
 * above the sampled terrain. Between tables it climbs by the safe jump, flies
 * level and descends onto the next table's first barcode. Heights are stored
 * as absolute altitudes, like every other route; the takeoff point's ground
 * altitude is what they are measured from when exported.
 */

import { useMissionStore, type Mission, type WaypointKind } from '../stores/mission-store';
import {
  DEFAULT_SAFE_JUMP_M,
  DEFAULT_SCAN_ALTITUDE_M,
  DEFAULT_SCAN_START_CORNER,
  decodePanelCorners,
  numberTablesCached,
  planScanPath,
} from './barcode-panels';
import { getCesiumViewer, sampleTerrainForWaypoints } from './terrain-sampler';

export const BARCODE_ROUTE_LINE_ID = 'barcode-scan-route';
export const SAFE_TAKEOFF_DEFAULT_M = 20;

const METERS_PER_DEGREE_LAT = 110574;
const METERS_PER_DEGREE_LON_AT_EQUATOR = 111320;

/**
 * Longest straight-on leg flown between two barcodes without a point in
 * between. At scan altitude the aircraft is less than a metre over the
 * panels, so a long leg follows the ground instead of cutting across it.
 */
const STRAIGHT_LEG_STEP_M = 10;

/** Settings of the scan route with their defaults applied. */
export const barcodeRouteSettings = (mission: Mission) => {
  const scan = mission.barcode?.scan;
  return {
    scanAltitudeM: scan?.scanAltitudeM ?? DEFAULT_SCAN_ALTITUDE_M,
    safeJumpM: scan?.safeJumpM ?? DEFAULT_SAFE_JUMP_M,
    safeTakeoffM: mission.parameters.safeTakeoffAltitude ?? SAFE_TAKEOFF_DEFAULT_M,
    tables: scan?.tables ?? [],
    startCorner: scan?.startCorner ?? DEFAULT_SCAN_START_CORNER,
  };
};

/** Everything the route depends on; a stored route with another key is out of date. */
export const barcodeRouteKey = (mission: Mission) => {
  const barcode = mission.barcode;
  return JSON.stringify([
    barcodeRouteSettings(mission),
    mission.takeoffPoint,
    barcode?.label ?? null,
    barcode?.structure?.tableGapM ?? null,
    barcode?.structure?.installationBearing ?? null,
    barcode?.sourceFileName ?? null,
    barcode?.panelCount ?? 0,
  ]);
};

export const getBarcodeRoute = (mission: Mission) =>
  mission.flightLines.find((line) => line.id === BARCODE_ROUTE_LINE_ID) ?? null;

/** What still has to be set before a route can be generated, as messages for the user. */
export const missingForBarcodeRoute = (mission: Mission): string[] => {
  const missing: string[] = [];
  if (!mission.barcode?.structure) missing.push('Import the panel layout.');
  else if (!mission.barcode.label) missing.push('Set the barcode position (Panel display → Barcode position).');
  if (!mission.takeoffPoint) missing.push('Set the takeoff point: all heights are measured from its ground altitude.');
  if (barcodeRouteSettings(mission).tables.length === 0) missing.push('Add at least one table.');
  return missing;
};

export interface BarcodeRouteSummary {
  waypoints: number;
  distanceM: number;
  /** Lowest and highest waypoint above the takeoff point's ground. */
  minHeightM: number;
  maxHeightM: number;
}

export const summarizeBarcodeRoute = (coordinates: number[][], takeoffGroundM: number): BarcodeRouteSummary => {
  let distanceM = 0;
  let minHeightM = Infinity;
  let maxHeightM = -Infinity;
  coordinates.forEach((point, index) => {
    const height = point[2] - takeoffGroundM;
    minHeightM = Math.min(minHeightM, height);
    maxHeightM = Math.max(maxHeightM, height);
    if (index === 0) return;
    const previous = coordinates[index - 1];
    const kx = METERS_PER_DEGREE_LON_AT_EQUATOR * Math.cos((point[1] * Math.PI) / 180);
    distanceM += Math.hypot(
      (point[0] - previous[0]) * kx,
      (point[1] - previous[1]) * METERS_PER_DEGREE_LAT,
      point[2] - previous[2]
    );
  });
  return { waypoints: coordinates.length, distanceM, minHeightM, maxHeightM };
};

const findMission = (missionId: string) => useMissionStore.getState().missions.find((item) => item.id === missionId);

/**
 * Build the scan route and store it as the mission's flight line.
 *
 * 1. Takeoff: climb to the safe takeoff height over the takeoff point and over
 *    the first barcode — the higher ground of the two decides — fly level to
 *    above the first barcode and descend onto it. The safe jump plays no part
 *    here; it is only used from string to string.
 * 2. Each table: every barcode at terrain + scan altitude, in scan order.
 * 3. Next table: climb by the safe jump over the last barcode (or over the next
 *    table's first barcode, if that one is higher), fly level, descend onto it.
 *    A table that starts straight ahead in the same line needs none of that,
 *    and neither does any table when the safe jump is 0: the aircraft flies on
 *    at scan altitude (see continuesAhead).
 * 4. After the last barcode: climb by the safe jump, clear of the panels.
 */
export const generateBarcodeScanRoute = async (missionId: string): Promise<string> => {
  const mission = findMission(missionId);
  if (!mission || mission.missionType !== 'barcode') throw new Error('The mission no longer exists.');

  const missing = missingForBarcodeRoute(mission);
  if (missing.length > 0) throw new Error(missing[0]);

  const barcode = mission.barcode!;
  const structure = barcode.structure!;
  const takeoffPoint = mission.takeoffPoint!;
  const settings = barcodeRouteSettings(mission);
  const key = barcodeRouteKey(mission);

  const viewer = getCesiumViewer();
  if (!viewer) throw new Error('The map is not ready yet.');

  const detection = { tableGapM: structure.tableGapM, installationBearing: structure.installationBearing };
  const { tableOfPanel } = numberTablesCached(barcode.corners, detection);
  const paths = planScanPath(decodePanelCorners(barcode.corners), {
    ...detection,
    label: barcode.label!,
    tables: settings.tables,
    startCorner: settings.startCorner,
    tableOfPanel,
  });
  if (paths.length === 0) throw new Error('None of the selected tables has barcode positions.');

  // A table reached without a jump — straight ahead, or with the safe jump set
  // to 0 — is flown at scan altitude. Long legs get points in between so they
  // keep their height over the ground.
  const flyOn = (path: (typeof paths)[number]) => path.continuesAhead || settings.safeJumpM <= 0;
  const legs = paths.map((path, index) => {
    const previous = index > 0 ? paths[index - 1].points[paths[index - 1].points.length - 1] : null;
    const between: [number, number][] = [];
    if (previous && flyOn(path)) {
      const [fromLon, fromLat] = previous;
      const [toLon, toLat] = path.points[0];
      const kx = METERS_PER_DEGREE_LON_AT_EQUATOR * Math.cos((toLat * Math.PI) / 180);
      const metres = Math.hypot((toLon - fromLon) * kx, (toLat - fromLat) * METERS_PER_DEGREE_LAT);
      const steps = Math.floor(metres / STRAIGHT_LEG_STEP_M);
      for (let step = 1; step <= steps; step++) {
        const t = step / (steps + 1);
        between.push([fromLon + (toLon - fromLon) * t, fromLat + (toLat - fromLat) * t]);
      }
    }
    return { path, between };
  });

  const scanPoints = legs.flatMap((leg) => [...leg.between, ...leg.path.points].map(([lon, lat]) => [lon, lat, 0]));
  const sampled = await sampleTerrainForWaypoints(viewer, scanPoints, settings.scanAltitudeM);

  const current = findMission(missionId);
  if (!current?.barcode) throw new Error('The mission no longer exists.');
  if (barcodeRouteKey(current) !== key) throw new Error('Settings changed while the terrain was sampled. Generate again.');

  const coordinates: number[][] = [];
  const pointKinds: WaypointKind[] = [];
  const push = (lon: number, lat: number, altitude: number, kind: WaypointKind = 'transit') => {
    const rounded = Math.round(altitude * 100) / 100;
    const last = coordinates[coordinates.length - 1];
    // A safe jump of 0 would repeat the point it starts from.
    if (last && last[0] === lon && last[1] === lat && Math.abs(last[2] - rounded) < 0.01) return;
    coordinates.push([lon, lat, rounded]);
    pointKinds.push(kind);
  };

  const [takeoffLon, takeoffLat, takeoffGround] = takeoffPoint;
  let offset = 0;
  legs.forEach(({ path, between }, index) => {
    const onTheWay = sampled.slice(offset, offset + between.length);
    offset += between.length;
    const scan = sampled.slice(offset, offset + path.points.length);
    offset += path.points.length;
    const start = scan[0];

    if (index === 0) {
      // Safe takeoff is kept over the takeoff point and over the first barcode:
      // the aircraft climbs, crosses at that height and drops onto the barcode.
      // It applies to this leg whatever the safe jump is.
      const firstGround = start[2] - settings.scanAltitudeM;
      const level = Math.max(takeoffGround, firstGround) + settings.safeTakeoffM;
      push(takeoffLon, takeoffLat, level);
      push(start[0], start[1], level);
    } else if (flyOn(path)) {
      // No jump: straight on at scan altitude, following the ground.
      onTheWay.forEach(([lon, lat, altitude]) => push(lon, lat, altitude));
    } else {
      const last = coordinates[coordinates.length - 1];
      const level = Math.max(last[2], start[2]) + settings.safeJumpM;
      push(last[0], last[1], level);
      push(start[0], start[1], level);
    }
    scan.forEach(([lon, lat, altitude]) => push(lon, lat, altitude, 'barcode'));
  });
  const last = coordinates[coordinates.length - 1];
  push(last[0], last[1], last[2] + settings.safeJumpM);

  useMissionStore.getState().updateMission(missionId, {
    flightLines: [{ id: BARCODE_ROUTE_LINE_ID, coordinates, photoPoints: [], pointKinds }],
    barcode: { ...current.barcode, scan: { ...current.barcode.scan, routeKey: key } },
  });

  const straightOn = paths.filter((path, index) => index > 0 && flyOn(path)).length;
  const barcodes = paths.reduce((sum, path) => sum + path.barcodes, 0);
  const shared = barcodes - paths.reduce((sum, path) => sum + path.points.length, 0);
  const skipped = settings.tables.length - paths.length;
  return (
    `Route generated: ${paths.length} ${paths.length === 1 ? 'table' : 'tables'}, ` +
    `${barcodes.toLocaleString()} barcodes from ${paths.reduce((sum, path) => sum + path.points.length, 0).toLocaleString()} scan points` +
    (shared > 0 ? ` (${shared.toLocaleString()} close pairs scanned from their midpoint)` : '') +
    `, ${coordinates.length.toLocaleString()} waypoints` +
    (straightOn > 0 ? `, ${straightOn} table${straightOn === 1 ? '' : 's'} entered straight on` : '') +
    (skipped > 0 ? ` (${skipped} selected ${skipped === 1 ? 'table' : 'tables'} not found)` : '')
  );
};
