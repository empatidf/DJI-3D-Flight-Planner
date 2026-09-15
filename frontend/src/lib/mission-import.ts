/**
 * Putting imported or drawn geometry into an existing mission.
 *
 * Shared by the New Mission wizard and the Flight Planning panel's "Replace from
 * KML" buttons. A mission's type is fixed when it is created, so these helpers
 * never change it: an area mission only ever receives a polygon, a waypoint
 * mission only ever receives a route.
 */

import { useMissionStore, type FlightParameters, type Mission } from '../stores/mission-store';
import { DEFAULT_PANEL_STYLE, type PanelBounds, type ParsedPanelLayout } from './barcode-panels';
import { calculatePolygonArea, type KMLPolygon, type KMLWaypointSet } from './kml-parser';
import { getCesiumViewer, sampleTerrainForWaypoints, sampleTerrainWithSubPoints } from './terrain-sampler';

type RouteSamplingParameters = Pick<
  FlightParameters,
  'altitude' | 'alwaysTerrainFollow' | 'terrainFollowAccuracy' | 'terrainFollowMinDist' | 'terrainFollowSkipPoints'
>;

const isClosedRing = (coordinates: number[][]) => {
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  return coordinates.length > 1 && first[0] === last[0] && first[1] === last[1];
};

/** calculatePolygonArea expects a closed ring; drawn polygons are open. */
export const polygonAreaM2 = (coordinates: number[][]) => {
  if (coordinates.length < 3) return 0;
  return calculatePolygonArea(isClosedRing(coordinates) ? coordinates : [...coordinates, coordinates[0]]);
};

export const formatArea = (squareMeters: number) =>
  squareMeters >= 10000
    ? `${(squareMeters / 10000).toFixed(2)} ha`
    : `${Math.round(squareMeters).toLocaleString()} m²`;

export const describePolygon = (polygon: Pick<KMLPolygon, 'coordinates'>) => {
  const corners = polygon.coordinates.length - (isClosedRing(polygon.coordinates) ? 1 : 0);
  return `${corners} corners · ${formatArea(polygonAreaM2(polygon.coordinates))}`;
};

const GEOMETRY_LABEL: Record<Mission['missionType'], string> = {
  area: 'an area',
  waypoint: 'a waypoint route',
  barcode: 'a panel layout',
};

const requireMission = (missionId: string, type: Mission['missionType']) => {
  const mission = useMissionStore.getState().missions.find((item) => item.id === missionId);
  if (!mission) throw new Error('The mission no longer exists');
  if (mission.missionType !== type) {
    throw new Error(`This ${mission.missionType} mission cannot take ${GEOMETRY_LABEL[type]}`);
  }
  return mission;
};

/** Nadir view over the geometry, far enough out to see all of it. */
const flyToCoordinates = (coordinates: number[][], minAltitude: number) => {
  const valid = coordinates.filter((coord) => Number.isFinite(coord[0]) && Number.isFinite(coord[1]));
  if (valid.length === 0) return;

  const lons = valid.map((coord) => coord[0]);
  const lats = valid.map((coord) => coord[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const span = Math.max(maxLon - minLon, maxLat - minLat);

  useMissionStore.getState().setCameraTarget({
    longitude: (minLon + maxLon) / 2,
    latitude: (minLat + maxLat) / 2,
    altitude: Math.max(span * 100000, minAltitude),
    heading: 0,
    pitch: -90,
    roll: 0,
  });
};

/**
 * Set the mission's area. The generated route and the takeoff point belonged to
 * the old area, so both are cleared, and the map waits for a new takeoff point.
 */
export const applyAreaPolygon = (missionId: string, polygon: KMLPolygon): string => {
  requireMission(missionId, 'area');
  const store = useMissionStore.getState();

  store.updateMission(missionId, {
    aoi: { type: 'kml', coordinates: polygon.coordinates, name: polygon.name },
    flightLines: [],
    takeoffPoint: null,
  });

  flyToCoordinates(polygon.coordinates, 1000);
  store.setAddTakeoffPointMode(true);

  return `Area imported: ${polygon.name} — click the map to set the takeoff point`;
};

/** Set the mission's route, placed at the mission altitude above the terrain. */
export const applyWaypointRoute = async (
  missionId: string,
  route: KMLWaypointSet,
  parameters: RouteSamplingParameters
): Promise<string> => {
  requireMission(missionId, 'waypoint');
  if (route.coordinates.length < 2) throw new Error('A waypoint route needs at least 2 points');

  const { altitude } = parameters;
  // Leading transit points keep the altitude from the file; the rest get the
  // AGL placeholder that terrain sampling turns into terrain height + AGL.
  const skipPoints = Math.max(0, Math.floor(parameters.terrainFollowSkipPoints ?? 0));
  const baseWaypoints = route.coordinates.map((coord, index) =>
    index < skipPoints
      ? [coord[0], coord[1], Number.isFinite(coord[2]) ? coord[2] : altitude]
      : [coord[0], coord[1], altitude]
  );

  const viewer = getCesiumViewer();
  let coordinates: number[][];
  if (viewer && parameters.alwaysTerrainFollow) {
    coordinates = await sampleTerrainWithSubPoints(
      viewer,
      baseWaypoints,
      altitude,
      parameters.terrainFollowAccuracy,
      parameters.terrainFollowMinDist,
      skipPoints
    );
  } else if (viewer) {
    coordinates = await sampleTerrainForWaypoints(viewer, baseWaypoints, altitude);
  } else {
    coordinates = baseWaypoints;
  }

  // The mission may have been deleted or retyped while terrain was sampling.
  requireMission(missionId, 'waypoint');
  useMissionStore.getState().updateMission(missionId, {
    flightLines: [{ id: 'waypoint-import-0', coordinates, photoPoints: [] }],
  });

  flyToCoordinates(route.coordinates, 800);

  return `Waypoint route imported: ${route.coordinates.length} points`;
};

export const flyToBounds = (bounds: PanelBounds) =>
  flyToCoordinates(
    [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ],
    250
  );

/**
 * Set a Barcode Scan mission's panel layout. The display style and scan
 * settings survive a re-import; the table selection and the route belonged
 * to the old panels and are cleared.
 */
export const applyBarcodePanels = (missionId: string, fileName: string, layout: ParsedPanelLayout): string => {
  const mission = requireMission(missionId, 'barcode');
  const scan = mission.barcode?.scan;

  useMissionStore.getState().updateMission(missionId, {
    flightLines: [],
    barcode: {
      sourceFileName: fileName,
      panelCount: layout.panelCount,
      corners: layout.corners,
      names: layout.names,
      bounds: layout.bounds,
      panelSize: layout.panelSize,
      structure: layout.structure,
      label: mission.barcode?.label,
      scan: scan && { ...scan, tables: undefined, routeKey: undefined },
      style: { ...DEFAULT_PANEL_STYLE, ...mission.barcode?.style },
    },
  });

  flyToBounds(layout.bounds);

  const skipped = layout.skipped > 0 ? ` (${layout.skipped.toLocaleString()} other shapes skipped)` : '';
  return `${layout.panelCount.toLocaleString()} panels imported${skipped}`;
};
