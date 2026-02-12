/**
 * Client-side GeoTIFF Tiler
 * Runs Python tiling script asynchronously via Node.js child process
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

export interface TileResult {
  bounds: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  epsg: number;
  tileSize: number;
  format: string;
}

/**
 * Generate tiles from GeoTIFF file
 * @param file File object from file input
 * @param layerId Unique layer identifier
 * @param layerType 'rgb' or 'dsm'
 * @returns Tiling result with bounds and tile info
 */
export async function generateTiles(
  file: File,
  layerId: string,
  layerType: 'rgb' | 'dsm' = 'rgb'
): Promise<TileResult> {
  // Save file to temp location
  const tempDir = path.join(process.cwd(), 'temp');
  const tempFilePath = path.join(tempDir, file.name);
  
  // Create temp directory if it doesn't exist
  await execAsync(`mkdir -p "${tempDir}"`);
  
  // Write file buffer to disk
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const fs = await import('fs/promises');
  await fs.writeFile(tempFilePath, buffer);
  
  try {
    // Run tiling worker
    const workerPath = path.join(process.cwd(), 'tile-worker.js');
    const { stdout } = await execAsync(
      `node "${workerPath}" tile "${tempFilePath}" "${layerId}" "${layerType}"`,
      { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer for large outputs
    );
    
    // Parse result from stdout
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse tiling result');
    }
    
    const result = JSON.parse(jsonMatch[0]) as TileResult;
    
    // Clean up temp file
    await fs.unlink(tempFilePath);
    
    return result;
  } catch (error) {
    // Clean up temp file on error
    try {
      const fs = await import('fs/promises');
      await fs.unlink(tempFilePath);
    } catch {}
    
    throw error;
  }
}

/**
 * Delete tiles for a layer
 * @param layerId Layer identifier
 */
export async function deleteTiles(layerId: string): Promise<void> {
  const workerPath = path.join(process.cwd(), 'tile-worker.js');
  await execAsync(`node "${workerPath}" delete "${layerId}"`);
}

/**
 * Get tile URL for Cesium UrlTemplateImageryProvider
 * @param layerId Layer identifier
 * @returns URL template with {z}/{x}/{y} placeholders
 */
export function getTileUrl(layerId: string): string {
  return `/tiles/${layerId}/{z}/{x}/{y}.png`;
}
