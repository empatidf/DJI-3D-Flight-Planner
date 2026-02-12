/**
 * GeoTIFF Parser
 * Reads GeoTIFF files and extracts georeferencing information
 */

import { fromArrayBuffer } from 'geotiff';
import { transformCoordinate } from './coordinate-transform';

export interface GeoTiffInfo {
  fileName: string;
  width: number;
  height: number;
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  boundsWGS84: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  epsg: string;
  projection: string;
  origin: [number, number];
  pixelScale: [number, number];
  hasGeoData: boolean;
}

/**
 * Parse GeoTIFF file and extract georeferencing information
 */
export const parseGeoTiff = async (file: File): Promise<GeoTiffInfo> => {
  try {
    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    
    // Parse GeoTIFF
    const tiff = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    
    // Get image dimensions
    const width = image.getWidth();
    const height = image.getHeight();
    
    // Get georeferencing data
    const geoKeys = image.getGeoKeys();
    const fileDirectory = image.fileDirectory;
    
    // Extract EPSG code
    let epsgCode = 'EPSG:4326'; // Default to WGS84
    if (geoKeys.ProjectedCSTypeGeoKey) {
      epsgCode = `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
    } else if (geoKeys.GeographicTypeGeoKey) {
      epsgCode = `EPSG:${geoKeys.GeographicTypeGeoKey}`;
    }
    
    // Get bounding box from GeoTIFF metadata
    const bbox = image.getBoundingBox();
    
    // ModelTiePoint and ModelPixelScale (common GeoTIFF tags)
    const modelTiepoint = fileDirectory.ModelTiepoint || [];
    const modelPixelScale = fileDirectory.ModelPixelScale || [1, 1, 0];
    
    let bounds = {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    };
    
    let hasGeoData = false;
    
    if (bbox && bbox.length === 4) {
      // BoundingBox available
      bounds = {
        minX: bbox[0],
        minY: bbox[1],
        maxX: bbox[2],
        maxY: bbox[3],
      };
      hasGeoData = true;
    } else if (modelTiepoint.length >= 6) {
      // Calculate from tiepoint and pixel scale
      const originX = modelTiepoint[3];
      const originY = modelTiepoint[4];
      const pixelWidth = modelPixelScale[0];
      const pixelHeight = modelPixelScale[1];
      
      bounds = {
        minX: originX,
        minY: originY - (height * pixelHeight),
        maxX: originX + (width * pixelWidth),
        maxY: originY,
      };
      hasGeoData = true;
    }
    
    // Transform bounds to WGS84
    let boundsWGS84 = {
      minLon: bounds.minX,
      minLat: bounds.minY,
      maxLon: bounds.maxX,
      maxLat: bounds.maxY,
    };
    
    if (hasGeoData && epsgCode !== 'EPSG:4326') {
      try {
        const sw = transformCoordinate([bounds.minX, bounds.minY], epsgCode, 'EPSG:4326');
        const ne = transformCoordinate([bounds.maxX, bounds.maxY], epsgCode, 'EPSG:4326');
        
        if (sw.success && ne.success) {
          boundsWGS84 = {
            minLon: sw.coordinates[0],
            minLat: sw.coordinates[1],
            maxLon: ne.coordinates[0],
            maxLat: ne.coordinates[1],
          };
        }
      } catch (error) {
        console.warn('Failed to transform coordinates:', error);
      }
    }
    
    return {
      fileName: file.name,
      width,
      height,
      bounds,
      boundsWGS84,
      epsg: epsgCode,
      projection: epsgCode === 'EPSG:4326' ? 'WGS84 (Geographic)' : `Projected (${epsgCode})`,
      origin: [modelTiepoint[3] || 0, modelTiepoint[4] || 0],
      pixelScale: [modelPixelScale[0], modelPixelScale[1]],
      hasGeoData,
    };
  } catch (error) {
    throw new Error(`Failed to parse GeoTIFF: ${(error as Error).message}`);
  }
};

/**
 * Get center point of GeoTIFF
 */
export const getGeoTiffCenter = (info: GeoTiffInfo): [number, number] => {
  return [
    (info.boundsWGS84.minLon + info.boundsWGS84.maxLon) / 2,
    (info.boundsWGS84.minLat + info.boundsWGS84.maxLat) / 2,
  ];
};
