/**
 * FlightPlanner Component
 * Right sidebar for mission planning and parameter configuration
 */

import { useState, useEffect } from 'react';
import { DRONES, type DroneSpec, type CameraSpec } from '../lib/drone-specs';
import { calculateFlightPlan } from '../lib/flight-calculations';
import { useMissionStore } from '../stores/mission-store';
import { importKMLFile, importWaypointKMLFile } from '../lib/kml-parser';
import { generateFlightLines } from '../lib/flight-path-generator';
import { getCesiumViewer, sampleTerrainForWaypoints } from '../lib/terrain-sampler';
import { exportToDJI, downloadKMZ } from '../lib/dji-wpml-exporter';
import './FlightPlanner.css';

export const FlightPlanner = () => {
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const missions = useMissionStore((state) => state.missions);
  const updateMission = useMissionStore((state) => state.updateMission);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);
  const kmlEditMode = useMissionStore((state) => state.kmlEditMode);
  const setKmlEditMode = useMissionStore((state) => state.setKmlEditMode);
  const drawAoiMode = useMissionStore((state) => state.drawAoiMode);
  const setDrawAoiMode = useMissionStore((state) => state.setDrawAoiMode);
  const drawWaypointMode = useMissionStore((state) => state.drawWaypointMode);
  const setDrawWaypointMode = useMissionStore((state) => state.setDrawWaypointMode);
  const showWaypointHeightGuides = useMissionStore((state) => state.showWaypointHeightGuides);
  const setShowWaypointHeightGuides = useMissionStore((state) => state.setShowWaypointHeightGuides);

  const activeMission = missions.find(m => m.id === activeMissionId);

  const [selectedDrone, setSelectedDrone] = useState<DroneSpec>(DRONES[0]);
  const [selectedCamera, setSelectedCamera] = useState<CameraSpec>(DRONES[0].cameras[0]);
  const [altitude, setAltitude] = useState<number>(100);
  const [speed, setSpeed] = useState<number>(8);
  const [forwardOverlap, setForwardOverlap] = useState<number>(80);
  const [sideOverlap, setSideOverlap] = useState<number>(70);
  const [flightAngle, setFlightAngle] = useState<number>(0);
  const [gimbalPitch, setGimbalPitch] = useState<number>(-90);
  const [gimbalYaw, setGimbalYaw] = useState<number>(0);
  const [droneYaw, setDroneYaw] = useState<number>(0);
  const [waypointTakePhoto, setWaypointTakePhoto] = useState<boolean>(true);
  const [waypointRecordVideo, setWaypointRecordVideo] = useState<boolean>(false);
  const [waypointHoverEnabled, setWaypointHoverEnabled] = useState<boolean>(false);
  const [waypointHoverTime, setWaypointHoverTime] = useState<number>(2);
  const [waypointAutoDroneHeading, setWaypointAutoDroneHeading] = useState<boolean>(true);
  const [waypointAutoGimbalYaw, setWaypointAutoGimbalYaw] = useState<boolean>(true);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const [showDroneConfig, setShowDroneConfig] = useState<boolean>(true);
  const [showPhotogrammetry, setShowPhotogrammetry] = useState<boolean>(true);
  const [showWaypointSettings, setShowWaypointSettings] = useState<boolean>(true);

  const [flightPlan, setFlightPlan] = useState<any>(null);

  // Load active mission parameters
  useEffect(() => {
    if (activeMission) {
      setSelectedDrone(activeMission.drone);
      setSelectedCamera(activeMission.camera);
      setAltitude(activeMission.parameters.altitude);
      setSpeed(activeMission.parameters.speed);
      setForwardOverlap(activeMission.parameters.forwardOverlap);
      setSideOverlap(activeMission.parameters.sideOverlap);
      setFlightAngle(activeMission.parameters.flightAngle);
      setGimbalPitch(activeMission.parameters.gimbalPitch);
      setGimbalYaw(activeMission.parameters.gimbalYaw ?? 0);
      setDroneYaw(activeMission.parameters.droneYaw ?? 0);
      setWaypointTakePhoto(activeMission.parameters.waypointTakePhoto ?? true);
      setWaypointRecordVideo(activeMission.parameters.waypointRecordVideo ?? false);
      setWaypointHoverEnabled(activeMission.parameters.waypointHoverEnabled ?? false);
      setWaypointHoverTime(activeMission.parameters.waypointHoverTime ?? 2);
      setWaypointAutoDroneHeading(activeMission.parameters.waypointAutoDroneHeading ?? true);
      setWaypointAutoGimbalYaw(activeMission.parameters.waypointAutoGimbalYaw ?? true);
    }
  }, [activeMissionId]);

  useEffect(() => {
    const hasEditableArea = !!activeMission?.aoi;
    const hasEditableWaypoints =
      activeMission?.missionType === 'waypoint' &&
      !!activeMission.flightLines &&
      activeMission.flightLines.length > 0 &&
      activeMission.flightLines[0].coordinates.length > 0;

    if (!hasEditableArea && !hasEditableWaypoints) {
      setKmlEditMode(false);
    }
  }, [activeMission?.id, activeMission?.aoi, activeMission?.missionType, activeMission?.flightLines, setKmlEditMode]);

  // Update flight plan calculations when parameters change
  useEffect(() => {
    if (!selectedCamera) return;

    const plan = calculateFlightPlan(
      selectedCamera,
      altitude,
      speed,
      forwardOverlap,
      sideOverlap,
      1000, // dummy distance for now
      5 // dummy number of lines
    );

    setFlightPlan(plan);
  }, [selectedCamera, altitude, speed, forwardOverlap, sideOverlap]);

  const handleDroneChange = (droneId: string) => {
    const drone = DRONES.find((d) => d.id === droneId);
    if (drone) {
      setSelectedDrone(drone);
      setSelectedCamera(drone.cameras[0]);
      setSpeed(Math.min(speed, drone.cruiseSpeed));
    }
  };

  const handleCameraChange = (cameraId: string) => {
    const camera = selectedDrone.cameras.find((c) => c.id === cameraId);
    if (camera) {
      setSelectedCamera(camera);
    }
  };

  const handleUpdateMission = () => {
    if (!activeMissionId) {
      setStatusMessage('Please select or create a mission first');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    updateMission(activeMissionId, {
      drone: selectedDrone,
      camera: selectedCamera,
      parameters: {
        altitude,
        speed,
        forwardOverlap,
        sideOverlap,
        flightAngle,
        gimbalPitch,
        gimbalYaw,
        droneYaw,
        waypointTakePhoto,
        waypointRecordVideo,
        waypointHoverEnabled,
        waypointHoverTime,
        waypointAutoDroneHeading,
        waypointAutoGimbalYaw,
      },
    });
    
    setStatusMessage('Flight parameters saved!');
    setTimeout(() => setStatusMessage(''), 3000);
  };

  const handleAltitudeChange = (newAltitude: number) => {
    setAltitude(newAltitude);

    if (!activeMissionId) return;

    updateMission(activeMissionId, {
      parameters: {
        altitude: newAltitude,
        speed,
        forwardOverlap,
        sideOverlap,
        flightAngle,
        gimbalPitch,
        gimbalYaw,
        droneYaw,
        waypointTakePhoto,
        waypointRecordVideo,
        waypointHoverEnabled,
        waypointHoverTime,
        waypointAutoDroneHeading,
        waypointAutoGimbalYaw,
      },
    });

    if (
      activeMission?.missionType === 'waypoint' &&
      activeMission.flightLines?.length > 0 &&
      activeMission.flightLines[0].coordinates.length > 0
    ) {
      const firstLine = activeMission.flightLines[0];
      const baseWaypoints = firstLine.coordinates.map((coord) => [coord[0], coord[1], newAltitude]);
      const viewer = getCesiumViewer();

      const applyWaypointAltitude = async () => {
        const updatedWaypoints = viewer
          ? await sampleTerrainForWaypoints(viewer, baseWaypoints, newAltitude)
          : baseWaypoints;

        updateMission(activeMissionId, {
          flightLines: [
            {
              ...firstLine,
              coordinates: updatedWaypoints,
            },
            ...activeMission.flightLines.slice(1),
          ],
        });
      };

      applyWaypointAltitude().catch((error) => {
        console.error('Failed to update waypoint altitude:', error);
      });
    }
  };

  const handleExportToDJI = async () => {
    if (!activeMission) {
      setStatusMessage('Please select a mission first');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    if (!activeMission.flightLines || activeMission.flightLines.length === 0) {
      setStatusMessage('Generate flight plan first');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    try {
      setStatusMessage('Exporting to DJI WPML format...');
      const kmzBlob = await exportToDJI(activeMission);
      downloadKMZ(kmzBlob, activeMission.name || 'mission');
      setStatusMessage('✓ Export successful! File downloaded.');
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (error) {
      console.error('Export error:', error);
      setStatusMessage(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setTimeout(() => setStatusMessage(''), 5000);
    }
  };

  const handleImportKML = async () => {
    if (!activeMissionId) {
      setStatusMessage('Please select or create a mission first');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.kml,.kmz';
      input.onchange = async (e: any) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const result = await importKMLFile(file);
        const firstPolygon = result[0];

        if (!firstPolygon) {
          setStatusMessage('No valid polygon found in KML file');
          setTimeout(() => setStatusMessage(''), 3000);
          return;
        }

        updateMission(activeMissionId, {
          missionType: 'area',
          aoi: {
            type: 'kml',
            coordinates: firstPolygon.coordinates,
            name: firstPolygon.name,
          },
          flightLines: [],
        });

        // Calculate center and bounding box for camera positioning
        const lons = firstPolygon.coordinates.map(coord => coord[0]);
        const lats = firstPolygon.coordinates.map(coord => coord[1]);
        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        
        const centerLon = (minLon + maxLon) / 2;
        const centerLat = (minLat + maxLat) / 2;
        
        // Calculate rough distance to determine altitude
        const lonDiff = maxLon - minLon;
        const latDiff = maxLat - minLat;
        const maxDiff = Math.max(lonDiff, latDiff);
        // Approximate altitude based on area size (in degrees)
        const altitude = maxDiff * 100000; // Rough conversion to meters

        // Fly camera to imported area with nadir view
        setCameraTarget({
          longitude: centerLon,
          latitude: centerLat,
          altitude: Math.max(altitude, 1000), // Minimum 1km altitude
          heading: 0,
          pitch: -90, // Nadir view (looking straight down)
          roll: 0,
        });

        setStatusMessage(`KML imported: ${firstPolygon.name}`);
        setTimeout(() => setStatusMessage(''), 3000); // Clear after 3 seconds
      };
      input.click();
    } catch (error) {
      console.error('KML import failed:', error);
      setStatusMessage('Failed to import KML file');
      setTimeout(() => setStatusMessage(''), 3000);
    }
  };

  const handleImportWaypointKML = async () => {
    if (!activeMissionId) {
      setStatusMessage('Please select or create a mission first');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.kml,.kmz';
      input.onchange = async (e: any) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const waypointSet = await importWaypointKMLFile(file);

        if (!waypointSet || waypointSet.coordinates.length < 2) {
          setStatusMessage('No valid waypoint points found in KML file');
          setTimeout(() => setStatusMessage(''), 3000);
          return;
        }

        const viewer = getCesiumViewer();
        const baseWaypoints = waypointSet.coordinates.map((coord) => [coord[0], coord[1], altitude]);
        const terrainAdjustedWaypoints = viewer
          ? await sampleTerrainForWaypoints(viewer, baseWaypoints, altitude)
          : baseWaypoints;

        updateMission(activeMissionId, {
          missionType: 'waypoint',
          aoi: null,
          flightLines: [
            {
              id: 'waypoint-import-0',
              coordinates: terrainAdjustedWaypoints,
              photoPoints: [],
            },
          ],
        });

        const lons = waypointSet.coordinates.map(coord => coord[0]);
        const lats = waypointSet.coordinates.map(coord => coord[1]);
        const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;
        const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;

        setCameraTarget({
          longitude: centerLon,
          latitude: centerLat,
          altitude: 2000,
          heading: 0,
          pitch: -90,
          roll: 0,
        });

        setStatusMessage(`Waypoint KML imported: ${waypointSet.coordinates.length} points`);
        setTimeout(() => setStatusMessage(''), 3000);
      };
      input.click();
    } catch (error) {
      console.error('Waypoint KML import failed:', error);
      setStatusMessage('Failed to import waypoint KML file');
      setTimeout(() => setStatusMessage(''), 3000);
    }
  };

  const handleDrawAOI = () => {
    if (!activeMissionId) {
      setStatusMessage('Please select or create a mission first');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    const nextMode = !drawAoiMode;
    setDrawAoiMode(nextMode);

    if (nextMode) {
      setKmlEditMode(false);
      setDrawWaypointMode(false);
      updateMission(activeMissionId, { missionType: 'area', aoi: activeMission?.aoi ?? null });
      setStatusMessage('Draw mode enabled: click to add points, right-click to finish polygon');
    } else {
      setStatusMessage('Draw mode canceled');
    }

    setTimeout(() => setStatusMessage(''), 4000);
  };

  const handleDrawWaypoint = () => {
    if (!activeMissionId) {
      setStatusMessage('Please select or create a mission first');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    const nextMode = !drawWaypointMode;
    setDrawWaypointMode(nextMode);

    if (nextMode) {
      setKmlEditMode(false);
      setDrawAoiMode(false);
      updateMission(activeMissionId, { missionType: 'waypoint', aoi: null });
      setStatusMessage('Waypoint draw enabled: click to add points, right-click to finish');
    } else {
      setStatusMessage('Waypoint draw canceled');
    }

    setTimeout(() => setStatusMessage(''), 4000);
  };

  const handleStartKMLEdit = () => {
    const hasEditableTarget =
      !!activeMission?.aoi ||
      (activeMission?.missionType === 'waypoint' &&
        !!activeMission.flightLines &&
        activeMission.flightLines.length > 0 &&
        activeMission.flightLines[0].coordinates.length > 0);

    if (!hasEditableTarget) return;
    setKmlEditMode(true);
    setStatusMessage('Area edit mode enabled. Drag points on the map.');
    setTimeout(() => setStatusMessage(''), 3000);
  };

  const handleSaveKMLEdit = () => {
    setKmlEditMode(false);
    setStatusMessage('KML points saved.');
    setTimeout(() => setStatusMessage(''), 3000);
  };

  const handleDeleteKML = () => {
    if (!activeMissionId || !activeMission) return;

    if (activeMission.missionType === 'waypoint') {
      if (!confirm('Delete imported waypoints for this mission?')) return;

      setKmlEditMode(false);
      updateMission(activeMissionId, {
        flightLines: [],
      });
      setStatusMessage('Waypoints deleted.');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    if (!activeMission.aoi) return;
    if (!confirm('Delete area for this mission?')) return;

    setKmlEditMode(false);
    updateMission(activeMissionId, {
      aoi: null,
      flightLines: [],
    });
    setStatusMessage('KML area deleted.');
    setTimeout(() => setStatusMessage(''), 3000);
  };

  const handleGenerateFlightPlan = async () => {
    if (activeMission?.missionType === 'waypoint') {
      setStatusMessage('Waypoint missions do not use photogrammetry generation');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    if (!activeMissionId || !activeMission?.aoi) {
      setStatusMessage('Please import KML or draw an area first');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    try {
      // Calculate line spacing and photo interval from flight parameters
      const footprintWidth = (selectedCamera.sensorWidth * altitude) / selectedCamera.focalLength;
      const footprintHeight = (selectedCamera.sensorHeight * altitude) / selectedCamera.focalLength;
      
      console.log('Flight plan parameters:', {
        altitude,
        speed,
        forwardOverlap,
        sideOverlap,
        flightAngle,
        footprintWidth,
        footprintHeight,
        camera: selectedCamera.name
      });
      
      const lineSpacing = footprintWidth * (1 - sideOverlap / 100);
      const photoInterval = (footprintHeight * (1 - forwardOverlap / 100)) / speed;

      console.log('Calculated values:', { lineSpacing, photoInterval });

      const flightPlanResult = generateFlightLines(
        activeMission.aoi.coordinates,
        lineSpacing,
        flightAngle,
        altitude,
        photoInterval,
        speed
      );

      console.log('Flight plan result:', flightPlanResult);

      // Get Cesium viewer for terrain sampling
      const viewer = getCesiumViewer();
      
      // Convert FlightLine format and apply terrain-following
      const convertedLines = await Promise.all(
        flightPlanResult.lines.map(async (line) => {
          const waypoints = line.waypoints.map(wp => [wp.lon, wp.lat, wp.alt]);
          
          // Apply terrain-following if terrain data is available
          const terrainWaypoints = viewer 
            ? await sampleTerrainForWaypoints(viewer, waypoints, altitude)
            : waypoints;
          
          const photoPoints = line.waypoints
            .filter(wp => wp.action === 'photo')
            .map((wp) => {
              const wpIndex = line.waypoints.indexOf(wp);
              return terrainWaypoints[wpIndex];
            });
          
          return {
            id: line.id,
            coordinates: terrainWaypoints,
            photoPoints: photoPoints,
          };
        })
      );

      console.log('Converted lines with terrain-following:', convertedLines);
      console.log('Active mission before update:', activeMission);

      updateMission(activeMissionId, {
        flightLines: convertedLines,
      });
      
      // Verify update
      setTimeout(() => {
        const updatedMission = missions.find(m => m.id === activeMissionId);
        console.log('Mission after update:', updatedMission);
        console.log('Flight lines in mission:', updatedMission?.flightLines);
      }, 100);

      setStatusMessage(`Flight plan generated: ${flightPlanResult.lines.length} lines, ${flightPlanResult.numPhotos} photos`);
      setTimeout(() => setStatusMessage(''), 5000);
      
      console.log(`Flight plan generated: ${flightPlanResult.lines.length} lines, ${flightPlanResult.numPhotos} photos, ${(flightPlanResult.totalDistance / 1000).toFixed(2)} km`);
    } catch (error) {
      console.error('Flight plan generation failed:', error);
      setStatusMessage('Failed to generate flight plan: ' + (error as Error).message);
      setTimeout(() => setStatusMessage(''), 5000);
    }
  };

  // Check if no mission is selected
  if (!activeMissionId) {
    return (
      <div className="flight-planner">
        <h2>Flight Planning</h2>
        <div className="empty-state">
          <p>No mission selected.</p>
          <p>Create or select a mission from the Mission Manager to start planning.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flight-planner">
      <h2>Flight Planning</h2>

      {/* Status Messages */}
      {statusMessage && (
        <div className="status-banner" style={{
          padding: '10px 15px',
          marginBottom: '15px',
          backgroundColor: statusMessage.includes('Failed') ? '#ef4444' : '#10b981',
          color: 'white',
          borderRadius: '6px',
          fontSize: '14px',
          fontWeight: '500',
        }}>
          {statusMessage}
        </div>
      )}

      {/* Step 1: Area of Interest */}
      <section className="planner-section">
        <h3>1. Area of Interest</h3>
        
        {activeMission?.aoi ? (
          <div className="aoi-status">
            <div className="status-message success">
              ✓ Area loaded: <strong>{activeMission.aoi.name}</strong>
            </div>
            <div className="aoi-actions">
              <button className="btn-primary" onClick={handleImportKML}>
                📂 Import Area Mission KML
              </button>
              <button className="btn-primary" onClick={handleImportWaypointKML}>
                📍 Import Waypoint KML
              </button>
              <button className="btn-primary" onClick={handleDrawWaypoint}>
                {drawWaypointMode ? '❌ Cancel Waypoint Draw' : '➕ Add Waypoint'}
              </button>
              <button className="btn-primary" onClick={handleDrawAOI}>
                {drawAoiMode ? '❌ Cancel Draw' : '✏️ Draw Mission Area'}
              </button>
            </div>
            {activeMission.aoi && (
              <div className="mission-tools-line" aria-label="KML toolbar">
                <div className="kml-toolbar kml-toolbar-inline">
                  <button
                    className="kml-tool-btn kml-delete"
                    onClick={handleDeleteKML}
                    title="Delete Area"
                  >
                    🗑️
                  </button>
                  <button
                    className={`kml-tool-btn ${kmlEditMode ? 'active' : ''}`}
                    onClick={handleStartKMLEdit}
                    disabled={kmlEditMode}
                    title="Edit Area"
                  >
                    ✏️
                  </button>
                  <button
                    className="kml-tool-btn kml-save"
                    onClick={handleSaveKMLEdit}
                    disabled={!kmlEditMode}
                    title="Save Area"
                  >
                    💾
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="aoi-status">
            {activeMission?.missionType === 'waypoint' && activeMission.flightLines.length > 0 ? (
              <div className="status-message success">
                ✓ Waypoint route loaded: <strong>{activeMission.flightLines[0]?.coordinates.length || 0}</strong> points
              </div>
            ) : (
              <div className="status-message warning">
                ⚠ No area defined
              </div>
            )}
            <div className="aoi-actions">
              <button className="btn-primary" onClick={handleImportKML}>
                📂 Import Area Mission KML
              </button>
              <button className="btn-primary" onClick={handleImportWaypointKML}>
                📍 Import Waypoint KML
              </button>
              <button className="btn-primary" onClick={handleDrawWaypoint}>
                {drawWaypointMode ? '❌ Cancel Waypoint Draw' : '➕ Add Waypoint'}
              </button>
              <button className="btn-primary" onClick={handleDrawAOI}>
                {drawAoiMode ? '❌ Cancel Draw' : '✏️ Draw Mission Area'}
              </button>
            </div>

            {activeMission?.missionType === 'waypoint' && activeMission.flightLines.length > 0 && (
              <div className="mission-tools-line" aria-label="Waypoint toolbar">
                <div className="kml-toolbar kml-toolbar-inline">
                  <button
                    className="kml-tool-btn kml-delete"
                    onClick={handleDeleteKML}
                    title="Delete Waypoints"
                  >
                    🗑️
                  </button>
                  <button
                    className={`kml-tool-btn ${kmlEditMode ? 'active' : ''}`}
                    onClick={handleStartKMLEdit}
                    disabled={kmlEditMode}
                    title="Edit Waypoints"
                  >
                    ✏️
                  </button>
                  <button
                    className="kml-tool-btn kml-save"
                    onClick={handleSaveKMLEdit}
                    disabled={!kmlEditMode}
                    title="Save Waypoints"
                  >
                    💾
                  </button>
                </div>
                <label className="inline-toggle waypoint-guide-toggle">
                  <input
                    type="checkbox"
                    checked={showWaypointHeightGuides}
                    onChange={(e) => setShowWaypointHeightGuides(e.target.checked)}
                    disabled={!kmlEditMode}
                  />
                  Height guides
                </label>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Step 2: Drone Configuration */}
      <section className="planner-section">
        <h3 className="section-title-row" onClick={() => setShowDroneConfig(!showDroneConfig)}>
          2. Drone Configuration <span>{showDroneConfig ? '▾' : '▸'}</span>
        </h3>

        {showDroneConfig && (
          <>
            <label>
              Drone Model:
              <select value={selectedDrone.id} onChange={(e) => handleDroneChange(e.target.value)}>
                {DRONES.map((drone) => (
                  <option key={drone.id} value={drone.id}>
                    {drone.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Camera/Payload:
              <select value={selectedCamera.id} onChange={(e) => handleCameraChange(e.target.value)}>
                {selectedDrone.cameras.map((camera) => (
                  <option key={camera.id} value={camera.id}>
                    {camera.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="camera-info">
              <small>
                Sensor: {selectedCamera.sensorWidth}×{selectedCamera.sensorHeight}mm |
                Resolution: {selectedCamera.imageWidth}×{selectedCamera.imageHeight}px |
                Focal: {selectedCamera.focalLength}mm
              </small>
            </div>
          </>
        )}
      </section>

      {/* Common Flight Parameters */}
      <section className="planner-section">
        <h3>3. Common Flight Parameters</h3>

        <label>
          Altitude (m AGL):
          <div className="range-control-row">
            <input
              className="range-number-input"
              type="number"
              value={altitude}
              onChange={(e) => handleAltitudeChange(Number(e.target.value))}
              min="1"
              max="200"
              step="1"
            />
            <input
              className="range-slider-input"
              type="range"
              value={altitude}
              onChange={(e) => handleAltitudeChange(Number(e.target.value))}
              min="1"
              max="200"
              step="1"
            />
          </div>
        </label>

        <label>
          Flight Speed (m/s):
          <div className="range-control-row">
            <input
              className="range-number-input"
              type="number"
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              min="1"
              max="15"
              step="0.5"
            />
            <input
              className="range-slider-input"
              type="range"
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              min="1"
              max="15"
              step="0.5"
            />
          </div>
          {activeMission?.missionType === 'area' && flightPlan?.hasSpeedWarning && (
            <span className="warning">⚠️ Speed may cause blur</span>
          )}
        </label>
      </section>

      {/* Photogrammetry Parameters */}
      <section className="planner-section">
        <h3 className="section-title-row" onClick={() => setShowPhotogrammetry(!showPhotogrammetry)}>
          4. Photogrammetry Parameters <span>{showPhotogrammetry ? '▾' : '▸'}</span>
        </h3>

        {showPhotogrammetry && (
          <>
            {activeMission?.missionType === 'waypoint' ? (
              <div className="status-message warning">Disabled for waypoint missions</div>
            ) : (
              <>
                <label>
                  Forward Overlap (%):
                  <input
                    type="number"
                    value={forwardOverlap}
                    onChange={(e) => setForwardOverlap(Number(e.target.value))}
                    min="50"
                    max="95"
                    step="5"
                  />
                </label>

                <label>
                  Side Overlap (%):
                  <input
                    type="number"
                    value={sideOverlap}
                    onChange={(e) => setSideOverlap(Number(e.target.value))}
                    min="50"
                    max="90"
                    step="5"
                  />
                </label>

                <label>
                  Flight Angle (°):
                  <input
                    type="number"
                    value={flightAngle}
                    onChange={(e) => setFlightAngle(Number(e.target.value))}
                    min="0"
                    max="359"
                    step="1"
                  />
                </label>
              </>
            )}
          </>
        )}
      </section>

      {/* Waypoint Mission Parameters */}
      <section className="planner-section">
        <h3 className="section-title-row" onClick={() => setShowWaypointSettings(!showWaypointSettings)}>
          5. Waypoint Settings <span>{showWaypointSettings ? '▾' : '▸'}</span>
        </h3>

        {showWaypointSettings && (
          <>
            {activeMission?.missionType !== 'waypoint' ? (
              <div className="status-message warning">Enable by importing waypoint KML</div>
            ) : (
              <div className="waypoint-settings-layout">
                <div className="waypoint-field-row">
                  <label className="waypoint-compact-field">
                    Drone Yaw (°):
                    <input
                      type="number"
                      value={droneYaw}
                      onChange={(e) => setDroneYaw(Number(e.target.value))}
                      min="-180"
                      max="180"
                      step="1"
                      disabled={waypointAutoDroneHeading}
                    />
                  </label>

                  <label className="waypoint-inline-toggle">
                    <input
                      type="checkbox"
                      checked={waypointAutoDroneHeading}
                      onChange={(e) => setWaypointAutoDroneHeading(e.target.checked)}
                    />
                    Auto Drone Heading (Follow Wayline)
                  </label>
                </div>

                <label className="waypoint-compact-field">
                  Gimbal Pitch (°):
                  <input
                    type="number"
                    value={gimbalPitch}
                    onChange={(e) => setGimbalPitch(Number(e.target.value))}
                    min="-120"
                    max="30"
                    step="1"
                  />
                </label>

                <div className="waypoint-field-row">
                  <label className="waypoint-compact-field">
                    Gimbal Yaw (°):
                    <input
                      type="number"
                      value={gimbalYaw}
                      onChange={(e) => setGimbalYaw(Number(e.target.value))}
                      min="-180"
                      max="180"
                      step="1"
                      disabled={waypointAutoGimbalYaw}
                    />
                  </label>

                  <label className="waypoint-inline-toggle">
                    <input
                      type="checkbox"
                      checked={waypointAutoGimbalYaw}
                      onChange={(e) => setWaypointAutoGimbalYaw(e.target.checked)}
                    />
                    Auto Gimbal Yaw (Default)
                  </label>
                </div>

                <label>
                  <span>Take Photo at Waypoints</span>
                  <select
                    value={waypointTakePhoto ? 'yes' : 'no'}
                    onChange={(e) => setWaypointTakePhoto(e.target.value === 'yes')}
                  >
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>

                <label>
                  <span>Record Video (Start/Stop)</span>
                  <select
                    value={waypointRecordVideo ? 'yes' : 'no'}
                    onChange={(e) => setWaypointRecordVideo(e.target.value === 'yes')}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </label>

                <label>
                  <span>Hover at Waypoints</span>
                  <select
                    value={waypointHoverEnabled ? 'yes' : 'no'}
                    onChange={(e) => setWaypointHoverEnabled(e.target.value === 'yes')}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </label>

                {waypointHoverEnabled && (
                  <label>
                    Hover Time (s):
                    <input
                      type="number"
                      value={waypointHoverTime}
                      onChange={(e) => setWaypointHoverTime(Number(e.target.value))}
                      min="1"
                      max="120"
                      step="1"
                    />
                  </label>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* Calculated Results */}
      {activeMission?.missionType !== 'waypoint' && flightPlan && (
        <section className="planner-section results">
          <h3>Calculated Results</h3>

          <div className="result-grid">
            <div className="result-item">
              <span className="result-label">GSD:</span>
              <span className="result-value">{flightPlan.gsd.toFixed(2)} cm/px</span>
            </div>

            <div className="result-item">
              <span className="result-label">Photo Interval:</span>
              <span className="result-value">{flightPlan.photoInterval.toFixed(1)} sec</span>
            </div>

            <div className="result-item">
              <span className="result-label">Line Spacing:</span>
              <span className="result-value">{flightPlan.lineSpacing.toFixed(1)} m</span>
            </div>

            <div className="result-item">
              <span className="result-label">Footprint:</span>
              <span className="result-value">
                {flightPlan.footprint.width.toFixed(1)}×{flightPlan.footprint.height.toFixed(1)} m
              </span>
            </div>

            <div className="result-item">
              <span className="result-label">Blur Factor:</span>
              <span className={`result-value ${flightPlan.blurFactor > 1 ? 'warning' : ''}`}>
                {flightPlan.blurFactor.toFixed(2)} px
                {flightPlan.blurFactor > 1 && ' ⚠️'}
              </span>
            </div>

            <div className="result-item">
              <span className="result-label">Max Safe Speed:</span>
              <span className="result-value">{flightPlan.maxSafeSpeed.toFixed(1)} m/s</span>
            </div>

            <div className="result-item">
              <span className="result-label">Est. Photos:</span>
              <span className="result-value">{flightPlan.photoCount}</span>
            </div>

            <div className="result-item">
              <span className="result-label">Est. Flight Time:</span>
              <span className="result-value">{flightPlan.timeEstimate.totalTime.toFixed(1)} min</span>
            </div>
          </div>
        </section>
      )}

      {/* Generated Flight Plan Summary */}
      {activeMission?.flightLines && activeMission.flightLines.length > 0 && (
        <section className="planner-section">
          <h3>📋 Flight Plan Summary</h3>
          <div className="calculated-results">
            <div className="result-item">
              <span className="result-label">Flight Lines:</span>
              <span className="result-value">{activeMission.flightLines.length}</span>
            </div>
            
            <div className="result-item">
              <span className="result-label">Photo Points:</span>
              <span className="result-value">
                {activeMission.flightLines.reduce((sum, line) => sum + (line.photoPoints?.length || 0), 0)}
              </span>
            </div>

            <div className="result-item">
              <span className="result-label">Total Waypoints:</span>
              <span className="result-value">
                {activeMission.flightLines.reduce((sum, line) => sum + line.coordinates.length, 0)}
              </span>
            </div>

            <div className="result-item">
              <span className="result-label">Mission Status:</span>
              <span className="result-value" style={{ color: '#4ade80' }}>✓ Ready to Export</span>
            </div>
          </div>
        </section>
      )}

      {/* Action Buttons */}
      <section className="planner-section actions">
        <button 
          className="btn-primary" 
          onClick={handleGenerateFlightPlan}
          disabled={!activeMission?.aoi || activeMission?.missionType === 'waypoint'}
          title={activeMission?.missionType === 'waypoint' ? 'Disabled for waypoint missions' : !activeMission?.aoi ? 'Import KML or draw an area first' : 'Generate flight lines'}
        >
          🚁 Generate Flight Plan
        </button>
        
        <button 
          className="btn-secondary"
          onClick={handleUpdateMission}
        >
          💾 Save Parameters
        </button>
        
        <button 
          className="btn-secondary"
          onClick={() => handleExportToDJI()}
          disabled={!activeMission?.flightLines || activeMission.flightLines.length === 0}
          title={!activeMission?.flightLines?.length ? 'Generate flight plan first' : 'Export to DJI Pilot 2'}
        >
          📤 Export to DJI
        </button>
      </section>
    </div>
  );
};
