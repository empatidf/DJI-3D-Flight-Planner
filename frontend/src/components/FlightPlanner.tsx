/**
 * FlightPlanner Component
 * Right sidebar for mission planning and parameter configuration
 */

import { useState, useEffect } from 'react';
import { DRONES, type DroneSpec, type CameraSpec } from '../lib/drone-specs';
import { calculateFlightPlan } from '../lib/flight-calculations';
import { useMissionStore } from '../stores/mission-store';
import { importKMLFile } from '../lib/kml-parser';
import { generateFlightLines } from '../lib/flight-path-generator';
import { getCesiumViewer, sampleTerrainForWaypoints } from '../lib/terrain-sampler';
import './FlightPlanner.css';

export const FlightPlanner = () => {
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const missions = useMissionStore((state) => state.missions);
  const updateMission = useMissionStore((state) => state.updateMission);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);

  const activeMission = missions.find(m => m.id === activeMissionId);

  const [selectedDrone, setSelectedDrone] = useState<DroneSpec>(DRONES[0]);
  const [selectedCamera, setSelectedCamera] = useState<CameraSpec>(DRONES[0].cameras[0]);
  const [altitude, setAltitude] = useState<number>(100);
  const [speed, setSpeed] = useState<number>(8);
  const [forwardOverlap, setForwardOverlap] = useState<number>(80);
  const [sideOverlap, setSideOverlap] = useState<number>(70);
  const [flightAngle, setFlightAngle] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');

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
    }
  }, [activeMissionId]);

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
        gimbalPitch: -90,
      },
    });
    
    setStatusMessage('Flight parameters saved!');
    setTimeout(() => setStatusMessage(''), 3000);
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
          aoi: {
            type: 'kml',
            coordinates: firstPolygon.coordinates,
            name: firstPolygon.name,
          },
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

  const handleDrawAOI = () => {
    setStatusMessage('Drawing tools coming soon!');
    setTimeout(() => setStatusMessage(''), 3000);
  };

  const handleGenerateFlightPlan = async () => {
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
              <button className="btn-secondary" onClick={handleImportKML}>
                📂 Replace with KML
              </button>
              <button className="btn-secondary" onClick={handleDrawAOI}>
                ✏️ Draw New Area
              </button>
            </div>
          </div>
        ) : (
          <div className="aoi-status">
            <div className="status-message warning">
              ⚠ No area defined
            </div>
            <div className="aoi-actions">
              <button className="btn-primary" onClick={handleImportKML}>
                📂 Import KML/KMZ
              </button>
              <button className="btn-primary" onClick={handleDrawAOI}>
                ✏️ Draw on Map
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Step 2: Drone Configuration */}
      <section className="planner-section">
        <h3>2. Drone Configuration</h3>
        
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
      </section>

      {/* Flight Parameters */}
      <section className="planner-section">
        <h3>3. Flight Parameters</h3>

        <label>
          Altitude (m AGL):
          <input
            type="number"
            value={altitude}
            onChange={(e) => {
              const newAltitude = Number(e.target.value);
              setAltitude(newAltitude);
              // Update mission immediately for real-time KML overlay height changes
              if (activeMissionId) {
                updateMission(activeMissionId, {
                  parameters: {
                    altitude: newAltitude,
                    speed,
                    forwardOverlap,
                    sideOverlap,
                    flightAngle,
                    gimbalPitch: -90,
                  },
                });
              }
            }}
            min="10"
            max={selectedDrone.maxAltitude}
            step="5"
          />
        </label>

        <label>
          Flight Speed (m/s):
          <input
            type="number"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            min="1"
            max={selectedDrone.maxSpeed}
            step="0.5"
          />
          {flightPlan?.hasSpeedWarning && (
            <span className="warning">⚠️ Speed may cause blur</span>
          )}
        </label>

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
      </section>

      {/* Calculated Results */}
      {flightPlan && (
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
          disabled={!activeMission?.aoi}
          title={!activeMission?.aoi ? 'Import KML or draw an area first' : 'Generate flight lines'}
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
          disabled={!activeMission?.flightLines || activeMission.flightLines.length === 0}
          title={!activeMission?.flightLines?.length ? 'Generate flight plan first' : 'Export to DJI Pilot 2'}
        >
          📤 Export to DJI
        </button>
      </section>
    </div>
  );
};
