# 3D Flight Planner

A professional web-based Cesium 3D flight planning application for photogrammetry missions with DJI drones. Features real-time flight path visualization, terrain following, and DJI Pilot 2 waypoint export.

## 🚁 Features

### Core Capabilities
- ✅ **3D Visualization**: CesiumJS-based map viewer with 2D/3D toggle and OpenStreetMap basemap
- ✅ **Layer Management**: Enable/disable base maps, terrain, missions, and overlays with opacity control
- ✅ **Multi-Drone Support**: 
  - DJI Mavic 3 Enterprise (Wide & Zoom cameras)
  - DJI Matrice 300 RTK (P1 35mm & L2 LiDAR)
- ✅ **Dynamic Flight Planning**: Real-time calculation of:
  - GSD (Ground Sample Distance)
  - Photo intervals
  - Flight time estimation
  - Blur factor analysis
  - Flight line generation
- ✅ **Area Definition**: 
  - Import KML/KMZ files
  - Draw custom polygons (coming soon)
- ✅ **Terrain Support**: Upload DEM/DSM GeoTIFF files for terrain following
- ✅ **Coordinate Reprojection**: Automatic conversion from any EPSG to EPSG:4326
- ✅ **Mission Export**: DJI Pilot 2 compatible WPML/KMZ waypoint files

### Technical Specifications

**Supported Drones & Cameras:**

| Drone | Camera | Sensor | Resolution | Focal Length |
|-------|--------|--------|------------|--------------|
| Mavic 3 Enterprise | Wide | 4/3 CMOS (17.3×13mm) | 20MP (5280×3956) | 12.29mm |
| Mavic 3 Enterprise | Zoom | 1/2" CMOS (6.4×4.8mm) | 12MP (4000×3000) | 27.2mm |
| Matrice 300 RTK | P1 35mm | Full-frame (35.9×24mm) | 45MP (8192×5460) | 35mm |
| Matrice 300 RTK | L2 LiDAR | 4/3 CMOS (17.3×13mm) | 20MP (5280×3956) | 12.29mm |

**Flight Planning Calculations:**
- GSD: `(sensor_width × altitude × 100) / (focal_length × image_width)` cm/pixel
- Photo Interval: Based on ground speed, footprint height, and forward overlap
- Line Spacing: Calculated from footprint width and side overlap percentage
- Blur Factor: `(speed × shutter_speed) / GSD` (warning if > 1 pixel)
- Flight Time: Total distance / speed + turn time

## 📁 Project Structure

```
3d-planer/
├── frontend/          # React + TypeScript + Vite
│   ├── src/
│   │   ├── components/      # UI components
│   │   │   ├── CesiumMap.tsx         # 3D map viewer
│   │   │   ├── LayerManager.tsx      # Layer controls
│   │   │   └── FlightPlanner.tsx     # Planning sidebar
│   │   ├── lib/                      # Core logic
│   │   │   ├── drone-specs.ts        # Drone/camera database
│   │   │   ├── flight-calculations.ts # GSD, overlaps, etc.
│   │   │   ├── flight-path-generator.ts # Line generation
│   │   │   ├── kml-parser.ts         # KML/KMZ import
│   │   │   ├── coordinate-transform.ts # EPSG reprojection
│   │   │   └── dji-export.ts         # WPML export
│   │   └── stores/
│   │       └── mission-store.ts      # State management
│   └── public/
└── backend/           # Python FastAPI
    ├── main.py                 # API server
    ├── terrain_processor/
    │   └── converter.py        # GeoTIFF processing
    └── terrain_tiles/          # Terrain data storage
```

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ and npm
- Python 3.9+
- (Optional) GDAL for terrain processing

### Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

The app will be available at **http://localhost:3000**

### Backend Setup (Optional - for terrain features)

```bash
cd backend

# Create virtual environment
python -m venv venv

# Activate (Windows)
.\venv\Scripts\activate

# Activate (Linux/Mac)
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run server
python main.py
```

Backend API at **http://localhost:8000**

**GDAL Installation Note:** On Windows, if pip install fails, download GDAL wheel from [Unofficial Windows Binaries](https://www.lfd.uci.edu/~gohlke/pythonlibs/#gdal) and install manually.

## 📖 Usage Guide

### 1. Select Drone & Camera
- Choose drone model from dropdown (Mavic 3E or M300 RTK)
- Select camera/payload (Wide, Zoom, P1, or L2)
- Review sensor specifications

### 2. Configure Flight Parameters
- **Altitude**: Flight height above ground level (10-500m)
- **Speed**: Flight speed in m/s (max speed varies by drone)
- **Forward Overlap**: Percentage overlap between photos (50-95%)
- **Side Overlap**: Percentage overlap between flight lines (50-90%)
- **Flight Angle**: Direction of flight lines (0° = North, 90° = East)

⚠️ **Warnings:**
- Red blur warning if speed causes motion blur > 1 pixel
- Yellow speed warning if exceeding maximum safe speed for sharp images

### 3. Define Area of Interest
- **Import KML/KMZ**: Click "Import KML/KMZ" and select file
- **Draw Area**: (Coming soon) Click "Draw Area" to manually define polygon

### 4. Review Calculated Results
- **GSD**: Ground sample distance in cm/pixel (image resolution)
- **Photo Interval**: Time between photo captures in seconds
- **Line Spacing**: Distance between parallel flight lines in meters
- **Footprint**: Ground coverage of each photo in meters
- **Blur Factor**: Motion blur analysis (should be < 1 pixel)
- **Est. Photos**: Total number of images to be captured
- **Est. Flight Time**: Mission duration including turns

### 5. Generate Flight Plan
- Click "Create New Mission" to generate flight lines
- View real-time 3D visualization on map
- Flight lines displayed as blue serpentine pattern
- Waypoints shown as yellow spheres

### 6. Export Mission
- Choose export format:
  - **KMZ (WPML)**: DJI Pilot 2 compatible (recommended)
  - **KML**: Standard format for visualization
- Download and import to DJI Pilot 2 app

### 7. Layer Management
- Toggle between 2D/3D/2.5D views
- Enable/disable terrain visualization
- Adjust layer opacity
- Show/hide individual missions

### 8. Terrain Following (Optional)
- Upload DEM/DSM GeoTIFF via backend API
- Enable terrain following to maintain constant AGL
- Waypoint altitudes automatically adjusted

## 🔧 API Endpoints (Backend)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | API information |
| GET | `/health` | Health check |
| POST | `/api/terrain/upload` | Upload GeoTIFF DEM/DSM |
| POST | `/api/terrain/sample` | Sample elevation values |
| GET | `/terrain/tiles/{id}/tileset.json` | Terrain tileset metadata |

## 🛠️ Tech Stack

**Frontend:**
- React 19 with TypeScript
- Vite for build tooling
- CesiumJS for 3D visualization
- Zustand for state management
- proj4js for coordinate reprojection
- jszip for KML/KMZ handling

**Backend:**
- Python 3.9+
- FastAPI for REST API
- Rasterio & GDAL for GeoTIFF processing
- Uvicorn ASGI server

## 📐 Flight Planning Formulas

### Ground Sample Distance (GSD)
```
GSD (cm/px) = (sensor_width_mm × altitude_m × 100) / (focal_length_mm × image_width_px)
```

Example: Mavic 3E Wide @ 100m AGL
```
GSD = (17.3 × 100 × 100) / (12.29 × 5280) = 2.67 cm/pixel
```

### Photo Footprint
```
width (m) = (sensor_width × altitude) / focal_length
height (m) = (sensor_height × altitude) / focal_length
```

### Photo Interval
```
interval (s) = (footprint_height × (1 - forward_overlap/100)) / speed
```

### Flight Line Spacing
```
spacing (m) = footprint_width × (1 - side_overlap/100)
```

### Blur Analysis
```
blur (pixels) = (speed_m/s × shutter_speed_s × 100) / GSD_cm
```
Safe threshold: **blur < 1.0 pixel**

## 🎯 Roadmap

### Phase 1 (✅ Complete)
- [x] Core UI with Cesium viewer
- [x] Drone & camera specifications
- [x] Flight calculations engine
- [x] Layer management system
- [x] KML/KMZ import
- [x] Flight line generation
- [x] DJI WPML export
- [x] Coordinate reprojection
- [x] Backend terrain processing

### Phase 2 (🔄 In Progress)
- [ ] Manual polygon drawing tools
- [ ] Multiple mission management
- [ ] Terrain integration in frontend
- [ ] Real-time 3D flight path visualization
- [ ] Mission editing and duplication
- [ ] Area calculation and statistics

### Phase 3 (📋 Planned)
- [ ] Point cloud (LAS/LAZ) visualization
- [ ] Double-grid missions
- [ ] Oblique photography support
- [ ] Wind compensation
- [ ] Battery planning with swap locations
- [ ] Restricted airspace integration
- [ ] Mission templates library
- [ ] Advanced terrain following algorithms

## 🐛 Known Limitations

1. **Terrain Processing**: Requires GDAL installation (complex on Windows)
2. **Point Clouds**: Not yet implemented (Phase 3)
3. **Drawing Tools**: Manual polygon drawing UI not complete
4. **Cesium Token**: Using default token (rate-limited); set your own for production
5. **Large Areas**: Performance may degrade with >1000 waypoints
6. **Browser Compatibility**: Best in Chrome/Edge; Safari may have issues

## 📄 License

MIT License - See LICENSE file for details

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Submit pull request with tests

## 📞 Support

Found a bug or have a feature request?  
Open an issue on GitHub with:
- Browser/OS version
- Drone model and parameters
- Screenshots if applicable
- Error logs from console

## 🙏 Acknowledgments

- **CesiumJS** - 3D globe visualization
- **DJI** - Drone specifications and WPML format
- **OpenStreetMap** - Free basemap tiles
- **UGCS & DJI Terra** - Inspiration for UI/UX design

---

**Version:** 1.0.0  
**Last Updated:** February 11, 2026  
**Status:** Beta - Core features complete, testing in progress

