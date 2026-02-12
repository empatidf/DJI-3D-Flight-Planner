# Backend Server for 3D Flight Planner

## Overview
FastAPI backend that handles GeoTIFF imagery uploads, converts them to web map tiles, and serves them for Cesium visualization.

## Features
- **RGB Orthomosaic Tiling**: Upload aerial imagery and convert to XYZ tiles
- **DSM Elevation Tiling**: Upload digital surface models and convert to grayscale tiles
- **Automatic Reprojection**: Reprojects to WGS84 (EPSG:4326) automatically
- **Optimized Zoom Levels**: Calculates optimal tile pyramid based on image resolution
- **CORS Enabled**: Allows frontend access from localhost:3000 and localhost:5173

## Installation

### 1. Install Python Packages
```powershell
cd d:\vscode\3d-planer\backend
py -m pip install -r requirements.txt
```

### 2. Start the Server

**Option A - Using Batch File (Recommended):**
```powershell
# Right-click start-server.bat → Run as Administrator
.\start-server.bat
```

**Option B - Manual Start:**
```powershell
cd d:\vscode\3d-planer\backend
py -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

## Windows Firewall Issue (WinError 10013)

If you get "Erişim izinlerince izin verilmeyen" or "Access forbidden" error:

### Solution 1 - Run as Administrator
Right-click PowerShell or start-server.bat and select **"Run as Administrator"**

### Solution 2 - Allow Python Through Firewall
1. Open **Windows Security** → **Firewall & network protection**
2. Click **"Allow an app through firewall"**
3. Click **"Change settings"** (requires admin)
4. Click **"Allow another app..."**
5. Browse to: `C:\Users\{YourUser}\AppData\Local\Programs\Python\Python312\python.exe`
6. Check both **Private** and **Public** networks
7. Click **OK**

### Solution 3 - Temporarily Disable Firewall (Not Recommended)
Windows Security → Firewall & network protection → Turn off for Private network

## API Endpoints

### Upload RGB Imagery
```bash
POST http://localhost:8000/api/imagery/upload
Content-Type: multipart/form-data
Body: file=<geotiff>, layer_type=rgb
```

### Upload DSM
```bash
POST http://localhost:8000/api/imagery/upload
Content-Type: multipart/form-data
Body: file=<geotiff>, layer_type=dsm
```

### List Imagery Layers
```bash
GET http://localhost:8000/api/imagery/list
```

### Delete Layer
```bash
DELETE http://localhost:8000/api/imagery/{layer_id}
```

### Get Tiles
```bash
GET http://localhost:8000/tiles/{layer_id}/{z}/{x}/{y}.png
```

## Directory Structure
```
backend/
├── main.py                 # FastAPI application
├── imagery_tiler.py        # GeoTIFF tiling logic
├── terrain_processor/      # Terrain processing (legacy)
├── uploads/                # Temporary upload storage
├── imagery_tiles/          # Generated tile pyramids
│   └── rgb_1234567890/
│       ├── metadata.json
│       ├── 10/
│       │   └── 512/
│       │       └── 256.png
│       ├── 11/
│       └── ...
└── requirements.txt
```

## How It Works

1. **Upload**: User uploads .tif/.tiff file from frontend
2. **Validation**: Backend checks file format and georeferencing
3. **Reprojection**: If not WGS84, reprojects using rasterio
4. **Tiling**: Generates XYZ tile pyramid (zoom 10-18)
5. **Storage**: Saves tiles in `imagery_tiles/{layer_id}/{z}/{x}/{y}.png`
6. **Serving**: Static file serving via FastAPI
7. **Frontend**: Cesium renders tiles using UrlTemplateImageryProvider

## Dependencies
- `fastapi` - Web framework
- `uvicorn` - ASGI server
- `rasterio` - GeoTIFF reading and reprojection
- `Pillow` - Image processing
- `numpy` - Array operations
- `python-multipart` - File upload handling

## Troubleshooting

### "Module not found: fastapi"
```powershell
py -m pip install -r requirements.txt
```

### "Port already in use"
Change port in main.py:
```python
uvicorn.run("main:app", host="127.0.0.1", port=9000, reload=True)
```

### "Tiles not appearing in frontend"
1. Check backend is running: http://localhost:8000
2. Check CORS settings in main.py allow your frontend URL
3. Check browser console for network errors
4. Verify tile URL format: http://localhost:8000/tiles/{layerId}/{z}/{x}/{y}.png

## Performance

- **Small files (<10MB)**: ~1-5 seconds
- **Medium files (10-50MB)**: ~5-30 seconds
- **Large files (50-200MB)**: ~30-120 seconds

Tiles are generated once and cached, subsequent loads are instant.

## License
MIT
