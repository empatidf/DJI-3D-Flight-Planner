# Quick Start Guide

## 🚀 Get Running in 5 Minutes

### Step 1: Start the Frontend

```bash
cd d:\vscode\3d-planer\frontend
npm run dev
```

✅ Open browser to **http://localhost:3000**

You should now see:
- 3D Cesium globe with OpenStreetMap
- Layer Manager panel on the left
- Flight Planning sidebar on the right

### Step 2: Try Flight Planning

1. **Select Your Drone**
   - Choose "DJI Mavic 3 Enterprise" or "DJI Matrice 300 RTK"

2. **Select Camera**
   - For Mavic 3E: Choose "Wide" or "Zoom"
   - For M300: Choose "P1 35mm" or "L2 LiDAR"

3. **Set Flight Parameters**
   - Altitude: 100 meters (good starting point)
   - Speed: 8 m/s (safe for most conditions)
   - Forward Overlap: 80%
   - Side Overlap: 70%
   - Flight Angle: 0° (North-South lines)

4. **View Calculated Results**
   - Watch GSD, photo interval, and other values update instantly
   - Check for blur warnings (should be green)

### Step 3: Test with Sample KML (Optional)

Create a simple test KML file (`test_area.kml`):

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

Then:
1. Click "Import KML/KMZ" button
2. Select your test file
3. Mission will be created automatically
4. (Note: UI for this is in development phase)

### Step 4: Experiment with Parameters

Try changing values and watch calculations update:

**Increase Altitude to 150m:**
- GSD increases (lower resolution)
- Footprint gets larger
- Fewer photos needed
- Flight time decreases

**Increase Speed to 12 m/s:**
- Photo interval decreases
- Watch for blur warnings
- Flight time decreases

**Increase Overlaps to 85%/75%:**
- More photos captured
- Line spacing decreases
- Flight time increases
- Better reconstruction quality

### What Works Right Now ✅

- ✅ 3D/2D map visualization
- ✅ Layer visibility controls
- ✅ Drone and camera selection
- ✅ Real-time flight calculations
- ✅ Parameter validation and warnings
- ✅ Professional calculation accuracy

### Coming Soon 🔜

- Flight line visualization on the map
- Manual area drawing
- Mission list and switching
- Export to DJI Pilot 2 format
- Terrain file upload
- Complete workflow integration

### Troubleshooting

**Map doesn't load?**
- Check internet connection (OpenStreetMap needs access)
- Try refreshing the page
- Check browser console (F12) for errors

**Calculations show "NaN"?**
- Make sure altitude > 0
- Make sure speed > 0
- Check that overlaps are between 0-100

**Performance issues?**
- Close other browser tabs
- Try reducing map quality in settings
- Use Chrome/Edge for best performance

### Next Steps

1. Read the full [README.md](README.md) for detailed features
2. Check [IMPLEMENTATION.md](IMPLEMENTATION.md) for technical details
3. Explore the code in `frontend/src/` to understand how it works
4. Try modifying drone specs in `frontend/src/lib/drone-specs.ts`

### Need Help?

- See comprehensive documentation in README.md
- Check implementation notes in IMPLEMENTATION.md
- Review code comments (JSDoc format)
- Open GitHub issue for bugs

---

**Tip:** The app is in active development. Core calculations and UI are complete, but some features (like 3D flight line display) are still being integrated. The fundamental flight planning engine is fully functional!
