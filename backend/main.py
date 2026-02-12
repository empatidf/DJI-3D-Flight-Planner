"""
FastAPI backend for 3D Flight Planner
Handles terrain processing, elevation sampling, and file uploads
"""

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import List, Tuple
import os
import uvicorn

from terrain_processor.converter import convert_geotiff_to_tiles, sample_elevations
from imagery_tiler import generate_tiles, cleanup_temp_files

app = FastAPI(
    title="3D Flight Planner API",
    description="Backend API for terrain processing and elevation data",
    version="1.0.0"
)

# CORS middleware for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static terrain tiles directory
TERRAIN_TILES_DIR = os.path.join(os.path.dirname(__file__), "terrain_tiles")
os.makedirs(TERRAIN_TILES_DIR, exist_ok=True)

app.mount("/terrain/tiles", StaticFiles(directory=TERRAIN_TILES_DIR), name="terrain_tiles")

# Mount static imagery tiles directory
IMAGERY_TILES_DIR = os.path.join(os.path.dirname(__file__), "imagery_tiles")
os.makedirs(IMAGERY_TILES_DIR, exist_ok=True)

app.mount("/tiles", StaticFiles(directory=IMAGERY_TILES_DIR), name="imagery_tiles")

# Upload directory for temporary files
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


class ElevationRequest(BaseModel):
    coordinates: List[Tuple[float, float]]  # List of [lon, lat] pairs
    terrain_id: str


class ElevationResponse(BaseModel):
    elevations: List[float]  # Elevation values in meters


@app.get("/")
async def root():
    return {
        "message": "3D Flight Planner API",
        "version": "1.0.0",
        "endpoints": {
            "terrain_upload": "/api/terrain/upload",
            "elevation_sample": "/api/terrain/sample",
            "imagery_upload": "/api/imagery/upload",
            "imagery_list": "/api/imagery/list",
            "health": "/health"
        }
    }


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


@app.post("/api/terrain/upload")
async def upload_terrain(file: UploadFile = File(...)):
    """
    Upload a GeoTIFF DEM/DSM file and convert it to terrain tiles
    Returns the tile URL for use in Cesium
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    if not file.filename.lower().endswith(('.tif', '.tiff', '.geotiff')):
        raise HTTPException(status_code=400, detail="Only GeoTIFF files are supported")
    
    try:
        # Save uploaded file
        file_path = os.path.join(UPLOAD_DIR, file.filename)
        with open(file_path, "wb") as f:
            content = await file.read()
            f.write(content)
        
        # Convert to terrain tiles
        terrain_id = os.path.splitext(file.filename)[0]
        output_dir = os.path.join(TERRAIN_TILES_DIR, terrain_id)
        
        result = convert_geotiff_to_tiles(file_path, output_dir, terrain_id)
        
        return {
            "success": True,
            "terrain_id": terrain_id,
            "tile_url": f"/terrain/tiles/{terrain_id}/tileset.json",
            "bounds": result.get("bounds"),
            "message": "Terrain uploaded and processed successfully"
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing terrain: {str(e)}")
    
    finally:
        # Clean up uploaded file
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except:
                pass


@app.post("/api/terrain/sample", response_model=ElevationResponse)
async def sample_terrain_elevation(request: ElevationRequest):
    """
    Sample elevation values from a terrain dataset at given coordinates
    Used for terrain following and altitude adjustment
    """
    try:
        terrain_path = os.path.join(TERRAIN_TILES_DIR, request.terrain_id, "source.tif")
        
        if not os.path.exists(terrain_path):
            raise HTTPException(status_code=404, detail="Terrain dataset not found")
        
        elevations = sample_elevations(terrain_path, request.coordinates)
        
        return ElevationResponse(elevations=elevations)
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error sampling elevations: {str(e)}")


@app.post("/api/imagery/upload")
async def upload_imagery(
    file: UploadFile = File(...),
    layer_type: str = "rgb"
):
    """
    Upload a GeoTIFF RGB orthomosaic or DSM file and convert to web map tiles
    Returns tile URL pattern for use in Cesium UrlTemplateImageryProvider
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    if not file.filename.lower().endswith(('.tif', '.tiff', '.geotiff')):
        raise HTTPException(status_code=400, detail="Only GeoTIFF files are supported")
    
    try:
        # Save uploaded file
        file_path = os.path.join(UPLOAD_DIR, file.filename)
        with open(file_path, "wb") as f:
            content = await file.read()
            f.write(content)
        
        print(f"Processing {layer_type.upper()} imagery: {file.filename}")
        
        # Generate unique layer ID
        import time
        layer_id = f"{layer_type}_{int(time.time())}"
        output_dir = os.path.join(IMAGERY_TILES_DIR, layer_id)
        
        # Generate tiles
        metadata = generate_tiles(file_path, output_dir)
        
        # Clean up temp files
        cleanup_temp_files(output_dir)
        
        # Remove uploaded file
        if os.path.exists(file_path):
            os.remove(file_path)
        
        return {
            "success": True,
            "layerId": layer_id,
            "tileUrl": f"http://localhost:8000/tiles/{layer_id}/{{z}}/{{x}}/{{y}}.png",
            "bounds": metadata['bounds'],
            "minZoom": metadata['minZoom'],
            "maxZoom": metadata['maxZoom'],
            "tileCount": metadata['tileCount'],
            "message": f"{layer_type.upper()} imagery uploaded and tiled successfully"
        }
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error processing imagery: {str(e)}")


@app.get("/api/imagery/list")
async def list_imagery_layers():
    """
    List all available imagery layers
    """
    try:
        layers = []
        if os.path.exists(IMAGERY_TILES_DIR):
            for layer_id in os.listdir(IMAGERY_TILES_DIR):
                layer_dir = os.path.join(IMAGERY_TILES_DIR, layer_id)
                metadata_path = os.path.join(layer_dir, "metadata.json")
                
                if os.path.isdir(layer_dir) and os.path.exists(metadata_path):
                    import json
                    with open(metadata_path, 'r') as f:
                        metadata = json.load(f)
                    
                    layers.append({
                        "layerId": layer_id,
                        "tileUrl": f"http://localhost:8000/tiles/{layer_id}/{{z}}/{{x}}/{{y}}.png",
                        "bounds": metadata.get('bounds'),
                        "minZoom": metadata.get('minZoom'),
                        "maxZoom": metadata.get('maxZoom')
                    })
        
        return {"layers": layers}
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error listing imagery: {str(e)}")


@app.delete("/api/imagery/{layer_id}")
async def delete_imagery_layer(layer_id: str):
    """
    Delete an imagery layer and its tiles
    """
    try:
        layer_dir = os.path.join(IMAGERY_TILES_DIR, layer_id)
        
        if not os.path.exists(layer_dir):
            raise HTTPException(status_code=404, detail="Layer not found")
        
        import shutil
        shutil.rmtree(layer_dir)
        
        return {"success": True, "message": f"Layer {layer_id} deleted"}
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting layer: {str(e)}")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
