# Technical Architecture

Technical overview of the DJI 3D Flight Planner codebase for contributors and developers.

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| UI | React 19 + TypeScript | Component-based UI with type safety |
| Build | Vite + vite-plugin-cesium | Fast dev server, Cesium asset handling |
| 3D Globe | CesiumJS | Terrain, imagery, 3D Tiles rendering |
| State | Zustand (persisted) | Global app state with localStorage persistence |
| Coordinates | proj4js | EPSG coordinate transformations |
| Files | JSZip | KML/KMZ import and DJI KMZ export |

---

## Project Layout

```
frontend/src/
├── components/
│   ├── CesiumMap.tsx          # Globe viewer, drawing tools, entity rendering
│   ├── LayerManager.tsx       # Cesium Ion token, terrain/imagery/3D Tiles management
│   ├── MissionManager.tsx     # Mission list, create/delete/focus/visibility
│   └── FlightPlanner.tsx      # Drone/camera selection, parameters, export
├── lib/
│   ├── drone-specs.ts         # Drone & camera specification database
│   ├── flight-calculations.ts # GSD, footprint, blur, speed, time calculations
│   ├── flight-path-generator.ts # Parallel line generation, polygon clipping
│   ├── kml-parser.ts          # KML/KMZ import (area + waypoint)
│   ├── dji-wpml-exporter.ts   # DJI Pilot 2 KMZ/WPML export
│   ├── dji-export.ts          # Legacy export helpers
│   ├── cesium-ion-api.ts      # Cesium Ion REST API wrapper
│   ├── terrain-sampler.ts     # Terrain elevation sampling via Cesium
│   └── coordinate-transform.ts # proj4js coordinate utilities
└── stores/
    └── mission-store.ts       # Zustand store (missions, layers, UI state)
```

---

## Core Modules

### Drone & Camera Database (`drone-specs.ts`)

Type-safe definitions for all supported drones and cameras. Each `CameraSpec` includes sensor dimensions, resolution, focal length, pixel pitch, and aperture. Each `DroneSpec` lists available cameras, max/cruise speeds, altitude limits, battery life, and RTK capability.

Adding a new drone or camera is a matter of defining a new constant and adding it to the appropriate drone's `cameras` array and the `DRONES` export.

### Flight Calculations (`flight-calculations.ts`)

Pure functions implementing standard photogrammetry formulas:

- **GSD** = (sensor width × altitude) / (focal length × image width)
- **Footprint** = (sensor dimension × altitude) / focal length
- **Photo interval** = footprint along-track × (1 − forward overlap) / speed
- **Line spacing** = footprint cross-track × (1 − side overlap)
- **Blur factor** = speed × shutter speed / GSD
- **Flight time**, **photo count**, **storage** estimates

All calculations update in real time as the user adjusts parameters.

### Flight Path Generator (`flight-path-generator.ts`)

Generates parallel survey lines over an AOI polygon:

1. Rotates the polygon by the flight angle.
2. Computes the bounding box.
3. Sweeps parallel lines at the calculated line spacing.
4. Clips each line to the polygon boundary.
5. Applies serpentine (alternating) direction.
6. Inserts waypoints along each line at the photo interval distance.
7. Computes total mission distance and turn costs.

### KML/KMZ Parser (`kml-parser.ts`)

Imports area polygons and waypoint routes from KML and KMZ files. Uses the browser DOM parser for XML and JSZip for KMZ extraction. Extracts coordinates, names, and descriptions from Placemarks.

### DJI WPML Exporter (`dji-wpml-exporter.ts`)

Generates DJI Pilot 2 compatible KMZ packages containing:

- `wpmz/template.kml` — mission metadata
- `wpmz/waylines.wpml` — waypoint actions, speeds, altitudes, gimbal angles

Supports configurable finish actions, RC-lost behavior, and per-waypoint photo/video triggers.

### Terrain Sampler (`terrain-sampler.ts`)

Samples terrain elevation at waypoint positions using the active Cesium terrain provider. Adjusts waypoint altitudes so the drone flies at the requested AGL height above actual ground level rather than above the WGS84 ellipsoid.

### Cesium Ion API (`cesium-ion-api.ts`)

Thin wrapper around the Cesium Ion REST API. Lists the user's assets so the Layer Manager can present them for selection.

### Coordinate Transform (`coordinate-transform.ts`)

proj4js utilities for converting between coordinate reference systems (WGS84, Web Mercator, UTM zones). Includes Haversine distance calculation and auto-detection of UTM zone from longitude.

---

## State Management (`mission-store.ts`)

A single Zustand store holds all application state:

- **Missions** — array of mission objects (AOI, waypoints, flight lines, parameters)
- **Active mission** — currently selected mission ID
- **Layers** — Cesium Ion asset layers with visibility and opacity
- **Cesium token** — persisted Ion access token
- **UI state** — view mode, draw mode flags, camera position, panel states

State is persisted to `localStorage` via Zustand's `persist` middleware and restored on page load.

---

## CesiumMap Component (`CesiumMap.tsx`)

The largest component. Responsibilities:

- Initializes the Cesium `Viewer` with terrain, imagery, and 3D Tiles from the layer list.
- Renders mission AOI polygons with terrain-following elevation.
- Renders flight line polylines and waypoint markers.
- Handles interactive polygon drawing (click points → right-click to finish).
- Handles interactive waypoint drawing (same pattern).
- Provides vertex editing mode (drag to move AOI/waypoint points).
- Manages the right-click context menu for coordinate copying.
- Syncs 2D/3D/Columbus view modes.
- Persists and restores camera position across reloads.

Drawing entities use `clampToGround: true` and `HeightReference.CLAMP_TO_GROUND` so interactive drawing stays on the terrain surface regardless of elevation.

---

## Design Decisions

| Decision | Rationale |
|---|---|
| Client-side only (no backend required) | Simplifies deployment; all computation runs in the browser |
| CesiumJS | Industry standard for 3D geospatial; supports terrain, imagery, 3D Tiles |
| Zustand over Redux | Lightweight, minimal boilerplate for this scale of app |
| proj4js in-browser | Avoids server round-trips for coordinate transforms |
| JSZip in-browser | KML/KMZ import and DJI export without a server |
| Pure calculation functions | Easy to test, no side effects |
| Separation: components / lib / stores | Clear boundaries between UI, business logic, and state |

---

## Adding a New Drone

1. Define camera constants in `drone-specs.ts` with accurate sensor specs.
2. Define the drone constant with its camera array and flight envelope.
3. Add the drone to the `DRONES` export array.

The UI dropdowns and all calculations pick up the new entry automatically.

---

## Building & Deploying

```bash
cd frontend
npm run build        # outputs to frontend/dist/
```

Deploy the `dist` folder to any static hosting (Vercel, Netlify, GitHub Pages, S3, etc.). No server-side runtime is needed.

For Vercel: set root directory to `frontend`, build command `npm run build`, output directory `dist`.
