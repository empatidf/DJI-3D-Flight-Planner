# Python Backend Setup

## Create Virtual Environment

```bash
# Windows
python -m venv venv
.\venv\Scripts\activate

# Linux/Mac
python3 -m venv venv
source venv/bin/activate
```

## Install Dependencies

```bash
pip install -r requirements.txt
```

**Note:** GDAL installation can be tricky on Windows. If you encounter issues:

1. Download GDAL wheel from: https://www.lfd.uci.edu/~gohlke/pythonlibs/#gdal
2. Install it: `pip install GDAL-3.10.0-cp312-cp312-win_amd64.whl` (adjust version)
3. Then install other requirements

## Run the Server

```bash
python main.py
```

Or with uvicorn directly:

```bash
uvicorn main:app --reload --port 8000
```

## API Endpoints

- `GET /` - API information
- `GET /health` - Health check
- `POST /api/terrain/upload` - Upload GeoTIFF file
- `POST /api/terrain/sample` - Sample elevation values
- `GET /terrain/tiles/{terrain_id}/tileset.json` - Get tileset metadata

## Testing

```bash
# Test health endpoint
curl http://localhost:8000/health

# Upload a terrain file
curl -X POST -F "file=@terrain.tif" http://localhost:8000/api/terrain/upload
```
