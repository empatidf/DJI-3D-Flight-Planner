"""
Terrain Processor Module
Converts GeoTIFF DEM/DSM files to Cesium-compatible formats
and provides elevation sampling capabilities
"""

import os
import json
from typing import List, Tuple, Dict, Any
import numpy as np

try:
    import rasterio
    from rasterio.warp import calculate_default_transform, reproject, Resampling
    from rasterio.crs import CRS
    RASTERIO_AVAILABLE = True
except ImportError:
    RASTERIO_AVAILABLE = False


def convert_geotiff_to_tiles(
    input_path: str,
    output_dir: str,
    terrain_id: str
) -> Dict[str, Any]:
    """
    Convert a GeoTIFF file to terrain tiles for Cesium
    
    For now, this is a simplified version that:
    1. Reprojects to EPSG:4326 if needed
    2. Stores metadata for elevation sampling
    3. Returns tileset information
    
    Full 3D Tiles conversion would require additional tools like:
    - cesium-terrain-builder
    - py3dtiles
    - GDAL with advanced tiling
    
    Args:
        input_path: Path to input GeoTIFF file
        output_dir: Output directory for tiles
        terrain_id: Unique identifier for this terrain
    
    Returns:
        Dictionary with terrain information and bounds
    """
    if not RASTERIO_AVAILABLE:
        raise RuntimeError("rasterio is not installed. Please install GDAL and rasterio.")
    
    os.makedirs(output_dir, exist_ok=True)
    
    with rasterio.open(input_path) as src:
        # Get source bounds and CRS
        bounds = src.bounds
        src_crs = src.crs
        
        # Reproject to EPSG:4326 if needed
        dst_crs = CRS.from_epsg(4326)
        
        if src_crs != dst_crs:
            # Calculate transform for reprojection
            transform, width, height = calculate_default_transform(
                src_crs, dst_crs, src.width, src.height, *bounds
            )
            
            # Set up reprojected output
            kwargs = src.meta.copy()
            kwargs.update({
                'crs': dst_crs,
                'transform': transform,
                'width': width,
                'height': height
            })
            
            # Reproject and save
            output_path = os.path.join(output_dir, "source.tif")
            with rasterio.open(output_path, 'w', **kwargs) as dst:
                for i in range(1, src.count + 1):
                    reproject(
                        source=rasterio.band(src, i),
                        destination=rasterio.band(dst, i),
                        src_transform=src.transform,
                        src_crs=src_crs,
                        dst_transform=transform,
                        dst_crs=dst_crs,
                        resampling=Resampling.bilinear
                    )
                
                # Update bounds to reprojected bounds
                bounds = dst.bounds
        else:
            # Just copy if already in EPSG:4326
            output_path = os.path.join(output_dir, "source.tif")
            with rasterio.open(output_path, 'w', **src.meta) as dst:
                dst.write(src.read())
        
        # Create tileset metadata
        tileset = {
            "terrain_id": terrain_id,
            "bounds": {
                "west": bounds.left,
                "south": bounds.bottom,
                "east": bounds.right,
                "north": bounds.top
            },
            "crs": "EPSG:4326",
            "source_file": output_path
        }
        
        # Save tileset metadata
        with open(os.path.join(output_dir, "tileset.json"), 'w') as f:
            json.dump(tileset, f, indent=2)
        
        return tileset


def sample_elevations(
    terrain_path: str,
    coordinates: List[Tuple[float, float]]
) -> List[float]:
    """
    Sample elevation values from a terrain GeoTIFF at given coordinates
    
    Args:
        terrain_path: Path to the terrain GeoTIFF file
        coordinates: List of (lon, lat) tuples in EPSG:4326
    
    Returns:
        List of elevation values in meters (or nodata value if outside bounds)
    """
    if not RASTERIO_AVAILABLE:
        raise RuntimeError("rasterio is not installed")
    
    elevations = []
    
    with rasterio.open(terrain_path) as src:
        for lon, lat in coordinates:
            try:
                # Convert geographic coordinates to pixel coordinates
                row, col = src.index(lon, lat)
                
                # Check if within bounds
                if 0 <= row < src.height and 0 <= col < src.width:
                    # Read the elevation value
                    value = src.read(1)[row, col]
                    
                    # Check for nodata
                    if src.nodata is not None and value == src.nodata:
                        elevations.append(0.0)
                    else:
                        elevations.append(float(value))
                else:
                    # Outside bounds
                    elevations.append(0.0)
            except Exception:
                # Error sampling - return 0
                elevations.append(0.0)
    
    return elevations
