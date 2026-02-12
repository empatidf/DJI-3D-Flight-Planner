"""
Imagery Tiler - Generate web map tiles from GeoTIFF RGB/DSM imagery
Uses rasterio and PIL to create standard XYZ tile pyramid
"""

import os
import math
import json
import sys
from typing import Tuple, Dict
from PIL import Image
import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.windows import from_bounds
from rasterio.crs import CRS
import numpy as np


def latlon_to_tile(lat: float, lon: float, zoom: int) -> Tuple[int, int]:
    """Convert lat/lon to tile coordinates at given zoom level"""
    n = 2.0 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(math.radians(lat)) + 1.0 / math.cos(math.radians(lat))) / math.pi) / 2.0 * n)
    return (x, y)


def tile_to_latlon(x: int, y: int, zoom: int) -> Tuple[float, float, float, float]:
    """Convert tile coordinates to lat/lon bounding box"""
    n = 2.0 ** zoom
    lon_min = x / n * 360.0 - 180.0
    lat_max = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lon_max = (x + 1) / n * 360.0 - 180.0
    lat_min = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return (lon_min, lat_min, lon_max, lat_max)


def reproject_to_wgs84(input_path: str, output_path: str) -> Dict:
    """Reproject GeoTIFF to WGS84 if needed"""
    with rasterio.open(input_path) as src:
        src_crs = src.crs
        bounds = src.bounds
        
        # Check if already WGS84
        if src_crs and src_crs.to_epsg() == 4326:
            # Already WGS84, just copy
            with rasterio.open(output_path, 'w', **src.meta) as dst:
                for i in range(1, src.count + 1):
                    dst.write(src.read(i), i)
            
            return {
                'bounds': [bounds.left, bounds.bottom, bounds.right, bounds.top],
                'epsg': 4326,
                'width': src.width,
                'height': src.height
            }
        
        # Reproject to WGS84
        dst_crs = CRS.from_epsg(4326)
        transform, width, height = calculate_default_transform(
            src_crs, dst_crs, src.width, src.height, *bounds
        )
        
        kwargs = src.meta.copy()
        kwargs.update({
            'crs': dst_crs,
            'transform': transform,
            'width': width,
            'height': height
        })
        
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
        
        # Get new bounds
        with rasterio.open(output_path) as dst:
            new_bounds = dst.bounds
        
        return {
            'bounds': [new_bounds.left, new_bounds.bottom, new_bounds.right, new_bounds.top],
            'epsg': 4326,
            'width': width,
            'height': height
        }


def generate_tiles(input_path: str, output_dir: str, min_zoom: int = 12, max_zoom: int = 22) -> Dict:
    """
    Generate XYZ tiles from GeoTIFF
    Returns metadata about the generated tiles
    Generates tiles up to zoom 22 for maximum detail
    """
    os.makedirs(output_dir, exist_ok=True)
    
    # Reproject to WGS84 if needed
    wgs84_path = os.path.join(output_dir, "source_wgs84.tif")
    metadata = reproject_to_wgs84(input_path, wgs84_path)
    
    bounds = metadata['bounds']  # [minLon, minLat, maxLon, maxLat]
    
    # Open reprojected file
    with rasterio.open(wgs84_path) as src:
        # Determine optimal zoom levels based on image resolution
        # Calculate approximate meters per pixel at equator
        lon_range = bounds[2] - bounds[0]
        lat_range = bounds[3] - bounds[1]
        meters_per_degree = 111320  # at equator
        image_width_meters = lon_range * meters_per_degree * math.cos(math.radians((bounds[1] + bounds[3]) / 2))
        meters_per_pixel = image_width_meters / src.width
        
        # Web Mercator zoom levels: zoom 0 = 40075km/256px, each zoom doubles resolution
        # Calculate best max zoom where we have at least 1:1 pixel ratio
        optimal_max_zoom = int(math.log2(40075000 / (meters_per_pixel * 256)))
        
        # Generate tiles up to high zoom for maximum detail (up to zoom 22)
        # Add extra zoom levels for oversampling and smooth zooming
        actual_max_zoom = min(max_zoom, max(optimal_max_zoom + 4, 18))
        actual_min_zoom = max(min_zoom, actual_max_zoom - 8)  # Show at least 8 zoom levels
        
        print(f"Image resolution: {meters_per_pixel:.2f}m/px, Optimal zoom: {optimal_max_zoom}")
        print(f"Generating tiles zoom {actual_min_zoom}-{actual_max_zoom} for bounds {bounds}")
        
        # Calculate tile range for all zoom levels
        tile_count = 0
        for zoom in range(actual_min_zoom, actual_max_zoom + 1):
            x_min, y_max = latlon_to_tile(bounds[3], bounds[0], zoom)
            x_max, y_min = latlon_to_tile(bounds[1], bounds[2], zoom)
            
            # Create zoom directory
            zoom_dir = os.path.join(output_dir, str(zoom))
            os.makedirs(zoom_dir, exist_ok=True)
            
            # Generate tiles
            for x in range(x_min, x_max + 1):
                x_dir = os.path.join(zoom_dir, str(x))
                os.makedirs(x_dir, exist_ok=True)
                
                for y in range(y_min, y_max + 1):
                    tile_path = os.path.join(x_dir, f"{y}.png")
                    
                    # Get tile bounds in lat/lon
                    tile_bounds = tile_to_latlon(x, y, zoom)  # (lon_min, lat_min, lon_max, lat_max)
                    
                    # Check if tile intersects with image bounds
                    if (tile_bounds[2] < bounds[0] or tile_bounds[0] > bounds[2] or
                        tile_bounds[3] < bounds[1] or tile_bounds[1] > bounds[3]):
                        # Tile outside image bounds
                        continue
                    
                    # Read window from source that intersects this tile
                    try:
                        # Convert tile bounds to pixel coordinates in source
                        # rasterio.window expects (left, bottom, right, top) in CRS coordinates
                        from rasterio.windows import from_bounds
                        window = from_bounds(
                            tile_bounds[0], tile_bounds[1], tile_bounds[2], tile_bounds[3],
                            src.transform
                        )
                        
                        # Read the data with resampling
                        data = src.read(
                            window=window, 
                            out_shape=(src.count, 256, 256),
                            resampling=Resampling.bilinear
                        )
                        
                        # Convert to image
                        if src.count == 1:
                            # Grayscale (DSM) - normalize to 0-255
                            arr = data[0]
                            if arr.max() > arr.min():
                                arr = ((arr - arr.min()) / (arr.max() - arr.min()) * 255).astype(np.uint8)
                            else:
                                arr = np.zeros((256, 256), dtype=np.uint8)
                            img = Image.fromarray(arr, mode='L').convert('RGB')
                        elif src.count >= 3:
                            # RGB
                            arr = np.dstack([data[0], data[1], data[2]])
                            # Handle different data types
                            if arr.dtype == np.uint16:
                                arr = (arr / 256).astype(np.uint8)
                            elif arr.dtype != np.uint8:
                                arr = ((arr - arr.min()) / (arr.max() - arr.min() + 1e-10) * 255).astype(np.uint8)
                            img = Image.fromarray(arr, mode='RGB')
                        else:
                            continue
                        
                        # Save tile
                        img.save(tile_path, 'PNG')
                        tile_count += 1
                        
                    except Exception as e:
                        # Log error for debugging
                        print(f"Warning: Failed to generate tile z={zoom} x={x} y={y}: {e}", file=sys.stderr)
                        continue
            
            print(f"Zoom {zoom}: Generated tiles for this level")
        
        print(f"Generated {tile_count} tiles")
        
        # Create metadata JSON
        metadata_result = {
            'bounds': bounds,
            'minZoom': actual_min_zoom,
            'maxZoom': actual_max_zoom,
            'tileCount': tile_count,
            'epsg': 4326,
            'tileSize': 256,
            'format': 'png'
        }
        
        # Save metadata
        with open(os.path.join(output_dir, 'metadata.json'), 'w') as f:
            json.dump(metadata_result, f, indent=2)
        
        return metadata_result


def cleanup_temp_files(output_dir: str):
    """Remove temporary reprojected file"""
    wgs84_path = os.path.join(output_dir, "source_wgs84.tif")
    if os.path.exists(wgs84_path):
        try:
            os.remove(wgs84_path)
        except:
            pass
