/**
 * Coordinate Transformation Utilities
 * Handles coordinate reprojection using proj4js
 */

import proj4 from 'proj4';

// Define common coordinate reference systems
// WGS84 (EPSG:4326) - Used by Cesium and GPS
proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs +type=crs');

// Web Mercator (EPSG:3857) - Used by many web maps
proj4.defs(
  'EPSG:3857',
  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs'
);

// UTM Zone examples (can be extended as needed)
// UTM Zone 33N (EPSG:32633) - Central Europe
proj4.defs(
  'EPSG:32633',
  '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs +type=crs'
);

// UTM Zone 10N (EPSG:32610) - US West Coast
proj4.defs(
  'EPSG:32610',
  '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs +type=crs'
);

export interface TransformResult {
  coordinates: number[]; // [x/lon, y/lat] or [x/lon, y/lat, z]
  success: boolean;
  error?: string;
}

/**
 * Transform a single coordinate from source CRS to target CRS
 * @param coords - Input coordinates [x, y] or [x, y, z]
 * @param sourceCRS - Source coordinate reference system (e.g., 'EPSG:4326')
 * @param targetCRS - Target coordinate reference system (e.g., 'EPSG:3857')
 * @returns Transformed coordinates
 */
export const transformCoordinate = (
  coords: number[],
  sourceCRS: string,
  targetCRS: string
): TransformResult => {
  try {
    // If same CRS, return as-is
    if (sourceCRS === targetCRS) {
      return {
        coordinates: coords,
        success: true,
      };
    }

    // Transform the coordinate
    const result = proj4(sourceCRS, targetCRS, coords);

    // Handle 2D and 3D coordinates
    if (coords.length === 3) {
      return {
        coordinates: [result[0], result[1], coords[2]], // Preserve altitude
        success: true,
      };
    }

    return {
      coordinates: result,
      success: true,
    };
  } catch (error) {
    return {
      coordinates: coords,
      success: false,
      error: (error as Error).message,
    };
  }
};

/**
 * Transform multiple coordinates at once
 * @param coordsList - Array of coordinates
 * @param sourceCRS - Source CRS
 * @param targetCRS - Target CRS
 * @returns Array of transformed coordinates
 */
export const transformCoordinates = (
  coordsList: number[][],
  sourceCRS: string,
  targetCRS: string
): number[][] => {
  return coordsList.map((coords) => {
    const result = transformCoordinate(coords, sourceCRS, targetCRS);
    return result.success ? result.coordinates : coords;
  });
};

/**
 * Transform coordinates to WGS84 (EPSG:4326) for Cesium
 * @param coords - Input coordinates
 * @param sourceCRS - Source CRS
 * @returns Coordinates in WGS84
 */
export const transformToWGS84 = (
  coords: number[][],
  sourceCRS: string
): number[][] => {
  return transformCoordinates(coords, sourceCRS, 'EPSG:4326');
};

/**
 * Register a custom CRS definition
 * @param code - EPSG code (e.g., 'EPSG:32633')
 * @param proj4String - Proj4 definition string
 */
export const registerCRS = (code: string, proj4String: string): void => {
  proj4.defs(code, proj4String);
};

/**
 * Detect UTM zone from longitude
 * @param longitude - Longitude in degrees
 * @returns UTM zone number
 */
export const getUTMZone = (longitude: number): number => {
  return Math.floor((longitude + 180) / 6) + 1;
};

/**
 * Get EPSG code for UTM zone
 * @param zone - UTM zone number (1-60)
 * @param isNorthern - True for northern hemisphere, false for southern
 * @returns EPSG code string
 */
export const getUTMEPSG = (zone: number, isNorthern: boolean = true): string => {
  const base = isNorthern ? 32600 : 32700;
  return `EPSG:${base + zone}`;
};

/**
 * Auto-detect and register UTM zone for given coordinates
 * @param lon - Longitude
 * @param lat - Latitude
 * @returns EPSG code of the UTM zone
 */
export const autoDetectUTM = (lon: number, lat: number): string => {
  const zone = getUTMZone(lon);
  const isNorthern = lat >= 0;
  const epsg = getUTMEPSG(zone, isNorthern);
  
  // Register if not already defined
  if (!proj4.defs(epsg)) {
    const hemisphere = isNorthern ? '+north' : '+south';
    proj4.defs(
      epsg,
      `+proj=utm +zone=${zone} ${hemisphere} +datum=WGS84 +units=m +no_defs +type=crs`
    );
  }
  
  return epsg;
};

/**
 * Calculate distance between two WGS84 coordinates in meters
 * Uses Haversine formula
 * @param coord1 - [lon, lat]
 * @param coord2 - [lon, lat]
 * @returns Distance in meters
 */
export const calculateDistance = (coord1: number[], coord2: number[]): number => {
  const R = 6371000; // Earth's radius in meters
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  
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
