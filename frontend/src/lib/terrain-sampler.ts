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
 * Get viewer instance from global window object
 * @returns Cesium Viewer instance or null
 */
export const getCesiumViewer = (): Viewer | null => {
  // @ts-ignore - accessing global viewer
  return window.cesiumViewer || null;
};
