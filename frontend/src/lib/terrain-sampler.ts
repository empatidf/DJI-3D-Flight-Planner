/**
 * Terrain Sampling Utilities
 * Samples terrain elevation at waypoints for terrain-following missions
 */

import { sampleTerrainMostDetailed, Cartographic, defined } from 'cesium';
import type { Viewer } from 'cesium';

export interface WaypointPosition {
  lon: number;
  lat: number;
  alt: number;
}

/**
 * Decimate terrain-following waypoints by an elevation-difference threshold.
 *
 * Walks along the line and keeps a point only if its altitude differs from the
 * last KEPT point by at least `toleranceM`. Comparing against the last kept point
 * (rather than the immediate neighbour) bounds the cumulative terrain error to the
 * tolerance, so flat stretches collapse to few points while slopes stay dense.
 * Altitude = terrainHeight + constant AGL per line, so the altitude delta equals
 * the terrain-elevation delta. The first and last points are always kept to
 * preserve the line geometry.
 *
 * @param waypoints  - Terrain-following waypoints [[lon, lat, alt], ...]
 * @param toleranceM - Elevation-difference threshold in meters
 * @returns Indices (into `waypoints`) of the points to keep
 */
export const decimateByElevationTolerance = (
  waypoints: number[][],
  toleranceM: number
): number[] => {
  if (waypoints.length <= 2 || !(toleranceM > 0)) {
    return waypoints.map((_, i) => i);
  }

  const kept = [0];
  let lastAlt = waypoints[0][2];

  for (let i = 1; i < waypoints.length - 1; i++) {
    if (Math.abs(waypoints[i][2] - lastAlt) >= toleranceM) {
      kept.push(i);
      lastAlt = waypoints[i][2];
    }
  }

  kept.push(waypoints.length - 1);
  return kept;
};

/**
 * Sample terrain elevation at waypoint positions and adjust altitudes for terrain-following
 * @param viewer - Cesium viewer instance
 * @param waypoints - Array of waypoint coordinates [lon, lat, alt]
 * @param aglAltitude - Desired altitude Above Ground Level in meters
 * @returns Updated waypoints with terrain-following altitudes
 */
export const sampleTerrainForWaypoints = async (
  viewer: Viewer,
  waypoints: number[][],
  aglAltitude: number
): Promise<number[][]> => {
  console.log('=== TERRAIN SAMPLING START ===');
  console.log(`Sampling terrain for ${waypoints.length} waypoints`);
  console.log(`Target AGL altitude: ${aglAltitude}m`);
  console.log(`Terrain provider:`, viewer.terrainProvider);

  const terrainProvider = viewer.terrainProvider;
  
  // Check if terrain is available
  if (!terrainProvider || terrainProvider.constructor.name === 'EllipsoidTerrainProvider') {
    console.warn('No terrain data available - using constant altitude');
    return waypoints.map(wp => [wp[0], wp[1], aglAltitude]);
  }

  try {
    // Convert waypoints to Cartographic positions (lon, lat in radians)
    const positions = waypoints.map(wp => 
      Cartographic.fromDegrees(wp[0], wp[1], 0)
    );

    console.log(`Sampling terrain at ${positions.length} positions...`);
    
    // Sample terrain heights
    const sampledPositions = await sampleTerrainMostDetailed(terrainProvider, positions);

    console.log('Terrain sampling complete');

    // A point OUTSIDE the active terrain layer's (e.g. DSM) coverage comes back with
    // height 0 — sampleTerrainMostDetailed leaves the input height (0) untouched. Using
    // that 0 would drop the waypoint to ~sea level (0 + AGL), far below the base map, and
    // if it's the first point it corrupts every DJI relative height. So treat 0/non-finite
    // as "no data" and fall back to the base globe terrain, then to the mean of valid
    // samples — the point stays on the ground instead of sinking.
    const isValidTerrain = (h: number | undefined): h is number =>
      defined(h) && Number.isFinite(h) && h !== 0;
    const validHeights = sampledPositions.map((p) => p.height).filter(isValidTerrain);
    const meanHeight = validHeights.length
      ? validHeights.reduce((sum, h) => sum + h, 0) / validHeights.length
      : 0;

    // Update waypoints with terrain-following altitudes
    const updatedWaypoints = sampledPositions.map((pos, index) => {
      let terrainHeight = isValidTerrain(pos.height) ? pos.height : NaN;
      if (!Number.isFinite(terrainHeight)) {
        const globeHeight = viewer.scene.globe.getHeight(
          Cartographic.fromDegrees(waypoints[index][0], waypoints[index][1])
        );
        terrainHeight = isValidTerrain(globeHeight) ? globeHeight : meanHeight;
      }
      const absoluteAltitude = terrainHeight + aglAltitude;

      if (index < 3) {
        console.log(`Waypoint ${index}: terrain=${terrainHeight.toFixed(2)}m, AGL=${aglAltitude}m, abs=${absoluteAltitude.toFixed(2)}m`);
      }

      return [
        waypoints[index][0], // lon
        waypoints[index][1], // lat
        absoluteAltitude      // terrain + AGL altitude
      ];
    });

    const avgTerrain = sampledPositions.reduce((sum, pos) => sum + (defined(pos.height) ? pos.height : 0), 0) / sampledPositions.length;
    const minTerrain = Math.min(...sampledPositions.map(pos => defined(pos.height) ? pos.height : 0));
    const maxTerrain = Math.max(...sampledPositions.map(pos => defined(pos.height) ? pos.height : 0));
    
    console.log('Terrain statistics:');
    console.log(`  Average: ${avgTerrain.toFixed(2)}m`);
    console.log(`  Min: ${minTerrain.toFixed(2)}m`);
    console.log(`  Max: ${maxTerrain.toFixed(2)}m`);
    console.log(`  Range: ${(maxTerrain - minTerrain).toFixed(2)}m`);
    console.log('=== TERRAIN SAMPLING COMPLETE ===');

    return updatedWaypoints;
  } catch (error) {
    console.error('Terrain sampling failed:', error);
    console.warn('Falling back to constant altitude');
    return waypoints.map(wp => [wp[0], wp[1], aglAltitude]);
  }
};

/**
 * Calculate the Haversine distance between two lon/lat points in meters
 */
const haversineDistance = (lon1: number, lat1: number, lon2: number, lat2: number): number => {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

/**
 * Interpolate a point between two lon/lat positions at fraction t (0..1)
 */
const interpolatePosition = (
  lon1: number, lat1: number,
  lon2: number, lat2: number,
  t: number
): [number, number] => {
  return [
    lon1 + t * (lon2 - lon1),
    lat1 + t * (lat2 - lat1),
  ];
};

/**
 * Terrain-follow sub-sampling for a segment between two waypoints.
 *
 * Algorithm:
 * 1. Densely sample terrain elevation along the segment at a fixed probe interval
 *    (default ~10 m or at least 50 probes, whichever is finer).
 * 2. Walk through the sampled elevations and emit a sub-waypoint whenever the
 *    cumulative elevation change since the last emitted point exceeds the
 *    user-defined accuracy threshold.
 * 3. Always include the start and end points of the segment.
 *
 * This ensures the drone follows the real terrain profile with the requested
 * accuracy, inserting sub-waypoints only where the terrain actually changes.
 *
 * @param viewer       - Cesium Viewer (for terrain provider)
 * @param startLon     - Segment start longitude (degrees)
 * @param startLat     - Segment start latitude (degrees)
 * @param endLon       - Segment end longitude (degrees)
 * @param endLat       - Segment end latitude (degrees)
 * @param aglAltitude  - Desired altitude above ground level (meters)
 * @param accuracyM    - Elevation change threshold for inserting sub-waypoints (meters)
 * @param minDistM     - Minimum horizontal distance (meters) between consecutive sub-waypoints
 * @returns Array of [lon, lat, absoluteAltitude] including start and end
 */
export const terrainFollowSubSample = async (
  viewer: Viewer,
  startLon: number,
  startLat: number,
  endLon: number,
  endLat: number,
  aglAltitude: number,
  accuracyM: number,
  minDistM: number = 2
): Promise<number[][]> => {
  const terrainProvider = viewer.terrainProvider;
  const segmentDist = haversineDistance(startLon, startLat, endLon, endLat);

  // For very short segments (< 2 m), just sample start and end
  if (segmentDist < 2) {
    const positions = [
      Cartographic.fromDegrees(startLon, startLat, 0),
      Cartographic.fromDegrees(endLon, endLat, 0),
    ];
    const sampled = await sampleTerrainMostDetailed(terrainProvider, positions);
    return [
      [startLon, startLat, (defined(sampled[0].height) ? sampled[0].height : 0) + aglAltitude],
      [endLon, endLat, (defined(sampled[1].height) ? sampled[1].height : 0) + aglAltitude],
    ];
  }

  // Determine probe spacing: at most every 10 m, but at least 50 probes per segment,
  // capped at 500 probes to avoid excessive API calls.
  const PROBE_INTERVAL = 10; // meters
  const minProbes = 50;
  const maxProbes = 500;
  let numProbes = Math.max(minProbes, Math.ceil(segmentDist / PROBE_INTERVAL));
  numProbes = Math.min(numProbes, maxProbes);

  // Generate evenly-spaced probe positions along the segment
  const probePositions: { lon: number; lat: number; t: number }[] = [];
  for (let i = 0; i <= numProbes; i++) {
    const t = i / numProbes;
    const [lon, lat] = interpolatePosition(startLon, startLat, endLon, endLat, t);
    probePositions.push({ lon, lat, t });
  }

  // Sample terrain at all probe positions in one batch
  const cartographics = probePositions.map((p) => Cartographic.fromDegrees(p.lon, p.lat, 0));
  const sampledPositions = await sampleTerrainMostDetailed(terrainProvider, cartographics);

  // Extract terrain heights
  const probeHeights = sampledPositions.map((pos) => (defined(pos.height) ? pos.height : 0));

  // Walk through probes and emit sub-waypoints where elevation change exceeds threshold
  // AND horizontal distance from the last emitted point is at least minDistM.
  const result: number[][] = [];

  // Always include the first point
  result.push([
    probePositions[0].lon,
    probePositions[0].lat,
    probeHeights[0] + aglAltitude,
  ]);

  let lastEmittedHeight = probeHeights[0];
  let lastEmittedLon = probePositions[0].lon;
  let lastEmittedLat = probePositions[0].lat;

  for (let i = 1; i < probePositions.length - 1; i++) {
    const heightDelta = Math.abs(probeHeights[i] - lastEmittedHeight);
    // Distance from the PREVIOUS kept point (a prior sub-point or the segment start).
    const distFromLast = haversineDistance(lastEmittedLon, lastEmittedLat, probePositions[i].lon, probePositions[i].lat);
    // Distance to the NEXT original waypoint (segment end), which is always kept.
    // Without this check a sub-point can land right next to an existing waypoint,
    // producing two points closer than minDistM — which DJI Pilot 2 rejects.
    const distToEnd = haversineDistance(probePositions[i].lon, probePositions[i].lat, endLon, endLat);
    if (heightDelta >= accuracyM && distFromLast >= minDistM && distToEnd >= minDistM) {
      result.push([
        probePositions[i].lon,
        probePositions[i].lat,
        probeHeights[i] + aglAltitude,
      ]);
      lastEmittedHeight = probeHeights[i];
      lastEmittedLon = probePositions[i].lon;
      lastEmittedLat = probePositions[i].lat;
    }
  }

  // Always include the last point
  const lastIdx = probePositions.length - 1;
  result.push([
    probePositions[lastIdx].lon,
    probePositions[lastIdx].lat,
    probeHeights[lastIdx] + aglAltitude,
  ]);

  return result;
};

/**
 * Apply terrain-follow sub-sampling to an entire waypoint route.
 *
 * For each consecutive pair of waypoints, runs terrainFollowSubSample to
 * densely probe the terrain and insert sub-waypoints where elevation changes
 * exceed the accuracy threshold. The result is a new waypoint array that
 * faithfully follows the terrain surface.
 *
 * @param viewer       - Cesium Viewer instance
 * @param waypoints    - Original waypoints [[lon, lat, alt], ...]
 * @param aglAltitude  - Desired AGL altitude in meters
 * @param accuracyM    - Elevation change threshold in meters
 * @param minDistM     - Minimum horizontal distance (meters) between consecutive sub-waypoints
 * @param skipPoints   - Leading waypoints to leave untouched (e.g. the transit leg before the site)
 * @returns New waypoint array with sub-waypoints inserted for terrain following
 */
export const sampleTerrainWithSubPoints = async (
  viewer: Viewer,
  waypoints: number[][],
  aglAltitude: number,
  accuracyM: number,
  minDistM: number = 2,
  skipPoints: number = 0
): Promise<number[][]> => {
  console.log('=== TERRAIN FOLLOW SUB-SAMPLING START ===');
  console.log(`Input waypoints: ${waypoints.length}, AGL: ${aglAltitude}m, accuracy: ${accuracyM}m, minDist: ${minDistM}m, skip: ${skipPoints}`);

  const terrainProvider = viewer.terrainProvider;

  // Check if terrain is available
  if (!terrainProvider || terrainProvider.constructor.name === 'EllipsoidTerrainProvider') {
    console.warn('No terrain data available - falling back to standard sampling');
    return sampleTerrainForWaypoints(viewer, waypoints, aglAltitude);
  }

  if (waypoints.length < 2) {
    return sampleTerrainForWaypoints(viewer, waypoints, aglAltitude);
  }

  // Leave the first N waypoints (transit leg) untouched; terrain-follow only the rest.
  const skip = Math.min(Math.max(0, Math.floor(skipPoints)), Math.max(0, waypoints.length - 2));
  const head = skip > 0 ? waypoints.slice(0, skip) : [];
  const work = skip > 0 ? waypoints.slice(skip) : waypoints;

  try {
    const allPoints: number[][] = [...head];

    for (let i = 0; i < work.length - 1; i++) {
      const [lon1, lat1] = work[i];
      const [lon2, lat2] = work[i + 1];

      const segmentPoints = await terrainFollowSubSample(
        viewer,
        lon1, lat1,
        lon2, lat2,
        aglAltitude,
        accuracyM,
        minDistM
      );

      // Add all points from this segment, but skip the first point of subsequent
      // segments to avoid duplicating the shared endpoint
      if (i === 0) {
        allPoints.push(...segmentPoints);
      } else {
        allPoints.push(...segmentPoints.slice(1));
      }
    }

    console.log(`Terrain follow result: ${waypoints.length} original → ${allPoints.length} waypoints`);
    console.log('=== TERRAIN FOLLOW SUB-SAMPLING COMPLETE ===');

    return allPoints;
  } catch (error) {
    console.error('Terrain follow sub-sampling failed:', error);
    console.warn('Falling back to standard terrain sampling');
    return sampleTerrainForWaypoints(viewer, waypoints, aglAltitude);
  }
};

export interface CollisionRiskResult {
  segments: number[][][]; // each = [[lon,lat,alt], ...] a red sub-polyline over a risky stretch
  riskyStationCount: number;
  totalStations: number;
  effIntervalM: number; // actual along-line spacing used (may be widened from the request)
}

/**
 * Analyse collision risk of a flight line against terrain.
 *
 * The drone's safety envelope at each point is the LOWER HALF of a sphere of
 * radius `thresholdM`: terrain in any horizontal direction (front, back, left,
 * right, down) within that radius is a collision — including obstacles that rise
 * ABOVE the drone, because such a column pierces the drone's altitude plane and
 * therefore enters the lower hemisphere.
 *
 * Implementation: a corridor grid is sampled around the line — evenly spaced
 * stations along the path × a set of lateral lanes (±½R, ±R perpendicular to
 * travel) — so terrain to the sides is covered, not just the centreline. Terrain
 * height is sampled in chunks (progress-reported, UI-friendly). For each drone
 * station we test every grid sample within `thresholdM`: the vertical gap is
 * CLAMPED to ≥0 (`max(0, droneAlt − terrainHeight)`) so a column taller than the
 * drone counts as terrain at the drone's own altitude. Total samples are capped
 * at `maxProbes`; the along-line spacing is widened only if that cap is hit.
 *
 * @param viewer         - Cesium Viewer (terrain provider)
 * @param lineCoordinates- The yellow line [[lon,lat,alt], ...] at absolute altitudes
 * @param thresholdM     - Minimum safe clearance / sphere radius in metres
 * @param intervalM      - Requested along-line sample spacing in metres
 * @param maxProbes      - Cap on total terrain samples (stations × lanes)
 * @param fallbackAltitude - Altitude to use where a coordinate has no valid height
 * @param skipPoints     - Number of leading waypoints to skip (e.g. long transit to the site)
 * @param onProgress     - Optional 0..1 progress callback (reports terrain-sampling progress)
 * @returns Red sub-polylines for the risky stretches (min 1 m each) plus counts
 */
export const analyzeCollisionRisk = async (
  viewer: Viewer,
  lineCoordinates: number[][],
  thresholdM: number,
  intervalM: number,
  maxProbes = 400000,
  fallbackAltitude = 0,
  skipPoints = 0,
  onProgress?: (fraction: number) => void
): Promise<CollisionRiskResult> => {
  const empty: CollisionRiskResult = { segments: [], riskyStationCount: 0, totalStations: 0, effIntervalM: 0 };

  const validated = lineCoordinates
    .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map((c) => [c[0], c[1], Number.isFinite(c[2]) ? c[2] : fallbackAltitude] as number[]);
  // Skip the first N waypoints (transit leg) before analysing
  const coords = validated.slice(Math.max(0, Math.floor(skipPoints)));
  if (coords.length < 2) {
    onProgress?.(1);
    return empty;
  }

  // Cumulative horizontal distance at each vertex
  const cum: number[] = [0];
  for (let k = 0; k < coords.length - 1; k++) {
    const d = haversineDistance(coords[k][0], coords[k][1], coords[k + 1][0], coords[k + 1][1]);
    cum.push(cum[k] + d);
  }
  const totalLength = cum[cum.length - 1];
  if (!(totalLength > 0)) return empty;

  const R = Math.max(0.01, thresholdM);

  // Lateral lanes perpendicular to travel: 0, ±R/2, ±R → covers the corridor width.
  const laneStep = R / 2;
  const laneOffsets: number[] = [];
  for (let k = -2; k <= 2; k++) laneOffsets.push(k * laneStep);
  const nLanes = laneOffsets.length;

  // Along-line spacing must not exceed the clearance R, or detection windows leave
  // gaps between them. Honour a finer requested interval, but never a coarser one.
  // Widen only if the total (stations × lanes) would still exceed maxProbes.
  let effInterval = Math.max(0.05, Math.min(intervalM, R));
  let nA = Math.max(2, Math.floor(totalLength / effInterval) + 1);
  if (nA * nLanes > maxProbes) {
    nA = Math.max(2, Math.floor(maxProbes / nLanes));
    effInterval = totalLength / (nA - 1);
  }

  // Interpolate a [lon,lat,alt] point at a given arc length along the line.
  const pointAtArcLength = (s: number): number[] => {
    if (s <= 0) return [...coords[0]];
    if (s >= totalLength) return [...coords[coords.length - 1]];
    let k = 0;
    while (k < cum.length - 1 && cum[k + 1] < s) k++;
    const f = (s - cum[k]) / (cum[k + 1] - cum[k] || 1);
    return [
      coords[k][0] + f * (coords[k + 1][0] - coords[k][0]),
      coords[k][1] + f * (coords[k + 1][1] - coords[k][1]),
      coords[k][2] + f * (coords[k + 1][2] - coords[k][2]),
    ];
  };

  // Unit tangent (east, north) at a given arc length, from the segment it lies on.
  const tangentAtArcLength = (s: number): [number, number] => {
    let k = 0;
    while (k < cum.length - 2 && cum[k + 1] < s) k++;
    const lat = coords[k][1];
    const dE = (coords[k + 1][0] - coords[k][0]) * Math.cos((lat * Math.PI) / 180) * 111320;
    const dN = (coords[k + 1][1] - coords[k][1]) * 111320;
    const len = Math.hypot(dE, dN) || 1;
    return [dE / len, dN / len];
  };

  // Build corridor stations (centre + tangent) evenly spaced along the path.
  const stations = Array.from({ length: nA }, (_, i) => {
    const s = Math.min(totalLength, i * effInterval);
    const p = pointAtArcLength(s);
    const [tE, tN] = tangentAtArcLength(s);
    return { s, lon: p[0], lat: p[1], alt: p[2], tE, tN };
  });

  // Offset a station laterally (perpendicular to travel) by `o` metres → [lon,lat].
  const lateralPoint = (st: { lon: number; lat: number; tE: number; tN: number }, o: number): [number, number] => {
    // Perpendicular to (tE, tN) is (-tN, tE)
    const offE = -st.tN * o;
    const offN = st.tE * o;
    const dLon = offE / (Math.cos((st.lat * Math.PI) / 180) * 111320);
    const dLat = offN / 111320;
    return [st.lon + dLon, st.lat + dLat];
  };

  // Sample terrain over the whole corridor grid (stations × lanes), in chunks.
  const terrainProvider = viewer.terrainProvider;
  const gridHeights = new Array<number>(nA * nLanes).fill(0);
  const hasTerrain = !!terrainProvider && terrainProvider.constructor.name !== 'EllipsoidTerrainProvider';

  if (hasTerrain) {
    const cartographics = [];
    for (let i = 0; i < nA; i++) {
      for (let l = 0; l < nLanes; l++) {
        const [lon, lat] = lateralPoint(stations[i], laneOffsets[l]);
        cartographics.push(Cartographic.fromDegrees(lon, lat, 0));
      }
    }
    const CHUNK = 1000;
    for (let start = 0; start < cartographics.length; start += CHUNK) {
      const chunk = cartographics.slice(start, start + CHUNK);
      const sampled = await sampleTerrainMostDetailed(terrainProvider, chunk);
      for (let m = 0; m < sampled.length; m++) {
        gridHeights[start + m] = defined(sampled[m].height) ? sampled[m].height : 0;
      }
      onProgress?.(Math.min(1, (start + chunk.length) / cartographics.length));
    }
  } else {
    onProgress?.(1);
  }

  // Flag each drone station whose lower half-sphere (radius R) intersects terrain.
  const risky = new Array<boolean>(nA).fill(false);
  const win = Math.max(1, Math.ceil(R / effInterval));
  for (let i = 0; i < nA; i++) {
    const droneAlt = stations[i].alt;
    let hit = false;
    for (let a = Math.max(0, i - win); a <= Math.min(nA - 1, i + win) && !hit; a++) {
      const dAlong = (i - a) * effInterval;
      for (let l = 0; l < nLanes; l++) {
        const o = laneOffsets[l];
        const horiz = Math.hypot(dAlong, o); // 360° horizontal distance from the drone
        if (horiz > R) continue;
        // Clamp vertical to ≥0: a column above the drone counts at the drone's level.
        const vert = Math.max(0, droneAlt - gridHeights[a * nLanes + l]);
        if (Math.hypot(horiz, vert) <= R) {
          hit = true;
          break;
        }
      }
    }
    risky[i] = hit;
  }

  const riskyStationCount = risky.reduce((sum, r) => sum + (r ? 1 : 0), 0);
  if (riskyStationCount === 0) {
    return { segments: [], riskyStationCount: 0, totalStations: nA, effIntervalM: effInterval };
  }

  // Group consecutive risky stations into red sub-polylines (min 1 m each)
  const segments: number[][][] = [];
  const flushRun = (a: number, b: number) => {
    let sStart = stations[a].s;
    let sEnd = stations[b].s;
    if (sEnd - sStart < 1) {
      const mid = (sStart + sEnd) / 2;
      sStart = Math.max(0, mid - 0.5);
      sEnd = Math.min(totalLength, mid + 0.5);
    }
    const seg: number[][] = [pointAtArcLength(sStart)];
    for (let k = a; k <= b; k++) {
      if (stations[k].s > sStart && stations[k].s < sEnd) {
        seg.push([stations[k].lon, stations[k].lat, stations[k].alt]);
      }
    }
    seg.push(pointAtArcLength(sEnd));
    segments.push(seg);
  };

  let runStart = -1;
  for (let i = 0; i < nA; i++) {
    if (risky[i] && runStart === -1) runStart = i;
    if ((!risky[i] || i === nA - 1) && runStart !== -1) {
      flushRun(runStart, risky[i] ? i : i - 1);
      runStart = -1;
    }
  }

  return { segments, riskyStationCount, totalStations: nA, effIntervalM: effInterval };
};

/**
 * Get viewer instance from global window object
 * @returns Cesium Viewer instance or null
 */
export const getCesiumViewer = (): Viewer | null => {
  // @ts-ignore - accessing global viewer
  return window.cesiumViewer || null;
};

/**
 * Terrain elevation under a lon/lat, read from the already-loaded globe tiles.
 * Returns null when no viewer exists or the tile is not loaded yet.
 */
export const getTerrainHeightAtDegrees = (lon: number, lat: number): number | null => {
  const viewer = getCesiumViewer();
  if (!viewer) return null;

  const height = viewer.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat));
  return typeof height === 'number' && Number.isFinite(height) ? height : null;
};
