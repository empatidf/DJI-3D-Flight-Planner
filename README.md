# DJI 3D Flight Planner

**Live App:** [https://flight.droneverse.de](https://flight.droneverse.de)

A web-based drone mission planning tool built with **CesiumJS** and **React**. Plan area survey and waypoint missions on a 3D globe, configure photogrammetry parameters, and export DJI-compatible KMZ/WPML files ready for DJI Pilot 2.

---

## Features

- **3D Globe** — Full CesiumJS viewer with 2D / 3D / Columbus view modes and address + coordinate search
- **Mission Manager** — Create, manage, show/hide, and focus multiple missions
- **Layer Manager** — Add Cesium Ion terrain, imagery, and 3D Tiles assets with visibility and opacity controls
- **Area Missions** — Import area KML/KMZ or draw polygons interactively; edit vertices on the map
- **Waypoint Missions** — Import waypoint KML/KMZ or draw routes interactively; edit points on the map
- **Photogrammetry Engine** — Real-time GSD, footprint, line spacing, photo interval, blur analysis, and speed calculations
- **Terrain-Aware Planning** — AGL-based waypoint altitude adjustment using terrain sampling
- **DJI Export** — Export missions as DJI Pilot 2 compatible KMZ/WPML packages
- **Drone & Camera Database** — Preloaded specs for DJI Mavic 3E, Matrice 300 RTK (P1, L2, PhaseOne P3), Matrice 4E, and Sony ILX-LR1
- **Persistent State** — Missions, layers, Cesium token, camera position, and settings survive page reloads
- **Right-Click Context Menu** — Copy clicked coordinates from anywhere on the map

---

## Supported Drones & Cameras

| Drone | Cameras |
|---|---|
| DJI Mavic 3 Enterprise | Wide (20 MP), Zoom (12 MP) |
| DJI Matrice 300 RTK | Zenmuse P1 35 mm, P1 50 mm, L2 LiDAR, PhaseOne P3 GS120 80 mm (120 MP) |
| DJI Matrice 4E | Wide, Zoom |
| Custom Platform | Sony ILX-LR1 50 mm, 100 mm |

---

## Requirements

- **Node.js** 18 or later
- **npm** 9 or later
- Windows / macOS / Linux
- A modern browser (Chrome, Edge, Firefox)
- Internet connection (Cesium globe tiles)

---

## Installation

```bash
git clone https://github.com/empatidf/DJI-3D-Flight-Planner.git
cd DJI-3D-Flight-Planner/frontend
npm install
```

---

## Development

```bash
cd frontend
npm run dev
```

Open the URL printed by Vite (usually `http://localhost:3000`).

> **Note:** Always run npm commands from the `frontend` folder.

---

## Production Build

```bash
cd frontend
npm run build
npm run preview   # optional: preview the build locally
```

---

## Setting Up Cesium Ion (Required for Terrain & Imagery)

The app uses **Cesium Ion** to serve terrain, imagery, and 3D Tiles. You need a free Cesium Ion account.

### 1. Create a Cesium Ion Account

1. Go to [https://ion.cesium.com/signup](https://ion.cesium.com/signup) and create a free account.
2. After signing in you will land on the **Assets** dashboard.

### 2. Get Your Access Token

1. In Cesium Ion, go to **Access Tokens** (left sidebar or [https://ion.cesium.com/tokens](https://ion.cesium.com/tokens)).
2. Copy your **Default Token**, or click **Create Token** to make a new one with the scopes you need (at minimum: `assets:read`).
3. In the app, open the **Cesium Layer Manager** panel (left sidebar) and paste your token into the token field.

### 3. Upload Your Own Assets (Optional)

You can upload custom terrain (GeoTIFF, Terrain DB), imagery, or 3D Tiles:

1. In Cesium Ion, click **Add Data** → **Upload**.
2. Select your file (e.g., a GeoTIFF DEM/DSM, orthophoto, or 3D tileset).
3. Choose the asset type:
   - **Terrain** — for elevation models (DEM, DSM, GeoTIFF)
   - **Imagery** — for orthophotos or satellite images
   - **3D Tiles** — for point clouds, photogrammetry models, or BIM
4. Wait for processing to complete. Once done, note the **Asset ID** shown on the asset detail page.
5. In the app's Layer Manager, your uploaded assets will appear in the asset list when you click **Add Layer**. Select the asset and choose its type.

### 4. Default Assets

Cesium Ion provides free global assets you can use immediately:

| Asset | Ion Asset ID | Type |
|---|---|---|
| Cesium World Terrain | `1` | Terrain |
| Bing Maps Aerial | `2` | Imagery |
| Cesium OSM Buildings | `96188` | 3D Tiles |

These are available under any Cesium Ion account.

---

## How to Use

### 1. Create a Mission

Open the **Missions** panel (left sidebar) and click **Create Mission**. Click a mission name to activate it and auto-focus the map.

### 2. Define Mission Geometry

**Area Mission:**
- Click **Import Area KML/KMZ** to load an existing polygon, or
- Click **Draw Mission Area**, click points on the map, then right-click to finish.

**Waypoint Mission:**
- Click **Import Waypoint KML/KMZ**, or
- Click **Add Waypoint**, click points on the map, then right-click to finish.

### 3. Edit on the Map

Activate edit mode from the Flight Planning panel. Drag vertices to adjust your area or waypoint positions. Click **Save** when done.

### 4. Configure Flight Parameters

In the **Flight Planning** panel (right sidebar), adjust:

- Drone & camera selection
- Altitude, speed, overlaps
- Flight direction angle
- Gimbal pitch / yaw, drone heading
- Waypoint actions (photo, video, hover)

All photogrammetry metrics (GSD, blur, flight time, photo count) update in real time.

### 5. Generate & Export

- **Area missions:** Click **Generate Flight Lines** to compute the survey pattern, then **Export DJI KMZ** to download the package.
- **Waypoint missions:** Configure actions per waypoint, then export.

The exported KMZ is compatible with **DJI Pilot 2**.

---

## Live Demo

The app is live at **[https://flight.droneverse.de](https://flight.droneverse.de)** — no installation required.

## Self-Hosting / Deploying on Vercel

You can deploy your own instance on [Vercel](https://vercel.com):

1. Fork this repository.
2. Import it on [vercel.com/new](https://vercel.com/new).
3. Set the following in project settings:
   - **Root Directory:** `frontend`
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
   - **Framework Preset:** Vite
4. Deploy. Vercel will auto-deploy on every push to `master`.

---

## Project Structure

```
DJI-3D-Flight-Planner/
├── README.md
├── QUICKSTART.md
├── IMPLEMENTATION.md
└── frontend/
    ├── package.json
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── components/
        │   ├── CesiumMap.tsx         # 3D globe & drawing
        │   ├── LayerManager.tsx      # Cesium Ion layer controls
        │   ├── MissionManager.tsx    # Mission list & management
        │   └── FlightPlanner.tsx     # Flight parameters & export
        ├── lib/
        │   ├── drone-specs.ts        # Drone & camera database
        │   ├── flight-calculations.ts
        │   ├── flight-path-generator.ts
        │   ├── kml-parser.ts
        │   ├── dji-wpml-exporter.ts
        │   ├── cesium-ion-api.ts
        │   ├── terrain-sampler.ts
        │   └── coordinate-transform.ts
        └── stores/
            └── mission-store.ts      # Zustand state management
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI Framework | React 19 + TypeScript |
| Build Tool | Vite |
| 3D Globe | CesiumJS |
| State Management | Zustand (persisted to localStorage) |
| Coordinate Transforms | proj4js |
| KML/KMZ Handling | JSZip + DOM parser |
| Styling | CSS (no framework) |

---

## Persistence

The app stores all state in browser localStorage via Zustand, including missions, layers, Cesium Ion token, view mode, and camera position. Everything is restored on page reload.

---

## Troubleshooting

**Dev server won't start?**
- Make sure you are inside the `frontend` folder before running `npm run dev`.

**Map is blank or tiles fail to load?**
- Check your internet connection.
- Verify your Cesium Ion token is entered correctly in the Layer Manager.

**Calculations show NaN?**
- Ensure altitude and speed are greater than 0.

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

1. Fork the repository
2. Create a feature branch from `dev`
3. Commit your changes
4. Open a pull request against `dev`

---

## License

This project is licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE)**.

- **Personal & hobby use** — Free. Use it, learn from it, enjoy it.
- **Non-commercial organizations** — Free (educational institutions, charities, government, research).
- **Commercial use** — Requires a separate commercial license. Please contact **[info@droneverse.de](mailto:info@droneverse.de)** for licensing.

See the [LICENSE](LICENSE) file for the full legal text.

**Copyright 2026 [Droneverse](https://droneverse.de)**

### Map layers flicker/reload unexpectedly

- Use latest code (recent fixes prevent redundant reloads on mission focus actions).
- If a specific Ion imagery asset still fails with repeated tile 404, verify that asset in Cesium Ion dashboard.

### Terrain/vertical guide visuals look wrong right after refresh

- Latest implementation uses dynamic terrain follow for guide lines.
- Wait until terrain tiles finish loading; guides should settle correctly.

### Cesium token issues

- Re-open token editor, paste valid token, and save.
- Confirm token has access to intended assets.

---

## Scripts

Inside `frontend/package.json`:

- `npm run dev` – start dev server
- `npm run build` – TypeScript build + Vite production build
- `npm run preview` – preview production build
- `npm run lint` – lint source

---

## Documentation

- [QUICKSTART.md](QUICKSTART.md) — Get up and running in 5 minutes
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — Technical architecture and module details

---

## Current Status

Actively maintained. Core mission workflow is stable and production-ready:

- Multi-mission and layer management
- AOI and waypoint import, draw, and edit
- Cesium Ion terrain, imagery, and 3D Tiles integration
- Real-time photogrammetry calculations
- DJI Pilot 2 KMZ/WPML export
- Terrain-aware AGL flight planning
- Responsive, operator-focused UI
