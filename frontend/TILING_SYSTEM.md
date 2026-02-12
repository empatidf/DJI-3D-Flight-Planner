# Local GeoTIFF Tiling System

## How It Works

1. **User uploads TIFF** via Layer Manager (RGB/DSM button)
2. **Frontend sends file** to Vite dev server `/api/tile` endpoint
3. **Vite plugin** saves file to `temp/` directory
4. **Python script runs** asynchronously via Node.js `spawn()`
5. **Tiles generated** to `public/tiles/{layerId}/{z}/{x}/{y}.png`
6. **Cesium renders** tiles using `UrlTemplateImageryProvider` with local URLs
7. **On delete**, tile directory is removed via `/api/tile/{layerId}` DELETE

## Directory Structure

```
frontend/
├── public/
│   └── tiles/           # Generated tiles (served by Vite)
│       ├── rgb_1234567890/
│       │   ├── metadata.json
│       │   ├── 10/
│       │   ├── 11/
│       │   └── ...
│       └── dsm_1234567891/
│           └── ...
├── temp/                # Temporary upload storage
├── tile-worker.js       # Node.js worker for Python integration
├── vite-plugin-tiler.ts # Vite plugin for handling uploads
└── src/
    ├── lib/
    │   └── tiler.ts     # Tiling utility functions
    └── components/
        ├── LayerManager.tsx  # UI with upload handlers
        └── CesiumMap.tsx     # Renders tiles
```

## Advantages

- ✅ **No server required** - Everything runs locally
- ✅ **Fast** - Tiles served from localhost filesystem
- ✅ **Offline capable** - No internet needed after tile generation
- ✅ **Auto-cleanup** - Tiles deleted when layer is removed
- ✅ **No port conflicts** - Uses Vite dev server (port 3000)
- ✅ **Python power** - Uses rasterio for proper GeoTIFF handling

## Tile URLs

Local tiles are served at:
```
http://localhost:3000/tiles/{layerId}/{z}/{x}/{y}.png
```

Cesium URL Template:
```
/tiles/{layerId}/{z}/{x}/{y}.png
```

## File Formats

- **Input**: GeoTIFF (.tif, .tiff)
- **Output**: PNG tiles
- **Projection**: WGS84 (EPSG:4326)
- **Tile Scheme**: Web Mercator (XYZ)

## Performance

- **Small files** (<10MB): 1-5 seconds
- **Medium files** (10-50MB): 5-30 seconds
- **Large files** (>50MB): 30-120 seconds

Progress shown via alert during processing.
