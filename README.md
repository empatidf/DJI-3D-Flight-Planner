# 3D Planer (Cesium DJI Mission Planner)

Web-based mission planning tool for DJI workflows using Cesium.  
You can create and manage multiple missions, import KML/KMZ, draw/edit mission geometry, add Cesium Ion terrain/imagery layers, preview flight lines, and export DJI-compatible KMZ/WPML.

---

## Highlights

- Cesium map with search bar (address + coordinate search)
- Mission manager with multi-mission visibility and fast mission focus
- Layer manager with Cesium Ion token support
  - Terrain assets
  - Imagery assets
  - 3D Tiles assets
- 2D / 3D / Columbus view mode switching
- AOI workflows
  - Import area KML/KMZ
  - Draw mission area interactively
  - Edit area vertices on map
- Waypoint workflows
  - Import waypoint KML/KMZ
  - Draw waypoint mission interactively
  - Edit waypoint points on map
- Photogrammetry calculations
  - GSD, footprint, spacing, overlap effects, speed/blur metrics
- Terrain-aware waypoint sampling for AGL-based planning
- DJI export (KMZ/WPML)
- Persistent app state (missions, active mission, layers, token, map camera)
- Responsive side panels + collapsible Flight Planning panel
- Right-click map menu to copy clicked coordinates (lat,lon)

---

## Project Structure

```text
3d-planer/
├─ README.md
├─ QUICKSTART.md
├─ IMPLEMENTATION.md
└─ frontend/
   ├─ package.json
   ├─ src/
   │  ├─ components/
   │  │  ├─ CesiumMap.tsx
   │  │  ├─ LayerManager.tsx
   │  │  ├─ MissionManager.tsx
   │  │  └─ FlightPlanner.tsx
   │  ├─ lib/
   │  │  ├─ flight-calculations.ts
   │  │  ├─ flight-path-generator.ts
   │  │  ├─ kml-parser.ts
   │  │  ├─ dji-export.ts
   │  │  ├─ dji-wpml-exporter.ts
   │  │  ├─ cesium-ion-api.ts
   │  │  └─ terrain-sampler.ts
   │  └─ stores/
   │     └─ mission-store.ts
   └─ ...
```

---

## Requirements

- Node.js 18+
- npm 9+
- Windows/macOS/Linux
- Internet access (Cesium/Ion map resources)

---

## Installation

From workspace root:

```bash
cd frontend
npm install
```

---

## Run (Development)

```bash
cd frontend
npm run dev
```

Vite will print the local URL (commonly `http://localhost:5173`).

> Note: run commands from `frontend` folder. Running `npm run dev` from workspace root will fail because the root folder is not the Vite app package.

---

## Build (Production)

```bash
cd frontend
npm run build
```

Preview built output locally:

```bash
npm run preview
```

---

## How to Use

### 1) Create or Select Mission

- Use **Missions** panel to create a mission.
- Click a mission name to activate and auto-focus map.
- Use the visibility icon to show/hide each mission quickly.

### 2) Set Cesium Token and Add Assets

In **Cesium Layer Manager**:

1. Add your Cesium Ion token.
2. Select an asset from your account.
3. Add terrain/imagery/3D tiles layers.
4. Toggle visibility and adjust opacity.

Tips:
- Terrain + imagery can be active together.
- If an imagery asset returns tile 404s from Ion, that is usually an asset availability/tiling issue, not planner math.

### 3) Define Mission Geometry

### Area Mission
- Import area KML/KMZ, or
- Use **Draw Mission Area** and right-click to finish.

### Waypoint Mission
- Import waypoint KML/KMZ, or
- Use **Add Waypoint** and right-click to finish.

### 4) Edit on Map

For active mission:

- Start edit mode from Flight Planning tools.
- Drag points to refine area/waypoints.
- Save when done.

### 5) Configure Flight Parameters

In **Flight Planning** panel adjust:

- altitude
- speed
- overlaps
- flight direction
- gimbal/drone yaw options
- waypoint actions

Calculated metrics update accordingly.

### 6) Generate Plan and Export

- Generate flight lines for area missions.
- Review mission summary.
- Export DJI-compatible KMZ/WPML.

---

## UI Notes

- Left side has **Cesium Layer Manager** + **Missions** with equal-height responsive behavior and internal scrolling.
- Right side **Flight Planning** panel can be collapsed/expanded with animated toggle.
- Search bar is top-centered and responsive to viewport width.

---

## Persistence

The app stores state in browser local storage (via Zustand persist), including:

- missions and active mission
- layer settings
- Cesium token
- selected view mode
- last camera/map view

On refresh/reopen, previous state is restored.

---

## Troubleshooting

### Dev command fails

- Ensure you are inside `frontend` before running npm scripts.

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

## Documentation References

- `QUICKSTART.md` for fast onboarding
- `IMPLEMENTATION.md` for implementation details
- `dji-kmz-help-document/` for DJI/KML/WPML references

---

## Current Status

Active development with stable core mission workflow:

- mission + layer management
- AOI/waypoint import and draw/edit
- Cesium Ion terrain/imagery integration
- DJI export pipeline
- responsive operator-focused UI

If you want, next step can be adding screenshots/GIF sections to this README for each workflow step.
