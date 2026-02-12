/**
 * KML/KMZ Parser and Importer
 * Handles parsing and importing KML/KMZ files for area of interest definition
 */

import JSZip from 'jszip';

export interface KMLPolygon {
  name: string;
  coordinates: number[][]; // [lon, lat, alt][]
  description?: string;
}

/**
 * Parse KML XML and extract polygon geometries
 * @param kmlText - KML XML text content
 * @returns Array of polygon objects
 */
export const parseKML = (kmlText: string): KMLPolygon[] => {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(kmlText, 'text/xml');
  
  // Check for parsing errors
  const parserError = xmlDoc.querySelector('parsererror');
  if (parserError) {
    throw new Error('Invalid KML file: ' + parserError.textContent);
  }
  
  const polygons: KMLPolygon[] = [];
  
  // Find all Placemark elements with Polygon geometries
  const placemarks = xmlDoc.querySelectorAll('Placemark');
  
  placemarks.forEach((placemark) => {
    // Get name
    const nameElement = placemark.querySelector('name');
    const name = nameElement?.textContent || 'Unnamed Area';
    
    // Get description
    const descElement = placemark.querySelector('description');
    const description = descElement?.textContent || undefined;
    
    // Find Polygon element
    const polygon = placemark.querySelector('Polygon');
    if (!polygon) return;
    
    // Get outer boundary coordinates
    const outerBoundary = polygon.querySelector('outerBoundaryIs coordinates, Polygon coordinates');
    if (!outerBoundary) return;
    
    const coordsText = outerBoundary.textContent?.trim();
    if (!coordsText) return;
    
    // Parse coordinates
    // KML format: "lon,lat,alt lon,lat,alt ..." (space or newline separated)
    const coordinates = coordsText
      .split(/\s+/)
      .filter((coord) => coord.length > 0)
      .map((coord) => {
        const parts = coord.split(',').map(parseFloat);
        // Return [lon, lat, alt] - if no altitude, use 0
        return [parts[0], parts[1], parts[2] || 0];
      })
      .filter((coord) => !isNaN(coord[0]) && !isNaN(coord[1]));
    
    if (coordinates.length >= 3) {
      polygons.push({
        name,
        coordinates,
        description,
      });
    }
  });
  
  return polygons;
};

/**
 * Parse KMZ file (zipped KML)
 * @param file - KMZ file object
 * @returns Array of polygon objects
 */
export const parseKMZ = async (file: File): Promise<KMLPolygon[]> => {
  try {
    const zip = new JSZip();
    const zipContent = await zip.loadAsync(file);
    
    // Find KML file in the archive (usually doc.kml or *.kml)
    let kmlFile = zipContent.file('doc.kml');
    
    if (!kmlFile) {
      // Look for any .kml file
      const kmlFiles = Object.keys(zipContent.files).filter((name) =>
        name.toLowerCase().endsWith('.kml')
      );
      
      if (kmlFiles.length === 0) {
        throw new Error('No KML file found in KMZ archive');
      }
      
      kmlFile = zipContent.file(kmlFiles[0]);
    }
    
    if (!kmlFile) {
      throw new Error('Could not read KML file from KMZ');
    }
    
    const kmlText = await kmlFile.async('text');
    return parseKML(kmlText);
  } catch (error) {
    throw new Error('Failed to parse KMZ file: ' + (error as Error).message);
  }
};

/**
 * Import KML/KMZ file and return parsed polygons
 * @param file - KML or KMZ file
 * @returns Array of polygon objects
 */
export const importKMLFile = async (file: File): Promise<KMLPolygon[]> => {
  const fileName = file.name.toLowerCase();
  
  if (fileName.endsWith('.kmz')) {
    return parseKMZ(file);
  } else if (fileName.endsWith('.kml')) {
    const text = await file.text();
    return parseKML(text);
  } else {
    throw new Error('File must be a .kml or .kmz file');
  }
};

/**
 * Calculate the center point of a polygon
 * @param coordinates - Array of [lon, lat, alt] coordinates
 * @returns Center point [lon, lat]
 */
export const calculatePolygonCenter = (coordinates: number[][]): [number, number] => {
  let sumLon = 0;
  let sumLat = 0;
  
  coordinates.forEach(([lon, lat]) => {
    sumLon += lon;
    sumLat += lat;
  });
  
  return [sumLon / coordinates.length, sumLat / coordinates.length];
};

/**
 * Calculate the area of a polygon in square meters (approximate)
 * Uses simplified spherical earth model
 * @param coordinates - Array of [lon, lat] coordinates
 * @returns Area in square meters
 */
export const calculatePolygonArea = (coordinates: number[][]): number => {
  if (coordinates.length < 3) return 0;
  
  const R = 6378137; // Earth's radius in meters
  let area = 0;
  
  for (let i = 0; i < coordinates.length - 1; i++) {
    const [lon1, lat1] = coordinates[i];
    const [lon2, lat2] = coordinates[i + 1];
    
    const lat1Rad = (lat1 * Math.PI) / 180;
    const lat2Rad = (lat2 * Math.PI) / 180;
    const lonDiff = ((lon2 - lon1) * Math.PI) / 180;
    
    area += lonDiff * (2 + Math.sin(lat1Rad) + Math.sin(lat2Rad));
  }
  
  area = Math.abs((area * R * R) / 2);
  return area;
};
