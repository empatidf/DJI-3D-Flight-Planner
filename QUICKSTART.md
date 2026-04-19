# Quick Start Guide

**Live App:** [https://flight.droneverse.de](https://flight.droneverse.de) — no installation needed.

Or run it locally in under 5 minutes:

---

## 1. Clone & Install

```bash
git clone https://github.com/empatidf/DJI-3D-Flight-Planner.git
cd DJI-3D-Flight-Planner/frontend
npm install
```

## 2. Start the Dev Server

```bash
npm run dev
```

Open the URL printed by Vite (usually **http://localhost:3000**).

You should see a 3D Cesium globe with a Layer Manager on the left and a Flight Planning panel on the right.

---

## 3. Add Your Cesium Ion Token

The map loads with a basic view, but to use terrain, imagery, or 3D Tiles you need a Cesium Ion token.

1. Create a free account at [https://ion.cesium.com/signup](https://ion.cesium.com/signup).
2. Go to **Access Tokens** → copy your **Default Token** (or create a new one).
3. In the app, open the **Cesium Layer Manager** (left panel) and paste the token.

Your Cesium Ion assets will now be available. See the [README](README.md#setting-up-cesium-ion-required-for-terrain--imagery) for details on uploading your own terrain and imagery.

---

## 4. Create Your First Mission

1. In the **Missions** panel (left sidebar), click **Create Mission**.
2. Click the mission name to activate it.

---

## 5. Define the Survey Area

Choose one of:

- **Import KML/KMZ** — Click the import button in the Flight Planning panel and select a polygon KML/KMZ file.
- **Draw on Map** — Click **Draw Mission Area**, click points on the globe to define corners, then **right-click** to finish the polygon.

---

## 6. Configure Flight Parameters

In the **Flight Planning** panel (right sidebar):

| Parameter | Recommended Starting Value |
|---|---|
| Drone | DJI Mavic 3 Enterprise |
| Camera | Wide Camera |
| Altitude | 100 m |
| Speed | 8 m/s |
| Forward Overlap | 80% |
| Side Overlap | 70% |
| Flight Angle | 0° (North–South) |

All calculated metrics (GSD, photo interval, line spacing, blur, flight time) update in real time as you adjust values.

---

## 7. Generate Flight Lines & Export

1. Click **Generate Flight Lines** to compute the survey pattern on the map.
2. Review the mission summary (photo count, flight time, distance).
3. Click **Export DJI KMZ** to download a package compatible with **DJI Pilot 2**.

---

## Waypoint Missions

For waypoint (non-area) missions:

1. Create a new mission.
2. Click **Add Waypoint** and click points on the map. Right-click to finish.
3. Configure per-waypoint actions (photo, video, hover).
4. Export the KMZ.

---

## Experiment with Parameters

Try changing values and watch the results:

- **Increase altitude to 150 m** — GSD gets larger, fewer photos, shorter flight time.
- **Increase speed to 12 m/s** — Watch for blur warnings; flight time decreases.
- **Increase overlaps to 85% / 75%** — More photos, tighter line spacing, better reconstruction quality.

---

## Sample KML for Testing

Save this as `test_area.kml` and import it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Test Area</name>
    <Placemark>
      <name>Survey Area</name>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
              -122.084,37.422,0
              -122.084,37.423,0
              -122.083,37.423,0
              -122.083,37.422,0
              -122.084,37.422,0
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>
```

---

## Troubleshooting

**Map doesn't load?**
- Check your internet connection (globe tiles are streamed).
- Refresh the page and check the browser console (F12) for errors.

**Calculations show NaN?**
- Ensure altitude and speed are greater than 0.

**Slow performance?**
- Close other heavy browser tabs.
- Use Chrome or Edge for best WebGL performance.

---

## Next Steps

- Read the full [README](README.md) for all features and Cesium Ion setup details.
- See [IMPLEMENTATION.md](IMPLEMENTATION.md) for technical architecture.
- Explore the source code in `frontend/src/`.
