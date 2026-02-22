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

  // ── Reference point: polygon lon/lat centroid ───────────────────────────
  const [minLon, minLat, maxLon, maxLat] = calculateBBox(polygon);
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;

  // ── Metric scale factors at the reference latitude ───────────────────────
  // Longitude and latitude degrees represent different real-world distances,
  // especially pronounced at high latitudes (e.g. 1° lon ≈ 69 km at 51°N vs
  // 1° lat ≈ 111 km). All geometry must be done in metres, not in raw degrees.
  const latRad = (centerLat * Math.PI) / 180;
  const M_PER_DEG_LAT = 111320;                          // metres per degree latitude
  const M_PER_DEG_LON = 111320 * Math.cos(latRad);       // metres per degree longitude

  // ── Convert polygon to local East-North metric frame (metres from centre) ─
  const metricPolygon = polygon.map(
    ([lon, lat]): [number, number] => [
      (lon - centerLon) * M_PER_DEG_LON,   // East  (x)
      (lat - centerLat) * M_PER_DEG_LAT,   // North (y)
    ]
  );

  // ── Flight-angle convention ──────────────────────────────────────────────
  // UI: 0° = North, 90° = East (clockwise from North)
  // Math: 0° = +X (East), angles counterclockwise-positive
  const normalizedFlightAngle = ((flightAngle % 360) + 360) % 360;
  const mathAngle = 90 - normalizedFlightAngle;

  // ── Rotate metric polygon to align with flight direction ─────────────────
  // In the rotated frame, flight lines run along X and are swept along Y.
  const ZERO: [number, number] = [0, 0];
  const rotatedMetric = metricPolygon.map((pt) => rotatePoint(pt, ZERO, -mathAngle));

  const [rxMin, ryMin, rxMax, ryMax] = calculateBBox(rotatedMetric);

  // ── Number of parallel lines to cover the scan extent ────────────────────
  const scanHeight = ryMax - ryMin;   // metres in cross-track direction
  const numLines = Math.ceil(scanHeight / lineSpacing) + 1;

  console.log('Line calculation (metric):', { scanHeight, lineSpacing, numLines });

  const lines: FlightLine[] = [];
  let totalDistance = 0;
  let totalWaypoints = 0;
  let totalPhotos = 0;
  let waypointIndex = 0;

  // Boundary nudge (metres): prevents scan lines that coincide exactly with a
  // polygon edge from being silently discarded by the ray-cast clipper.
  const BOUNDARY_NUDGE = lineSpacing * 0.001;

  for (let i = 0; i < numLines; i++) {
    let y = ryMin + i * lineSpacing;

    // Nudge lines that land exactly on the top/bottom boundary inward.
    // This prevents scan lines from being placed at a polygon vertex (corner),
    // which would cause clipLineToPolygon to return a degenerate zero-length
    // segment whose endpoint is the polygon corner — appearing as the "S" marker.
    if (Math.abs(y - ryMax) < BOUNDARY_NUDGE) {
      y = ryMax - BOUNDARY_NUDGE;
    } else if (Math.abs(y - ryMin) < BOUNDARY_NUDGE) {
      y = ryMin + BOUNDARY_NUDGE;
    }

    // Horizontal scan line extending well beyond the polygon in X (metres)
    const lineStart: [number, number] = [rxMin - 500, y];
    const lineEnd:   [number, number] = [rxMax + 500, y];

    const clipped = clipLineToPolygon(lineStart, lineEnd, rotatedMetric);

    if (clipped.length < 2) continue;

    // Rotate back to metric East-North frame
    let [startM, endM] = clipped.map((pt) => rotatePoint(pt, ZERO, mathAngle));

    // Serpentine (alternate direction)
    if (lines.length % 2 === 1) {
      [startM, endM] = [endM, startM];
    }

    // ── Line length in metres ─────────────────────────────────────────────
    const dx = endM[0] - startM[0];
    const dy = endM[1] - startM[1];
    const lineLength = Math.sqrt(dx * dx + dy * dy);

    // Skip degenerate lines (clipping at a polygon vertex yields zero-length).
    if (lineLength < 1) continue;

    // ── Convert endpoints back to lon/lat ─────────────────────────────────
    const toLonLat = (pt: [number, number]): [number, number] => [
      centerLon + pt[0] / M_PER_DEG_LON,
      centerLat + pt[1] / M_PER_DEG_LAT,
    ];
    const startLL = toLonLat(startM);
    const endLL   = toLonLat(endM);

    // ── Waypoints along the line ──────────────────────────────────────────
    const waypoints: Waypoint[] = [];
    const photoDistance = speed * photoInterval;   // metres between photos
    const numPhotos = Math.ceil(lineLength / photoDistance);

    for (let j = 0; j <= numPhotos; j++) {
      const t = j / numPhotos;
      waypoints.push({
        lon:   startLL[0] + t * (endLL[0] - startLL[0]),
        lat:   startLL[1] + t * (endLL[1] - startLL[1]),
        alt:   altitude,
        index: waypointIndex++,
        action: j < numPhotos ? 'photo' : undefined,
        speed,
      });
    }

    lines.push({ id: `line-${i}`, waypoints, length: lineLength });
    totalDistance   += lineLength;
    totalWaypoints  += waypoints.length;
    totalPhotos     += numPhotos;
  }

  console.log(`Generated ${lines.length} lines with ${totalWaypoints} waypoints and ${totalPhotos} photos`);

  return { lines, totalDistance, numWaypoints: totalWaypoints, numPhotos: totalPhotos };
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
