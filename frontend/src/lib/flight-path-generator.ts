/**
 * Flight Path Generation
 * Generates flight lines and waypoints for photogrammetry missions
 */

import { calculateDistance } from './coordinate-transform';

export interface Waypoint {
  lon: number;
  lat: number;
  alt: number; // meters AGL
  index: number;
  action?: 'photo' | 'turn';
  heading?: number; // degrees
  speed?: number; // m/s
}

export interface FlightLine {
  id: string;
  waypoints: Waypoint[];
  length: number; // meters
}

export interface FlightPlan {
  lines: FlightLine[];
  totalDistance: number; // meters
  numWaypoints: number;
  numPhotos: number;
}

/**
 * Calculate the bounding box of a polygon
 */
const calculateBBox = (polygon: number[][]): [number, number, number, number] => {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  
  polygon.forEach(([lon, lat]) => {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  });
  
  return [minLon, minLat, maxLon, maxLat];
};

/**
 * Rotate a point around a center point
 */
const rotatePoint = (
  point: [number, number],
  center: [number, number],
  angleDeg: number
): [number, number] => {
  const angleRad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  
  const dx = point[0] - center[0];
  const dy = point[1] - center[1];
  
  const rotatedX = dx * cos - dy * sin + center[0];
  const rotatedY = dx * sin + dy * cos + center[1];
  
  return [rotatedX, rotatedY];
};

/**
 * Check if a point is inside a polygon
 */
const isPointInPolygon = (point: [number, number], polygon: number[][]): boolean => {
  const [x, y] = point;
  let inside = false;
  
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    
    if (intersect) inside = !inside;
  }
  
  return inside;
};

/**
 * Calculate intersection point between two line segments
 */
const lineIntersection = (
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number]
): [number, number] | null => {
  const x1 = p1[0], y1 = p1[1];
  const x2 = p2[0], y2 = p2[1];
  const x3 = p3[0], y3 = p3[1];
  const x4 = p4[0], y4 = p4[1];
  
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-10) return null; // Parallel lines
  
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
  
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  }
  
  return null;
};

/**
 * Clip a line segment to a polygon boundary
 * Finds intersection points with polygon edges
 */
const clipLineToPolygon = (
  start: [number, number],
  end: [number, number],
  polygon: number[][]
): [number, number][] => {
  const startInside = isPointInPolygon(start, polygon);
  const endInside = isPointInPolygon(end, polygon);
  
  // Both inside - keep entire line
  if (startInside && endInside) {
    return [start, end];
  }
  
  // Find all intersection points with polygon edges
  const intersections: [number, number][] = [];
  
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    const edgeStart: [number, number] = [polygon[i][0], polygon[i][1]];
    const edgeEnd: [number, number] = [polygon[j][0], polygon[j][1]];
    
    const intersection = lineIntersection(start, end, edgeStart, edgeEnd);
    if (intersection) {
      intersections.push(intersection);
    }
  }
  
  // No intersections and both outside - line doesn't cross polygon
  if (intersections.length === 0) {
    return [];
  }
  
  // Add endpoints if they're inside
  const points: [number, number][] = [];
  if (startInside) points.push(start);
  points.push(...intersections);
  if (endInside) points.push(end);
  
  // If we have at least 2 points, we have a valid line segment
  if (points.length >= 2) {
    // Sort points along the line direction
    points.sort((a, b) => {
      const distA = Math.hypot(a[0] - start[0], a[1] - start[1]);
      const distB = Math.hypot(b[0] - start[0], b[1] - start[1]);
      return distA - distB;
    });
    
    // Return first and last point (entry and exit from polygon)
    return [points[0], points[points.length - 1]];
  }
  
  return [];
};

/**
 * Generate parallel flight lines for a polygon area
 * @param polygon - AOI polygon coordinates [[lon, lat], ...]
 * @param lineSpacing - Distance between flight lines in meters
 * @param flightAngle - Flight line angle in degrees (0 = North, 90 = East)
 * @param altitude - Flight altitude in meters AGL
 * @param photoInterval - Photo interval in seconds
 * @param speed - Flight speed in m/s
 * @returns Flight plan with lines and waypoints
 */
export const generateFlightLines = (
  polygon: number[][],
  lineSpacing: number,
  flightAngle: number,
  altitude: number,
  photoInterval: number,
  speed: number
): FlightPlan => {
  console.log('generateFlightLines called with:', { polygon: polygon.length + ' coords', lineSpacing, flightAngle, altitude, photoInterval, speed });
  
  if (polygon.length < 3) {
    throw new Error('Polygon must have at least 3 points');
  }
  
  // Calculate bounding box
  const [minLon, minLat, maxLon, maxLat] = calculateBBox(polygon);
  const center: [number, number] = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  
  console.log('Bounding box:', { minLon, minLat, maxLon, maxLat, center });
  
  // Rotate everything to align with flight angle
  const rotatedPolygon = polygon.map((point) =>
    rotatePoint([point[0], point[1]], center, -flightAngle)
  );
  
  const [rotMinLon, rotMinLat, rotMaxLon, rotMaxLat] = calculateBBox(rotatedPolygon);
  
  // Calculate number of lines needed
  const scanHeight = rotMaxLat - rotMinLat;
  
  // Convert line spacing from meters to degrees (approximate at this latitude)
  const metersPerDegree = 111320 * Math.cos((center[1] * Math.PI) / 180);
  const lineSpacingDegrees = lineSpacing / metersPerDegree;
  
  const numLines = Math.ceil(scanHeight / lineSpacingDegrees) + 1;
  
  console.log('Line calculation:', { scanHeight, metersPerDegree, lineSpacingDegrees, numLines });
  
  const lines: FlightLine[] = [];
  let totalDistance = 0;
  let totalWaypoints = 0;
  let totalPhotos = 0;
  let waypointIndex = 0;
  
  console.log(`Generating ${numLines} flight lines...`);
  
  // Generate parallel lines
  for (let i = 0; i < numLines; i++) {
    const y = rotMinLat + i * lineSpacingDegrees;
    
    // Create line segment
    const lineStart: [number, number] = [rotMinLon - 0.001, y];
    const lineEnd: [number, number] = [rotMaxLon + 0.001, y];
    
    // Clip to polygon
    const clippedPoints = clipLineToPolygon(lineStart, lineEnd, rotatedPolygon);
    
    if (i < 2) {
      console.log(`Line ${i}: start=${lineStart}, end=${lineEnd}, clipped=${clippedPoints.length} points`, clippedPoints);
    }
    
    if (clippedPoints.length < 2) continue;
    
    // Rotate back to original orientation
    let [start, end] = clippedPoints.map((point) =>
      rotatePoint(point, center, flightAngle)
    );
    
    // Alternate direction for serpentine pattern
    if (i % 2 === 1) {
      [start, end] = [end, start];
    }
    
    // Calculate line length
    const lineLength = calculateDistance(start, end);
    
    // Generate waypoints along the line
    const waypoints: Waypoint[] = [];
    const photoDistance = speed * photoInterval; // meters between photos
    const numPhotos = Math.ceil(lineLength / photoDistance);
    
    for (let j = 0; j <= numPhotos; j++) {
      const t = j / numPhotos;
      const lon = start[0] + t * (end[0] - start[0]);
      const lat = start[1] + t * (end[1] - start[1]);
      
      waypoints.push({
        lon,
        lat,
        alt: altitude,
        index: waypointIndex++,
        action: j < numPhotos ? 'photo' : undefined,
        speed,
      });
    }
    
    lines.push({
      id: `line-${i}`,
      waypoints,
      length: lineLength,
    });
    
    totalDistance += lineLength;
    totalWaypoints += waypoints.length;
    totalPhotos += numPhotos;
  }
  
  console.log(`Generated ${lines.length} lines with ${totalWaypoints} waypoints and ${totalPhotos} photos`);
  
  return {
    lines,
    totalDistance,
    numWaypoints: totalWaypoints,
    numPhotos: totalPhotos,
  };
};

/**
 * Calculate total mission distance including turns
 */
export const calculateMissionDistance = (flightPlan: FlightPlan): number => {
  let distance = flightPlan.totalDistance;
  
  // Add distance for turns between lines
  for (let i = 0; i < flightPlan.lines.length - 1; i++) {
    const currentLine = flightPlan.lines[i];
    const nextLine = flightPlan.lines[i + 1];
    
    const lastWaypoint = currentLine.waypoints[currentLine.waypoints.length - 1];
    const firstWaypoint = nextLine.waypoints[0];
    
    const turnDistance = calculateDistance(
      [lastWaypoint.lon, lastWaypoint.lat],
      [firstWaypoint.lon, firstWaypoint.lat]
    );
    
    distance += turnDistance;
  }
  
  return distance;
};

/**
 * Add terrain following to flight plan
 * @param flightPlan - Original flight plan
 * @param elevationData - Elevation values for each waypoint
 * @param aglAltitude - Desired altitude above ground level
 * @returns Updated flight plan with terrain-following altitudes
 */
export const applyTerrainFollowing = (
  flightPlan: FlightPlan,
  elevationData: number[],
  aglAltitude: number
): FlightPlan => {
  let elevationIndex = 0;
  
  const updatedLines = flightPlan.lines.map((line) => {
    const updatedWaypoints = line.waypoints.map((waypoint) => {
      const groundElevation = elevationData[elevationIndex++] || 0;
      return {
        ...waypoint,
        alt: aglAltitude + groundElevation,
      };
    });
    
    return {
      ...line,
      waypoints: updatedWaypoints,
    };
  });
  
  return {
    ...flightPlan,
    lines: updatedLines,
  };
};
