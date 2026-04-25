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

    // Update waypoints with terrain-following altitudes
    const updatedWaypoints = sampledPositions.map((pos, index) => {
      const terrainHeight = defined(pos.height) ? pos.height : 0;
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
 * @returns Array of [lon, lat, absoluteAltitude] including start and end
 */
export const terrainFollowSubSample = async (
  viewer: Viewer,
  startLon: number,
  startLat: number,
  endLon: number,
  endLat: number,
  aglAltitude: number,
  accuracyM: number
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
  const result: number[][] = [];

  // Always include the first point
  result.push([
    probePositions[0].lon,
    probePositions[0].lat,
    probeHeights[0] + aglAltitude,
  ]);

  let lastEmittedHeight = probeHeights[0];

  for (let i = 1; i < probePositions.length - 1; i++) {
    const heightDelta = Math.abs(probeHeights[i] - lastEmittedHeight);
    if (heightDelta >= accuracyM) {
      result.push([
        probePositions[i].lon,
        probePositions[i].lat,
        probeHeights[i] + aglAltitude,
      ]);
      lastEmittedHeight = probeHeights[i];
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
 * @returns New waypoint array with sub-waypoints inserted for terrain following
 */
export const sampleTerrainWithSubPoints = async (
  viewer: Viewer,
  waypoints: number[][],
  aglAltitude: number,
  accuracyM: number
): Promise<number[][]> => {
  console.log('=== TERRAIN FOLLOW SUB-SAMPLING START ===');
  console.log(`Input waypoints: ${waypoints.length}, AGL: ${aglAltitude}m, accuracy: ${accuracyM}m`);

  const terrainProvider = viewer.terrainProvider;

  // Check if terrain is available
  if (!terrainProvider || terrainProvider.constructor.name === 'EllipsoidTerrainProvider') {
    console.warn('No terrain data available - falling back to standard sampling');
    return sampleTerrainForWaypoints(viewer, waypoints, aglAltitude);
  }

  if (waypoints.length < 2) {
    return sampleTerrainForWaypoints(viewer, waypoints, aglAltitude);
  }

  try {
    const allPoints: number[][] = [];

    for (let i = 0; i < waypoints.length - 1; i++) {
      const [lon1, lat1] = waypoints[i];
      const [lon2, lat2] = waypoints[i + 1];

      const segmentPoints = await terrainFollowSubSample(
        viewer,
        lon1, lat1,
        lon2, lat2,
        aglAltitude,
        accuracyM
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

/**
 * Get viewer instance from global window object
 * @returns Cesium Viewer instance or null
 */
export const getCesiumViewer = (): Viewer | null => {
  // @ts-ignore - accessing global viewer
  return window.cesiumViewer || null;
};
