/**
 * The flight route of a Barcode Scan mission.
 *
 * The aircraft visits every barcode of the chosen tables at the scan altitude
 * above the sampled terrain. Between tables it climbs by the safe jump, flies
 * level and descends onto the next table's first barcode. Heights are stored
 * as absolute altitudes, like every other route; the takeoff point's ground
 * altitude is what they are measured from when exported.
 */

import { useMissionStore, type FlightLine, type Mission, type WaypointKind } from '../stores/mission-store';
import {
  DEFAULT_DRONE_YAW_MODE,
  DEFAULT_SAFE_JUMP_M,
  DEFAULT_SCAN_ALTITUDE_M,
  DEFAULT_SCAN_SPEED_MPS,
  DEFAULT_SCAN_START_CORNER,
  DEFAULT_SCAN_TRANSIT_SPEED_MPS,
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
 * The takeoff ground and the panels have to be read from the same terrain, or
 * every height in the route is measured against something else. More than
 * this between them is not a hillside, it is a terrain layer that was not
 * loaded when one of them was read.
 */
const TERRAIN_MISMATCH_M = 60;

/**
 * The aircraft flies from waypoint to waypoint, so a climb or a descent needs
 * a leg to happen over. Two waypoints at the same spot leave it none, and DJI
 * stops the mission at the first one. The points that only change height are
 * therefore set this far to the side, along the leg they belong to.
 */
const VERTICAL_STEP_M = 1;

/** The slowest speed DJI Pilot 2 lets a wayline be flown at. */
const MIN_WAYLINE_SPEED_MPS = 1;

/**
 * A jump shorter than this has no room for a climb point and a descent point,
 * and is hardly worth climbing for: the aircraft flies straight across.
 */
const MIN_JUMP_GAP_M = 1.5;

/** Metres per degree at a latitude, east and north. */
const degreeScale = (latitude: number): [number, number] => [
  METERS_PER_DEGREE_LON_AT_EQUATOR * Math.cos((latitude * Math.PI) / 180),
  METERS_PER_DEGREE_LAT,
];

/** Metres between two points, near enough over the few metres this is used on. */
const metresBetween = (from: number[], to: number[]): number => {
  const [kx, ky] = degreeScale(from[1]);
  return Math.hypot((to[0] - from[0]) * kx, (to[1] - from[1]) * ky);
};

/** The point `from`, moved `metres` towards `toward`. */
const stepTowards = (from: number[], toward: number[], metres: number): [number, number] => {
  const [kx, ky] = degreeScale(from[1]);
  const dx = (toward[0] - from[0]) * kx;
  const dy = (toward[1] - from[1]) * ky;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-6) return [from[0], from[1]];
  return [from[0] + ((dx / distance) * metres) / kx, from[1] + ((dy / distance) * metres) / ky];
};

/** Neighbours on each side a barcode is compared with before it counts as a spike. */
const SPIKE_WINDOW = 3;
/** A barcode this far below its neighbours on the line is a bad sample, not a slope. */
const SPIKE_DROP_M = 1;

/**
 * Heights along one scan line, with single points that read far too low
 * pulled up to their neighbours. Panels are flat and the points are a couple
 * of metres apart, so a metre of sudden drop is the DSM, not the site.
 */
const withoutSpikes = (heights: number[]): { heights: number[]; fixed: number } => {
  const result = [...heights];
  let fixed = 0;

  for (let index = 0; index < heights.length; index++) {
    const from = Math.max(0, index - SPIKE_WINDOW);
    const to = Math.min(heights.length - 1, index + SPIKE_WINDOW);
    const neighbours: number[] = [];
    for (let other = from; other <= to; other++) if (other !== index) neighbours.push(heights[other]);
    if (neighbours.length < 3) continue;

    neighbours.sort((a, b) => a - b);
    const middle = neighbours[Math.floor(neighbours.length / 2)];
    if (heights[index] < middle - SPIKE_DROP_M) {
      result[index] = middle;
      fixed++;
    }
  }

  return { heights: result, fixed };
};

/**
 * Heading the aircraft holds during the scan: along the panel rows, the
 * opposite course, or the angle set by hand.
 */
export const barcodeDroneYaw = (mission: Mission): number => {
  const scan = mission.barcode?.scan;
  const bearing = mission.barcode?.structure?.installationBearing ?? mission.parameters.droneYaw ?? 0;
  switch (scan?.droneYawMode ?? DEFAULT_DRONE_YAW_MODE) {
    case 'reverse':
      return (bearing + 180) % 360;
    case 'manual':
      return scan?.droneYawDeg ?? bearing;
    default:
      return bearing;
  }
};

/**
 * Speed over the panels, and the faster speed for everything else. Both are
 * kept at DJI's lowest wayline speed or above: the aircraft does not fly a
 * wayline slower than 1 m/s, so a smaller number only makes the route differ
 * from what is flown. Missions saved with one are lifted here.
 */
export const barcodeSpeeds = (mission: Mission) => {
  const scan = mission.barcode?.scan;
  return {
    scanSpeedMps: Math.max(MIN_WAYLINE_SPEED_MPS, scan?.flightSpeedMps ?? DEFAULT_SCAN_SPEED_MPS),
    transitSpeedMps: Math.max(
      MIN_WAYLINE_SPEED_MPS,
      scan?.transitSpeedMps ?? DEFAULT_SCAN_TRANSIT_SPEED_MPS
    ),
  };
};

/** Settings of the scan route with their defaults applied. */
export const barcodeRouteSettings = (mission: Mission) => {
  const scan = mission.barcode?.scan;
  return {
    scanAltitudeM: scan?.scanAltitudeM ?? DEFAULT_SCAN_ALTITUDE_M,
    safeJumpM: scan?.safeJumpM ?? DEFAULT_SAFE_JUMP_M,
    safeTakeoffM: mission.parameters.safeTakeoffAltitude ?? SAFE_TAKEOFF_DEFAULT_M,
    tables: scan?.tables ?? [],
    flippedTables: scan?.flippedTables ?? [],
    startCorner: scan?.startCorner ?? DEFAULT_SCAN_START_CORNER,
    excludeTakeoffPoint: scan?.excludeTakeoffPoint === true,
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
 * Start the route again at one of its waypoints, for a scan that was cut
 * short: everything before it goes, and the aircraft takes off, climbs to the
 * safe takeoff height over both the takeoff point and the new first barcode,
 * crosses and drops onto it — the same opening as a fresh route.
 *
 * Returns the flight line as it was, so the crop can be taken back.
 */
export const cropBarcodeRoute = (missionId: string, pointIndex: number): FlightLine => {
  const mission = findMission(missionId);
  const route = mission ? getBarcodeRoute(mission) : null;
  if (!mission || !route) throw new Error('This mission has no scan route.');
  if (pointIndex <= 0 || pointIndex >= route.coordinates.length) {
    throw new Error('Pick a waypoint after the start of the route.');
  }
  if (!mission.takeoffPoint) throw new Error('Set the takeoff point first.');

  const settings = barcodeRouteSettings(mission);
  const kinds = route.pointKinds ?? [];
  const kept = route.coordinates.slice(pointIndex);
  const keptKinds = kinds.slice(pointIndex);
  const first = kept[0];

  // Ground under the new first waypoint: a barcode is flown at scan altitude
  // over it, anything else is already a height to stay above.
  const firstGround = keptKinds[0] === 'barcode' ? first[2] - settings.scanAltitudeM : first[2];
  const [takeoffLon, takeoffLat, takeoffGround] = mission.takeoffPoint;
  const level = Math.round((Math.max(takeoffGround, firstGround) + settings.safeTakeoffM) * 100) / 100;

  // The descent onto the new first waypoint needs a leg of its own, or the
  // aircraft is asked to lose the whole safe takeoff height on the spot.
  const [downLon, downLat] = stepTowards(first, [takeoffLon, takeoffLat], VERTICAL_STEP_M);
  const lead = settings.excludeTakeoffPoint
    ? []
    : [
        [takeoffLon, takeoffLat, level],
        [downLon, downLat, level],
      ];
  const coordinates = [...lead, ...kept];
  const pointKinds: WaypointKind[] = [...lead.map((): WaypointKind => 'transit'), ...keptKinds];
  // The waypoints that replace everything dropped take the links with them.
  const linkLegs = (route.linkLegs ?? [])
    .filter((leg) => leg >= pointIndex)
    .map((leg) => leg - pointIndex + lead.length);

  useMissionStore.getState().updateMission(missionId, {
    flightLines: mission.flightLines.map((line) =>
      line.id === BARCODE_ROUTE_LINE_ID ? { ...line, coordinates, pointKinds, linkLegs } : line
    ),
  });

  return route;
};

/** Put a cropped route back the way it was. */
export const restoreBarcodeRoute = (missionId: string, line: FlightLine): void => {
  const mission = findMission(missionId);
  if (!mission) return;
  useMissionStore.getState().updateMission(missionId, {
    flightLines: mission.flightLines.map((item) => (item.id === line.id ? line : item)),
  });
};

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
 *    and neither does any table when the safe jump is 0: the aircraft flies
 *    straight to its first barcode, no waypoint in between.
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
    flippedTables: settings.flippedTables,
    startCorner: settings.startCorner,
    tableOfPanel,
  });
  if (paths.length === 0) throw new Error('None of the selected tables has barcode positions.');

  // A table reached without a jump — straight ahead, or with the safe jump set
  // to 0 — is flown to directly, at the scan altitude of its first barcode.
  const flyOn = (path: (typeof paths)[number]) => path.continuesAhead || settings.safeJumpM <= 0;

  // A barcode's height is read a little way onto its panel, not at the
  // barcode: it sits centimetres from the edge, where a surface model easily
  // reads the ground between the rows, and a tilted module is lower at its
  // bottom edge than at its top. A point shared by two panels is read on both
  // and keeps the higher roof. The waypoint itself stays on the barcode.
  const scanPoints = paths.flatMap((path) => path.points.map(([lon, lat]) => [lon, lat, 0]));
  const refsPerPoint = paths.flatMap((path) => path.heightRefs);
  // The takeoff point is read again here, with the same terrain as the
  // panels: it was set at another moment, possibly before the site's surface
  // model had finished loading, and every height is measured from it.
  const probes = [
    [takeoffPoint[0], takeoffPoint[1], 0],
    ...refsPerPoint.flatMap((refs) => refs.map(([lon, lat]) => [lon, lat, 0])),
  ];
  const probedAll = await sampleTerrainForWaypoints(viewer, probes, settings.scanAltitudeM);
  const takeoffGroundNow = probedAll[0][2] - settings.scanAltitudeM;
  const probed = probedAll.slice(1);

  let probeIndex = 0;
  const sampled = scanPoints.map(([lon, lat], index) => {
    let highest = -Infinity;
    for (let read = 0; read < refsPerPoint[index].length; read++) {
      highest = Math.max(highest, probed[probeIndex][2]);
      probeIndex++;
    }
    return [lon, lat, Number.isFinite(highest) ? highest : settings.scanAltitudeM];
  });

  // Whatever is still a spike is smoothed along its own run.
  let spikesFixed = 0;
  let smoothOffset = 0;
  for (const path of paths) {
    const slice = sampled.slice(smoothOffset, smoothOffset + path.points.length);
    const { heights, fixed } = withoutSpikes(slice.map((point) => point[2]));
    heights.forEach((height, index) => {
      sampled[smoothOffset + index][2] = height;
    });
    // Last, so that smoothing cannot move them apart again: a point off the end
    // of a row is flown at the height of the barcode it leads into or out of.
    path.heightFrom.forEach((source, index) => {
      if (source !== null) sampled[smoothOffset + index][2] = sampled[smoothOffset + source][2];
    });
    spikesFixed += fixed;
    smoothOffset += path.points.length;
  }

  const current = findMission(missionId);
  if (!current?.barcode) throw new Error('The mission no longer exists.');
  if (barcodeRouteKey(current) !== key) throw new Error('Settings changed while the terrain was sampled. Generate again.');

  const coordinates: number[][] = [];
  const pointKinds: WaypointKind[] = [];
  /** Legs that fly straight into the next run instead of climbing over. */
  const linkLegs: number[] = [];
  const push = (lon: number, lat: number, altitude: number, kind: WaypointKind = 'transit') => {
    const rounded = Math.round(altitude * 100) / 100;
    const last = coordinates[coordinates.length - 1];
    // A safe jump of 0 would repeat the point it starts from.
    if (last && last[0] === lon && last[1] === lat && Math.abs(last[2] - rounded) < 0.01) return;
    coordinates.push([lon, lat, rounded]);
    pointKinds.push(kind);
  };

  const [takeoffLon, takeoffLat] = takeoffPoint;
  const takeoffGround = takeoffGroundNow;

  // Panels hundreds of metres from the takeoff point mean the terrain was not
  // the same for both, and the exported heights would be nonsense.
  const scanGrounds = sampled.map((point) => point[2] - settings.scanAltitudeM).sort((a, b) => a - b);
  const middleGround = scanGrounds[Math.floor(scanGrounds.length / 2)];
  if (Math.abs(middleGround - takeoffGround) > TERRAIN_MISMATCH_M) {
    throw new Error(
      `The terrain under the panels reads ${middleGround.toFixed(0)} m and the takeoff point ${takeoffGround.toFixed(0)} m. ` +
        'Wait until the site terrain or DSM has finished loading, then generate again.'
    );
  }
  let offset = 0;
  paths.forEach((path, index) => {
    // Heights were read and smoothed over every point of the line; Manual
    // position only leaves some of them out of the route afterwards, so the
    // ones that stay carry the height they would have had anyway.
    const scan = sampled
      .slice(offset, offset + path.points.length)
      .filter((_, pointIndex) => path.flown[pointIndex]);
    offset += path.points.length;
    const start = scan[0];

    if (index === 0) {
      // With the takeoff point left out the route begins at the first barcode:
      // DJI takes the aircraft up to the safe takeoff height and over to it by
      // itself, so nothing of the climb is lost with these two waypoints.
      if (!settings.excludeTakeoffPoint) {
        // Safe takeoff is kept over the takeoff point and over the first barcode:
        // the aircraft climbs, crosses at that height and drops onto the barcode.
        // It applies to this leg whatever the safe jump is.
        const firstGround = start[2] - settings.scanAltitudeM;
        const level = Math.max(takeoffGround, firstGround) + settings.safeTakeoffM;
        const takeoff = [takeoffLon, takeoffLat];
        push(takeoffLon, takeoffLat, level);
        // The whole safe takeoff height is lost on this one leg, so the descent
        // starts as far back as it is high: a slope the aircraft can fly, not a
        // plunge on the spot. The leg to the takeoff point is long enough for it.
        const descent = Math.min(
          Math.max(VERTICAL_STEP_M, level - start[2]),
          metresBetween(start, takeoff) / 3
        );
        const [downLon, downLat] = stepTowards(start, takeoff, descent);
        push(downLon, downLat, level);
      }
    } else if (flyOn(path) || metresBetween(coordinates[coordinates.length - 1], start) < MIN_JUMP_GAP_M) {
      // Straight into the next run: the leg from the last barcode flown.
      if (coordinates.length > 0) linkLegs.push(coordinates.length - 1);
    } else {
      const last = coordinates[coordinates.length - 1];
      const level = Math.max(last[2], start[2]) + settings.safeJumpM;
      // The climb and the descent each take a third of the jump at most, so
      // they keep their own leg and still cannot run into one another.
      const step = Math.min(VERTICAL_STEP_M, metresBetween(last, start) / 3);
      const [upLon, upLat] = stepTowards(last, start, step);
      push(upLon, upLat, level);
      const [downLon, downLat] = stepTowards(start, last, step);
      push(downLon, downLat, level);
    }
    scan.forEach(([lon, lat, altitude]) => push(lon, lat, altitude, 'barcode'));
  });
  // The closing climb carries on in the direction of the last leg flown,
  // for the same reason: a waypoint on top of another one is not flyable.
  const last = coordinates[coordinates.length - 1];
  const previous = coordinates[coordinates.length - 2];
  const ahead = previous
    ? [last[0] * 2 - previous[0], last[1] * 2 - previous[1]]
    : [takeoffLon, takeoffLat];
  const [outLon, outLat] = stepTowards(last, ahead, VERTICAL_STEP_M);
  push(outLon, outLat, last[2] + settings.safeJumpM);

  useMissionStore.getState().updateMission(missionId, {
    flightLines: [{ id: BARCODE_ROUTE_LINE_ID, coordinates, photoPoints: [], pointKinds, linkLegs }],
    barcode: { ...current.barcode, scan: { ...current.barcode.scan, routeKey: key } },
    // Heights are exported against this ground, so it must be what they were
    // measured from, not what the terrain said when the point was clicked.
    ...(Math.abs(takeoffGround - takeoffPoint[2]) > 0.05
      ? { takeoffPoint: [takeoffPoint[0], takeoffPoint[1], Math.round(takeoffGround * 100) / 100] }
      : {}),
  });

  const takeoffMoved = Math.abs(takeoffGround - takeoffPoint[2]) > 0.05;
  const straightOn = paths.filter((path, index) => index > 0 && flyOn(path)).length;
  const barcodes = paths.reduce((sum, path) => sum + path.barcodes, 0);
  const leads = paths.reduce((sum, path) => sum + path.leads, 0);
  const allScan = paths.reduce((sum, path) => sum + path.points.length, 0) - leads;
  const flownScan = paths.reduce((sum, path) => sum + path.flown.filter(Boolean).length, 0) - leads;
  const shared = barcodes - (paths.reduce((sum, path) => sum + path.points.length, 0) - leads);
  const skipped = settings.tables.length - paths.length;
  return (
    `Route generated: ${paths.length} ${paths.length === 1 ? 'table' : 'tables'}, ` +
    `${barcodes.toLocaleString()} barcodes from ${flownScan.toLocaleString()}${
      flownScan < allScan ? ` of ${allScan.toLocaleString()}` : ''
    } scan points` +
    (shared > 0 ? ` (${shared.toLocaleString()} close pairs scanned from their midpoint)` : '') +
    (leads > 0 ? `, ${leads.toLocaleString()} lead-in and lead-out points` : '') +
    `, ${coordinates.length.toLocaleString()} waypoints` +
    (straightOn > 0 ? `, ${straightOn} table${straightOn === 1 ? '' : 's'} entered straight on` : '') +
    (spikesFixed > 0 ? `, ${spikesFixed} height${spikesFixed === 1 ? '' : 's'} corrected` : '') +
    (takeoffMoved ? `. Takeoff ground re-read as ${takeoffGround.toFixed(1)} m` : '') +
    (skipped > 0 ? ` (${skipped} selected ${skipped === 1 ? 'table' : 'tables'} not found)` : '')
  );
};
