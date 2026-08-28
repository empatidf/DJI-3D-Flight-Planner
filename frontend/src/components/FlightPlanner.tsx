/**
 * FlightPlanner Component
 * Right sidebar for mission planning and parameter configuration
 */

import { useState, useEffect, useRef } from 'react';
import { DRONES, type DroneSpec, type CameraSpec } from '../lib/drone-specs';
import { calculateFlightPlan } from '../lib/flight-calculations';
import { useMissionStore } from '../stores/mission-store';
import type { FlightParameters } from '../stores/mission-store';
import { importKMLFile, importWaypointKMLFile } from '../lib/kml-parser';
import { generateFlightLines } from '../lib/flight-path-generator';
import { getCesiumViewer, sampleTerrainForWaypoints, sampleTerrainWithSubPoints, decimateByElevationTolerance } from '../lib/terrain-sampler';
import { exportToDJI, downloadKMZ, normalizeYaw } from '../lib/dji-wpml-exporter';
import { calculateDistance } from '../lib/coordinate-transform';
import { SelectedWaypointPanel } from './WaypointEditors';
import { APP_VERSION } from '../version';
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
  const addTakeoffPointMode = useMissionStore((state) => state.addTakeoffPointMode);
  const setAddTakeoffPointMode = useMissionStore((state) => state.setAddTakeoffPointMode);
  const showAreaHeightGuides = useMissionStore((state) => state.showAreaHeightGuides);
  const setShowAreaHeightGuides = useMissionStore((state) => state.setShowAreaHeightGuides);
  const showWaypointHeightGuides = useMissionStore((state) => state.showWaypointHeightGuides);
  const setShowWaypointHeightGuides = useMissionStore((state) => state.setShowWaypointHeightGuides);
  const requestCollisionAnalysis = useMissionStore((state) => state.requestCollisionAnalysis);
  const clearCollisionAnalysis = useMissionStore((state) => state.clearCollisionAnalysis);
  const collisionStatus = useMissionStore((state) => state.collisionStatus);
  const collisionRiskCount = useMissionStore((state) => state.collisionRiskCount);
  const collisionProgress = useMissionStore((state) => state.collisionProgress);
  const collisionEffInterval = useMissionStore((state) => state.collisionEffInterval);

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
  const [waypointTakePhoto, setWaypointTakePhoto] = useState<boolean>(false);
  const [waypointRecordVideo, setWaypointRecordVideo] = useState<boolean>(false);
  const [waypointHoverEnabled, setWaypointHoverEnabled] = useState<boolean>(false);
  const [waypointHoverTime, setWaypointHoverTime] = useState<number>(2);
  const [waypointAutoDroneHeading, setWaypointAutoDroneHeading] = useState<boolean>(true);
  // DJI Pilot 2 route defaults: "Aircraft Yaw" and "Gimbal Control".
  const [globalHeadingMode, setGlobalHeadingMode] =
    useState<'followWayline' | 'manually' | 'smoothTransition'>('manually');
  const [gimbalPitchMode, setGimbalPitchMode] = useState<'manual' | 'usePointSetting'>('manual');
  const [waypointAutoGimbalYaw, setWaypointAutoGimbalYaw] = useState<boolean>(false);
  const [waypointTurnDistance, setWaypointTurnDistance] = useState<number>(0.2);
  const [alwaysTerrainFollow, setAlwaysTerrainFollow] = useState<boolean>(false);
  const [terrainFollowAccuracy, setTerrainFollowAccuracy] = useState<number>(2);
  const [terrainFollowMinDist, setTerrainFollowMinDist] = useState<number>(2);
  const [terrainFollowSkipPoints, setTerrainFollowSkipPoints] = useState<number>(1);
  const [elevationToleranceEnabled, setElevationToleranceEnabled] = useState<boolean>(false);
  const [elevationTolerance, setElevationTolerance] = useState<number>(1);
  const [isTerrainCalculating, setIsTerrainCalculating] = useState<boolean>(false);
  const [terrainCalcProgress, setTerrainCalcProgress] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<string>('');

  const [showDroneConfig, setShowDroneConfig] = useState<boolean>(true);
  const [showPhotogrammetry, setShowPhotogrammetry] = useState<boolean>(true);
  const [showWaypointSettings, setShowWaypointSettings] = useState<boolean>(true);
  const [showCollisionAnalysis, setShowCollisionAnalysis] = useState<boolean>(false);
  const [collisionThreshold, setCollisionThreshold] = useState<number>(2);
  const [collisionInterval, setCollisionInterval] = useState<number>(0.1);
  const [collisionSkipPoints, setCollisionSkipPoints] = useState<number>(0);
  const [realtimeFlightPreviewEnabled, setRealtimeFlightPreviewEnabled] = useState<boolean>(false);
  const [isPanelCollapsed, setIsPanelCollapsed] = useState<boolean>(false);

  const [flightPlan, setFlightPlan] = useState<any>(null);
  const realtimePreviewFrameRef = useRef<number | null>(null);
  const realtimePreviewRequestRef = useRef<number>(0);

  const buildTerrainAdjustedAreaPlan = async (aoiCoordinates: number[][]) => {
    // Camera orientation convention (image top = flight direction):
    //   sensorWidth  (long/wide axis) → left-right in image → CROSS-TRACK → line spacing (side overlap)
    //   sensorHeight (short axis)     → top-bottom in image → ALONG-TRACK → photo interval (forward overlap)
    // Example: flying North at 0° → wide axis faces East-West, short axis faces North-South.
    const footprintWidth = (selectedCamera.sensorWidth * altitude) / selectedCamera.focalLength;
    const footprintHeight = (selectedCamera.sensorHeight * altitude) / selectedCamera.focalLength;
    const lineSpacing = footprintWidth * (1 - sideOverlap / 100);
    const photoInterval = (footprintHeight * (1 - forwardOverlap / 100)) / speed;

    if (!Number.isFinite(lineSpacing) || !Number.isFinite(photoInterval) || lineSpacing <= 0 || photoInterval <= 0) {
      throw new Error('Invalid photogrammetry parameters for flight plan generation');
    }

    const flightPlanResult = generateFlightLines(
      aoiCoordinates,
      lineSpacing,
      flightAngle,
      altitude,
      photoInterval,
      speed
    );

    const viewer = getCesiumViewer();
    const convertedLines = await Promise.all(
      flightPlanResult.lines.map(async (line) => {
        const waypoints = line.waypoints.map((wp) => [wp.lon, wp.lat, wp.alt]);

        let terrainWaypoints: number[][];
        if (viewer && alwaysTerrainFollow) {
          // Terrain-follow mode: sub-sample between waypoints for true terrain following
          // Area missions have no transit leg (points are generated on-site), so never skip.
          terrainWaypoints = await sampleTerrainWithSubPoints(viewer, waypoints, altitude, terrainFollowAccuracy, terrainFollowMinDist, 0);
        } else if (viewer) {
          terrainWaypoints = await sampleTerrainForWaypoints(viewer, waypoints, altitude);
        } else {
          terrainWaypoints = waypoints;
        }

        // Elevation Tolerance (area-only): skip redundant points on flat terrain to keep the
        // point count low (avoids DJI Pilot 2 freezing). Runs on the standard 1:1 sampled path,
        // so photo points map cleanly back to the original waypoint actions by index.
        if (elevationToleranceEnabled && !alwaysTerrainFollow && terrainWaypoints.length === waypoints.length) {
          const keep = decimateByElevationTolerance(terrainWaypoints, elevationTolerance);
          return {
            id: line.id,
            coordinates: keep.map((i) => terrainWaypoints[i]),
            photoPoints: keep
              .filter((i) => line.waypoints[i]?.action === 'photo')
              .map((i) => terrainWaypoints[i]),
          };
        }

        // For photo points, use the original waypoint indices mapped to the terrain-adjusted array.
        // When sub-sampling is active, the array is larger, so we identify photo points
        // by matching the original photo waypoint positions to the nearest point in the result.
        let photoPoints: number[][];
        if (alwaysTerrainFollow && terrainWaypoints.length !== waypoints.length) {
          // With sub-sampling, photo waypoints may not have a 1:1 index mapping.
          // Match each original photo waypoint to the closest point in the sub-sampled result.
          const photoWaypoints = line.waypoints.filter((wp) => wp.action === 'photo');
          photoPoints = photoWaypoints.map((pw) => {
            let bestDist = Infinity;
            let bestPoint = terrainWaypoints[0];
            for (const tp of terrainWaypoints) {
              const dLon = tp[0] - pw.lon;
              const dLat = tp[1] - pw.lat;
              const dist = dLon * dLon + dLat * dLat;
              if (dist < bestDist) {
                bestDist = dist;
                bestPoint = tp;
              }
            }
            return bestPoint;
          });
        } else {
          photoPoints = line.waypoints
            .map((wp, index) => ({ wp, index }))
            .filter(({ wp }) => wp.action === 'photo')
            .map(({ index }) => terrainWaypoints[index]);
        }

        return {
          id: line.id,
          coordinates: terrainWaypoints,
          photoPoints,
        };
      })
    );

    // Prepend takeoff point as first waypoint of the first flight line (no photo action)
    const takeoffPoint = useMissionStore.getState().missions.find(m => m.id === activeMissionId)?.takeoffPoint ?? null;
    if (takeoffPoint && convertedLines.length > 0) {
      convertedLines[0] = {
        ...convertedLines[0],
        coordinates: [takeoffPoint, ...convertedLines[0].coordinates],
      };
    }

    const calculatedPlan = calculateFlightPlan(
      selectedCamera,
      altitude,
      speed,
      forwardOverlap,
      sideOverlap,
      flightPlanResult.totalDistance,
      flightPlanResult.lines.length
    );

    return {
      flightPlanResult,
      convertedLines,
      calculatedPlan,
    };
  };

  const calculateSegmentDistanceMeters = (from: number[], to: number[]) => {
    const earthRadius = 6371000;
    const lat1 = (from[1] * Math.PI) / 180;
    const lat2 = (to[1] * Math.PI) / 180;
    const dLat = ((to[1] - from[1]) * Math.PI) / 180;
    const dLon = ((to[0] - from[0]) * Math.PI) / 180;

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadius * c;
  };

  const getTotalDistanceFromFlightLines = (lines: { coordinates: number[][] }[]) => {
    return lines.reduce((sum, line) => {
      if (!line.coordinates || line.coordinates.length < 2) return sum;

      for (let index = 0; index < line.coordinates.length - 1; index += 1) {
        const from = line.coordinates[index];
        const to = line.coordinates[index + 1];

        if (
          Number.isFinite(from?.[0]) &&
          Number.isFinite(from?.[1]) &&
          Number.isFinite(to?.[0]) &&
          Number.isFinite(to?.[1])
        ) {
          sum += calculateSegmentDistanceMeters(from, to);
        }
      }

      return sum;
    }, 0);
  };

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
      setWaypointTakePhoto(activeMission.parameters.waypointTakePhoto ?? false);
      setWaypointRecordVideo(activeMission.parameters.waypointRecordVideo ?? false);
      setWaypointHoverEnabled(activeMission.parameters.waypointHoverEnabled ?? false);
      setWaypointHoverTime(activeMission.parameters.waypointHoverTime ?? 2);
      setWaypointAutoDroneHeading(activeMission.parameters.waypointAutoDroneHeading ?? true);
      setGlobalHeadingMode(
        activeMission.parameters.globalHeadingMode ??
          (activeMission.parameters.waypointAutoDroneHeading ? 'followWayline' : 'manually')
      );
      setGimbalPitchMode(activeMission.parameters.gimbalPitchMode ?? 'manual');
      setWaypointAutoGimbalYaw(activeMission.parameters.waypointAutoGimbalYaw ?? false);
      setWaypointTurnDistance(activeMission.parameters.waypointTurnDistance ?? 0.2);
      setAlwaysTerrainFollow(activeMission.parameters.alwaysTerrainFollow ?? false);
      setTerrainFollowAccuracy(activeMission.parameters.terrainFollowAccuracy ?? 2);
      setTerrainFollowMinDist(activeMission.parameters.terrainFollowMinDist ?? 2);
      setTerrainFollowSkipPoints(activeMission.parameters.terrainFollowSkipPoints ?? 1);
      setElevationToleranceEnabled(activeMission.parameters.elevationToleranceEnabled ?? false);
      setElevationTolerance(activeMission.parameters.elevationTolerance ?? 1);
    }
  }, [activeMissionId]);

  // "Selected Waypoint Parameters" can re-base the route height (waypoint 1) and can
  // switch the mission to manual aircraft heading — mirror both back into these inputs.
  useEffect(() => {
    if (activeMission) {
      setAltitude(activeMission.parameters.altitude);
    }
  }, [activeMission?.parameters.altitude]);

  useEffect(() => {
    if (activeMission) {
      setWaypointAutoDroneHeading(activeMission.parameters.waypointAutoDroneHeading ?? true);
    }
  }, [activeMission?.parameters.waypointAutoDroneHeading]);

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

  // Update calculated statistics only when an area flight plan already exists
  useEffect(() => {
    const hasGeneratedAreaPlan =
      activeMission?.missionType === 'area' &&
      !!activeMission?.aoi &&
      !!activeMission?.flightLines?.length &&
      activeMission.flightLines.some((line) => line.coordinates.length > 1);

    if (!selectedCamera || !hasGeneratedAreaPlan || !activeMission) {
      setFlightPlan(null);
      return;
    }

    const totalDistance = getTotalDistanceFromFlightLines(activeMission.flightLines);
    const numLines = activeMission.flightLines.length;

    const plan = calculateFlightPlan(
      selectedCamera,
      altitude,
      speed,
      forwardOverlap,
      sideOverlap,
      totalDistance,
      numLines
    );

    setFlightPlan(plan);
  }, [
    activeMission?.id,
    activeMission?.missionType,
    activeMission?.aoi,
    activeMission?.flightLines,
    selectedCamera,
    altitude,
    speed,
    forwardOverlap,
    sideOverlap,
  ]);

  useEffect(() => {
    if (!realtimeFlightPreviewEnabled) return;
    if (!activeMissionId || !activeMission?.aoi || activeMission.missionType !== 'area') return;
    if (!selectedCamera || speed <= 0) return;

    const requestId = ++realtimePreviewRequestRef.current;
    const missionCoordinates = activeMission.aoi.coordinates.map((coord) => [...coord]);

    if (realtimePreviewFrameRef.current !== null) {
      cancelAnimationFrame(realtimePreviewFrameRef.current);
    }

    realtimePreviewFrameRef.current = requestAnimationFrame(() => {
      if (requestId !== realtimePreviewRequestRef.current) return;

      const applyRealtimePreview = async () => {
        const { convertedLines, calculatedPlan } = await buildTerrainAdjustedAreaPlan(missionCoordinates);

        if (requestId !== realtimePreviewRequestRef.current) return;

        updateMission(activeMissionId, {
          flightLines: convertedLines,
        });
        setFlightPlan(calculatedPlan);
      };

      applyRealtimePreview().catch((error) => {
        console.error('Realtime flight preview update failed:', error);
      });
    });

    return () => {
      if (realtimePreviewFrameRef.current !== null) {
        cancelAnimationFrame(realtimePreviewFrameRef.current);
        realtimePreviewFrameRef.current = null;
      }
    };
  }, [
    realtimeFlightPreviewEnabled,
    activeMissionId,
    activeMission?.missionType,
    activeMission?.aoi,
    selectedCamera,
    altitude,
    speed,
    forwardOverlap,
    sideOverlap,
    flightAngle,
    elevationToleranceEnabled,
    elevationTolerance,
    updateMission,
  ]);

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

  /**
   * The panel's controls live in local state and only reach the store on "Save
   * Parameters". Anything that produces output (export) must read from here, not
   * from the stored mission, or the KMZ silently lags behind what the user sees.
   */
  const buildCurrentParameters = (): FlightParameters => ({
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
    globalHeadingMode,
    gimbalPitchMode,
    waypointAutoGimbalYaw,
    waypointTurnDistance,
    alwaysTerrainFollow,
    terrainFollowAccuracy,
    terrainFollowMinDist,
    terrainFollowSkipPoints,
    elevationToleranceEnabled,
    elevationTolerance,
  });

  const handleUpdateMission = () => {
    if (!activeMissionId) {
      setStatusMessage('Please select or create a mission first');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    updateMission(activeMissionId, {
      drone: selectedDrone,
      camera: selectedCamera,
      parameters: buildCurrentParameters(),
    });

    setStatusMessage('Flight parameters saved!');
    setTimeout(() => setStatusMessage(''), 3000);
  };

  const handleAltitudeChange = (newAltitude: number) => {
    setAltitude(newAltitude);

    if (!activeMissionId) return;

    // Keep takeoff point altitude in sync: terrain base stays, only AGL changes
    const takeoffPointUpdate: { takeoffPoint?: number[] } = {};
    if (activeMission?.takeoffPoint) {
      const [lon, lat, oldAlt] = activeMission.takeoffPoint;
      const terrainBase = oldAlt - altitude; // altitude is still old value here
      takeoffPointUpdate.takeoffPoint = [lon, lat, terrainBase + newAltitude];
    }

    updateMission(activeMissionId, {
      ...takeoffPointUpdate,
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
        globalHeadingMode,
        gimbalPitchMode,
        waypointAutoGimbalYaw,
        waypointTurnDistance,
        alwaysTerrainFollow,
        terrainFollowAccuracy,
        terrainFollowMinDist,
        terrainFollowSkipPoints,
        elevationToleranceEnabled,
        elevationTolerance,
      },
    });

    if (
      activeMission?.missionType === 'waypoint' &&
      activeMission.flightLines?.length > 0 &&
      activeMission.flightLines[0].coordinates.length > 0
    ) {
      const firstLine = activeMission.flightLines[0];
      const skipN = Math.max(0, Math.floor(terrainFollowSkipPoints || 0));
      const baseWaypoints = firstLine.coordinates.map((coord, i) =>
        i < skipN
          ? [coord[0], coord[1], Number.isFinite(coord[2]) ? coord[2] : newAltitude]
          : [coord[0], coord[1], newAltitude]
      );
      const viewer = getCesiumViewer();

      const applyWaypointAltitude = async () => {
        let updatedWaypoints: number[][];
        if (viewer && alwaysTerrainFollow) {
          updatedWaypoints = await sampleTerrainWithSubPoints(viewer, baseWaypoints, newAltitude, terrainFollowAccuracy, terrainFollowMinDist, terrainFollowSkipPoints);
        } else if (viewer) {
          updatedWaypoints = await sampleTerrainForWaypoints(viewer, baseWaypoints, newAltitude);
        } else {
          updatedWaypoints = baseWaypoints;
        }

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

      // Export exactly what the panel currently shows, and persist it in the same
      // step so the stored mission and the KMZ can never disagree.
      const missionToExport = {
        ...activeMission,
        drone: selectedDrone,
        camera: selectedCamera,
        parameters: buildCurrentParameters(),
      };
      updateMission(activeMission.id, {
        drone: missionToExport.drone,
        camera: missionToExport.camera,
        parameters: missionToExport.parameters,
      });

      const kmzBlob = await exportToDJI(missionToExport);
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
          takeoffPoint: null, // reset on new import
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

        setStatusMessage(`KML imported: ${firstPolygon.name} — click map to set takeoff point`);
        setTimeout(() => setStatusMessage(''), 6000);
        setAddTakeoffPointMode(true);
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
        const skipN = Math.max(0, Math.floor(terrainFollowSkipPoints || 0));
        const baseWaypoints = waypointSet.coordinates.map((coord, i) =>
          i < skipN
            ? [coord[0], coord[1], Number.isFinite(coord[2]) ? coord[2] : altitude]
            : [coord[0], coord[1], altitude]
        );
        let terrainAdjustedWaypoints: number[][];
        if (viewer && alwaysTerrainFollow) {
          terrainAdjustedWaypoints = await sampleTerrainWithSubPoints(viewer, baseWaypoints, altitude, terrainFollowAccuracy, terrainFollowMinDist, terrainFollowSkipPoints);
        } else if (viewer) {
          terrainAdjustedWaypoints = await sampleTerrainForWaypoints(viewer, baseWaypoints, altitude);
        } else {
          terrainAdjustedWaypoints = baseWaypoints;
        }

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
      takeoffPoint: null,
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

    if (!activeMission.takeoffPoint) {
      setStatusMessage('⚠ No takeoff point set — click "Add Takeoff Point" and click on the map');
      setTimeout(() => setStatusMessage(''), 5000);
      return;
    }

    try {
      const { flightPlanResult, convertedLines, calculatedPlan } = await buildTerrainAdjustedAreaPlan(
        activeMission.aoi.coordinates
      );

      updateMission(activeMissionId, {
        flightLines: convertedLines,
      });
      setFlightPlan(calculatedPlan);
      
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

  /**
   * Apply terrain follow sub-sampling to the current mission.
   * Called explicitly by the user via the "Apply Terrain Follow" button.
   */
  const handleApplyTerrainFollow = async () => {
    if (!activeMissionId || !activeMission) return;

    const viewer = getCesiumViewer();
    if (!viewer) {
      setStatusMessage('Cesium viewer not available');
      setTimeout(() => setStatusMessage(''), 3000);
      return;
    }

    setIsTerrainCalculating(true);
    setTerrainCalcProgress('Preparing terrain follow calculation...');

    try {
      if (activeMission.missionType === 'area' && activeMission.aoi) {
        // Area mission: regenerate flight plan with terrain follow
        setTerrainCalcProgress('Generating flight lines with terrain follow...');
        const { convertedLines, calculatedPlan } = await buildTerrainAdjustedAreaPlan(
          activeMission.aoi.coordinates
        );

        updateMission(activeMissionId, {
          flightLines: convertedLines,
          parameters: {
            ...activeMission.parameters,
            alwaysTerrainFollow,
            terrainFollowAccuracy,
            terrainFollowMinDist,
            terrainFollowSkipPoints,
          },
        });
        setFlightPlan(calculatedPlan);

        const totalWaypoints = convertedLines.reduce((sum, line) => sum + line.coordinates.length, 0);
        setStatusMessage(`✓ Terrain follow applied: ${convertedLines.length} lines, ${totalWaypoints} waypoints`);
      } else if (activeMission.missionType === 'waypoint' && activeMission.flightLines?.length > 0) {
        // Waypoint mission: sub-sample existing waypoints
        const firstLine = activeMission.flightLines[0];
        // Snapshot originals once — preserve existing snapshot if already set so
        // re-applying doesn't overwrite the true pre-terrain-follow waypoints.
        const originalCoordinates = firstLine.originalCoordinates ?? firstLine.coordinates;
        // Skipped (transit) points keep their true original altitude; the rest get the
        // AGL placeholder that terrain sampling replaces with terrainHeight + AGL.
        const skipN = Math.max(0, Math.floor(terrainFollowSkipPoints || 0));
        const baseWaypoints = originalCoordinates.map((coord, i) =>
          i < skipN
            ? [coord[0], coord[1], Number.isFinite(coord[2]) ? coord[2] : altitude]
            : [coord[0], coord[1], altitude]
        );

        setTerrainCalcProgress(`Sub-sampling terrain for ${baseWaypoints.length} waypoints...`);
        const updatedWaypoints = await sampleTerrainWithSubPoints(
          viewer,
          baseWaypoints,
          altitude,
          terrainFollowAccuracy,
          terrainFollowMinDist,
          terrainFollowSkipPoints
        );

        updateMission(activeMissionId, {
          flightLines: [
            {
              ...firstLine,
              originalCoordinates,
              coordinates: updatedWaypoints,
            },
            ...activeMission.flightLines.slice(1),
          ],
          parameters: {
            ...activeMission.parameters,
            alwaysTerrainFollow,
            terrainFollowAccuracy,
            terrainFollowMinDist,
            terrainFollowSkipPoints,
          },
        });

        setStatusMessage(`✓ Terrain follow applied: ${baseWaypoints.length} → ${updatedWaypoints.length} waypoints`);
      } else {
        setStatusMessage('No mission data to apply terrain follow to. Generate a flight plan or add waypoints first.');
      }

      setTimeout(() => setStatusMessage(''), 5000);
    } catch (error) {
      console.error('Terrain follow calculation failed:', error);
      setStatusMessage('Terrain follow failed: ' + (error as Error).message);
      setTimeout(() => setStatusMessage(''), 5000);
    } finally {
      setIsTerrainCalculating(false);
      setTerrainCalcProgress('');
    }
  };

  /**
   * Handle toggling the "Always Terrain Follow" checkbox.
   * When unchecked, revert the mission to standard terrain sampling (no sub-points).
   */
  const handleTerrainFollowToggle = async (checked: boolean) => {
    setAlwaysTerrainFollow(checked);

    if (!checked && activeMissionId && activeMission) {
      // Revert to standard terrain sampling
      const viewer = getCesiumViewer();
      if (!viewer) return;

      setIsTerrainCalculating(true);
      setTerrainCalcProgress('Reverting to standard terrain sampling...');

      try {
        if (activeMission.missionType === 'area' && activeMission.aoi) {
          // Regenerate area mission without terrain follow sub-sampling
          const footprintWidth = (selectedCamera.sensorWidth * altitude) / selectedCamera.focalLength;
          const footprintHeight = (selectedCamera.sensorHeight * altitude) / selectedCamera.focalLength;
          const lineSpacing = footprintWidth * (1 - sideOverlap / 100);
          const photoInterval = (footprintHeight * (1 - forwardOverlap / 100)) / speed;

          if (!Number.isFinite(lineSpacing) || !Number.isFinite(photoInterval) || lineSpacing <= 0 || photoInterval <= 0) {
            return;
          }

          const flightPlanResult = generateFlightLines(
            activeMission.aoi.coordinates,
            lineSpacing,
            flightAngle,
            altitude,
            photoInterval,
            speed
          );

          const convertedLines = await Promise.all(
            flightPlanResult.lines.map(async (line) => {
              const waypoints = line.waypoints.map((wp) => [wp.lon, wp.lat, wp.alt]);
              const terrainWaypoints = await sampleTerrainForWaypoints(viewer, waypoints, altitude);

              const photoPoints = line.waypoints
                .map((wp, index) => ({ wp, index }))
                .filter(({ wp }) => wp.action === 'photo')
                .map(({ index }) => terrainWaypoints[index]);

              return {
                id: line.id,
                coordinates: terrainWaypoints,
                photoPoints,
              };
            })
          );

          const calculatedPlan = calculateFlightPlan(
            selectedCamera,
            altitude,
            speed,
            forwardOverlap,
            sideOverlap,
            flightPlanResult.totalDistance,
            flightPlanResult.lines.length
          );

          updateMission(activeMissionId, {
            flightLines: convertedLines,
            parameters: {
              ...activeMission.parameters,
              alwaysTerrainFollow: false,
            },
          });
          setFlightPlan(calculatedPlan);
          setStatusMessage('✓ Reverted to standard terrain sampling');
        } else if (activeMission.missionType === 'waypoint' && activeMission.flightLines?.length > 0) {
          const firstLine = activeMission.flightLines[0];
          // Restore the pre-terrain-follow waypoints if a snapshot exists,
          // otherwise fall back to the current coordinates.
          const restoredBase = firstLine.originalCoordinates ?? firstLine.coordinates;
          const baseWaypoints = restoredBase.map((coord) => [coord[0], coord[1], altitude]);
          const updatedWaypoints = await sampleTerrainForWaypoints(viewer, baseWaypoints, altitude);

          updateMission(activeMissionId, {
            flightLines: [
              {
                ...firstLine,
                coordinates: updatedWaypoints,
                originalCoordinates: undefined,
              },
              ...activeMission.flightLines.slice(1),
            ],
            parameters: {
              ...activeMission.parameters,
              alwaysTerrainFollow: false,
            },
          });
          setStatusMessage('✓ Reverted to original waypoints');
        }

        setTimeout(() => setStatusMessage(''), 3000);
      } catch (error) {
        console.error('Failed to revert terrain follow:', error);
        setStatusMessage('Failed to revert: ' + (error as Error).message);
        setTimeout(() => setStatusMessage(''), 5000);
      } finally {
        setIsTerrainCalculating(false);
        setTerrainCalcProgress('');
      }
    }
  };

  // Check if no mission is selected
  if (!activeMissionId) {
    return (
      <div className={`flight-planner ${isPanelCollapsed ? 'is-collapsed' : ''}`}>
        <button
          type="button"
          className="flight-planner-toggle"
          onClick={() => setIsPanelCollapsed((prev) => !prev)}
          title={isPanelCollapsed ? 'Show Flight Planning panel' : 'Hide Flight Planning panel'}
          aria-label={isPanelCollapsed ? 'Show Flight Planning panel' : 'Hide Flight Planning panel'}
        >
          {isPanelCollapsed ? '❮' : '❯'}
        </button>
        <div className="flight-planner-content">
          <h2 className="flight-planner-title">
        <span>Flight Planning</span>
        <span className="app-version">{APP_VERSION}</span>
      </h2>
          <div className="empty-state">
            <p>No mission selected.</p>
            <p>Create or select a mission from the Mission Manager to start planning.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flight-planner ${isPanelCollapsed ? 'is-collapsed' : ''}`}>
      <button
        type="button"
        className="flight-planner-toggle"
        onClick={() => setIsPanelCollapsed((prev) => !prev)}
        title={isPanelCollapsed ? 'Show Flight Planning panel' : 'Hide Flight Planning panel'}
        aria-label={isPanelCollapsed ? 'Show Flight Planning panel' : 'Hide Flight Planning panel'}
      >
        {isPanelCollapsed ? '❮' : '❯'}
      </button>
      <div className="flight-planner-content">
      <h2 className="flight-planner-title">
        <span>Flight Planning</span>
        <span className="app-version">{APP_VERSION}</span>
      </h2>

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
            {activeMission.missionType === 'area' && (
              activeMission.takeoffPoint ? (
                <div className="status-message success" style={{ marginTop: '4px' }}>
                  🛫 Takeoff point set
                </div>
              ) : (
                <div className="status-message warning" style={{ marginTop: '4px' }}>
                  ⚠ No takeoff point — set before generating plan
                </div>
              )
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
              {activeMission.missionType === 'area' && (
                <button
                  className={`btn-primary${addTakeoffPointMode ? ' btn-active-mode' : ''}`}
                  onClick={() => setAddTakeoffPointMode(!addTakeoffPointMode)}
                  title="Click this then click on map to set takeoff point"
                >
                  {addTakeoffPointMode ? '❌ Cancel' : activeMission.takeoffPoint ? '✏️ Edit Takeoff Point' : '🛫 Add Takeoff Point'}
                </button>
              )}
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
                <label className="inline-toggle waypoint-guide-toggle">
                  <input
                    type="checkbox"
                    checked={showAreaHeightGuides}
                    onChange={(e) => setShowAreaHeightGuides(e.target.checked)}
                    disabled={!kmlEditMode}
                  />
                  Height guides
                </label>
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
              {activeMission?.missionType === 'area' && (
                <button
                  className={`btn-primary${addTakeoffPointMode ? ' btn-active-mode' : ''}`}
                  onClick={() => setAddTakeoffPointMode(!addTakeoffPointMode)}
                  title="Click this then click on map to set takeoff point"
                >
                  {addTakeoffPointMode ? '❌ Cancel' : activeMission.takeoffPoint ? '✏️ Edit Takeoff Point' : '🛫 Add Takeoff Point'}
                </button>
              )}
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

        {/* Always Terrain Follow — hidden for AREA missions (their points are already terrain-sampled;
            use Elevation Tolerance in section 4 instead). Kept for waypoint missions. */}
        {activeMission?.missionType !== 'area' && (
        <div className="terrain-follow-settings">
          <label className="inline-toggle terrain-follow-toggle">
            <input
              type="checkbox"
              checked={alwaysTerrainFollow}
              onChange={(e) => handleTerrainFollowToggle(e.target.checked)}
              disabled={isTerrainCalculating}
            />
            <span>Always Terrain Follow</span>
          </label>
          {alwaysTerrainFollow && (
            <div className="terrain-follow-info">
              <small style={{ color: '#94a3b8', display: 'block', marginBottom: '8px' }}>
                🏔️ Sub-samples terrain between waypoints and inserts extra points where elevation changes exceed the accuracy threshold. Creates true terrain-following flight paths.
              </small>
              <label>
                Terrain Follow Accuracy (m):
                <div className="range-control-row">
                  <input
                    className="range-number-input"
                    type="number"
                    value={terrainFollowAccuracy}
                    onChange={(e) => setTerrainFollowAccuracy(Number(e.target.value))}
                    min="0.1"
                    max="50"
                    step="0.1"
                    disabled={isTerrainCalculating}
                  />
                  <input
                    className="range-slider-input"
                    type="range"
                    value={terrainFollowAccuracy}
                    onChange={(e) => setTerrainFollowAccuracy(Number(e.target.value))}
                    min="0.1"
                    max="50"
                    step="0.1"
                    disabled={isTerrainCalculating}
                  />
                </div>
                <small style={{ color: '#94a3b8' }}>
                  Insert sub-waypoint when elevation changes more than {terrainFollowAccuracy}m
                </small>
              </label>
              <label>
                Minimum Distance (m):
                <div className="range-control-row">
                  <input
                    className="range-number-input"
                    type="number"
                    value={terrainFollowMinDist}
                    onChange={(e) => setTerrainFollowMinDist(Number(e.target.value))}
                    min="0.5"
                    max="100"
                    step="0.5"
                    disabled={isTerrainCalculating}
                  />
                  <input
                    className="range-slider-input"
                    type="range"
                    value={terrainFollowMinDist}
                    onChange={(e) => setTerrainFollowMinDist(Number(e.target.value))}
                    min="0.5"
                    max="100"
                    step="0.5"
                    disabled={isTerrainCalculating}
                  />
                </div>
                <small style={{ color: '#94a3b8' }}>
                  Skip sub-waypoint if closer than {terrainFollowMinDist}m to the previous <strong>or next</strong> waypoint
                </small>
              </label>
              <label>
                Skip First Points:
                <div className="range-control-row">
                  <input
                    className="range-number-input"
                    type="number"
                    value={terrainFollowSkipPoints}
                    onChange={(e) => setTerrainFollowSkipPoints(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    min="0"
                    step="1"
                    disabled={isTerrainCalculating}
                  />
                </div>
                <small style={{ color: '#94a3b8' }}>
                  Leave the first {terrainFollowSkipPoints} waypoint(s) untouched (transit leg before the mission area)
                </small>
              </label>
              <button
                className="btn-terrain-follow-apply"
                onClick={handleApplyTerrainFollow}
                disabled={isTerrainCalculating || (!activeMission?.aoi && !(activeMission?.missionType === 'waypoint' && activeMission?.flightLines?.length))}
                title="Recalculate mission with terrain follow sub-sampling"
              >
                {isTerrainCalculating ? '⏳ Calculating...' : '🏔️ Apply Terrain Follow'}
              </button>
            </div>
          )}
          {isTerrainCalculating && (
            <div className="terrain-calc-progress">
              <div className="terrain-calc-progress-bar">
                <div className="terrain-calc-progress-bar-fill" />
              </div>
              <small className="terrain-calc-progress-text">{terrainCalcProgress}</small>
            </div>
          )}
        </div>
        )}
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
                  <div className="range-control-row">
                    <input
                      className="range-number-input"
                      type="number"
                      value={forwardOverlap}
                      onChange={(e) => setForwardOverlap(Number(e.target.value))}
                      min="1"
                      max="99"
                      step="1"
                    />
                    <input
                      className="range-slider-input"
                      type="range"
                      value={forwardOverlap}
                      onChange={(e) => setForwardOverlap(Number(e.target.value))}
                      min="1"
                      max="99"
                      step="1"
                    />
                  </div>
                </label>

                <label>
                  Side Overlap (%):
                  <div className="range-control-row">
                    <input
                      className="range-number-input"
                      type="number"
                      value={sideOverlap}
                      onChange={(e) => setSideOverlap(Number(e.target.value))}
                      min="1"
                      max="99"
                      step="1"
                    />
                    <input
                      className="range-slider-input"
                      type="range"
                      value={sideOverlap}
                      onChange={(e) => setSideOverlap(Number(e.target.value))}
                      min="1"
                      max="99"
                      step="1"
                    />
                  </div>
                </label>

                <label>
                  Flight Direction (°):
                  <div className="range-control-row">
                    <input
                      className="range-number-input"
                      type="number"
                      value={flightAngle}
                      onChange={(e) => setFlightAngle(Number(e.target.value))}
                      min="0"
                      max="360"
                      step="1"
                    />
                    <input
                      className="range-slider-input"
                      type="range"
                      value={flightAngle}
                      onChange={(e) => setFlightAngle(Number(e.target.value))}
                      min="0"
                      max="360"
                      step="1"
                    />
                  </div>
                </label>

                <label className="inline-toggle realtime-toggle">
                  <input
                    type="checkbox"
                    checked={realtimeFlightPreviewEnabled}
                    onChange={(e) => setRealtimeFlightPreviewEnabled(e.target.checked)}
                    disabled={activeMission?.missionType !== 'area' || !activeMission?.aoi}
                  />
                  <span>Mission Realtime Update</span>
                </label>

                {/* Elevation Tolerance — area-only point reduction to avoid DJI Pilot 2 freezing.
                    Keeps the overlap-based generation, then drops points on flat terrain. */}
                <div className="terrain-follow-settings">
                  <label className="inline-toggle terrain-follow-toggle">
                    <input
                      type="checkbox"
                      checked={elevationToleranceEnabled}
                      onChange={(e) => setElevationToleranceEnabled(e.target.checked)}
                    />
                    <span>Elevation Tolerance (reduce points)</span>
                  </label>
                  {elevationToleranceEnabled && (
                    <div className="terrain-follow-info">
                      <small style={{ color: '#94a3b8', display: 'block', marginBottom: '8px' }}>
                        📉 Reduces point count by skipping waypoints on flat terrain, while keeping
                        good terrain follow on slopes. Helps avoid freezing in DJI Pilot 2.
                      </small>
                      <label>
                        Elevation Tolerance (m):
                        <div className="range-control-row">
                          <input
                            className="range-number-input"
                            type="number"
                            value={elevationTolerance}
                            onChange={(e) => setElevationTolerance(Number(e.target.value))}
                            min="0.1"
                            max="10"
                            step="0.1"
                          />
                          <input
                            className="range-slider-input"
                            type="range"
                            value={elevationTolerance}
                            onChange={(e) => setElevationTolerance(Number(e.target.value))}
                            min="0.1"
                            max="10"
                            step="0.1"
                          />
                        </div>
                        <small style={{ color: '#94a3b8' }}>
                          Skip a point unless its terrain elevation differs more than {elevationTolerance}m from the last kept point
                        </small>
                      </label>
                    </div>
                  )}
                </div>
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
                      onBlur={(e) => setDroneYaw(normalizeYaw(e.target.value))}
                      min="-180"
                      max="180"
                      step="1"
                      disabled={waypointAutoDroneHeading}
                    />
                  </label>

                  <label className="waypoint-compact-field">
                    Aircraft Yaw:
                    <select
                      value={globalHeadingMode}
                      onChange={(e) => {
                        const mode = e.target.value as typeof globalHeadingMode;
                        setGlobalHeadingMode(mode);
                        setWaypointAutoDroneHeading(mode === 'followWayline');
                      }}
                    >
                      <option value="manually">Manual</option>
                      <option value="followWayline">Along the Route</option>
                      <option value="smoothTransition">Custom (use Drone Yaw)</option>
                    </select>
                  </label>
                </div>

                <label className="waypoint-compact-field">
                  Gimbal Control:
                  <select
                    value={gimbalPitchMode}
                    onChange={(e) => setGimbalPitchMode(e.target.value as typeof gimbalPitchMode)}
                  >
                    <option value="manual">Manual</option>
                    <option value="usePointSetting">For Each Waypoint</option>
                  </select>
                </label>

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
                      onBlur={(e) => setGimbalYaw(normalizeYaw(e.target.value))}
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

                <label>
                  Turn Distance (m):
                  <input
                    type="number"
                    value={waypointTurnDistance}
                    onChange={(e) => setWaypointTurnDistance(Number(e.target.value))}
                    min="0"
                    max="20"
                    step="0.1"
                  />
                </label>

                <h4 className="waypoint-subsection-title">Selected Waypoint Parameters</h4>
                <SelectedWaypointPanel missionId={activeMissionId} />
              </div>
            )}
          </>
        )}
      </section>

      {/* Step 6: Collision Analysis */}
      <section className="planner-section">
        <h3 className="section-title-row" onClick={() => setShowCollisionAnalysis(!showCollisionAnalysis)}>
          6. Collision Analysis <span>{showCollisionAnalysis ? '▾' : '▸'}</span>
        </h3>

        {showCollisionAnalysis && (
          <>
            {!(activeMission?.flightLines && activeMission.flightLines.length > 0) ? (
              <div className="status-message warning">
                No flight line to analyze — import or draw a waypoint route first
              </div>
            ) : (
              <div className="collision-analysis-layout">
                <label className="waypoint-compact-field">
                  Clearance threshold (m):
                  <input
                    type="number"
                    value={collisionThreshold}
                    onChange={(e) => setCollisionThreshold(Number(e.target.value))}
                    min="0.1"
                    max="10"
                    step="0.1"
                  />
                </label>

                <label className="waypoint-compact-field">
                  Sample interval (m):
                  <input
                    type="number"
                    value={collisionInterval}
                    onChange={(e) => setCollisionInterval(Number(e.target.value))}
                    min="0.1"
                    max="10"
                    step="0.1"
                  />
                </label>

                <label className="waypoint-compact-field">
                  Skip first points:
                  <input
                    type="number"
                    value={collisionSkipPoints}
                    onChange={(e) => setCollisionSkipPoints(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    min="0"
                    step="1"
                  />
                </label>

                <p className="collision-hint">
                  Checks the active yellow line's front/back/down envelope within the clearance
                  radius against terrain. Risky sections turn <strong>red</strong>. Use
                  <strong> Skip first points</strong> to ignore the transit leg before the mission area.
                </p>

                <div className="collision-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={collisionStatus === 'running'}
                    onClick={() => {
                      const t = Math.min(10, Math.max(0.1, collisionThreshold || 0.1));
                      const iv = Math.min(10, Math.max(0.1, collisionInterval || 0.1));
                      const skip = Math.max(0, Math.floor(collisionSkipPoints || 0));
                      requestCollisionAnalysis(t, iv, skip);
                    }}
                  >
                    {collisionStatus === 'running' ? '⏳ Analyzing…' : '🛰️ Analyze Collision Risk'}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => clearCollisionAnalysis()}>
                    ✖ Clear
                  </button>
                </div>

                {collisionStatus === 'running' && (
                  <div
                    className="collision-progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(collisionProgress * 100)}
                  >
                    <div
                      className="collision-progress-bar"
                      style={{ width: `${Math.round(collisionProgress * 100)}%` }}
                    />
                    <span className="collision-progress-label">
                      {Math.round(collisionProgress * 100)}%
                    </span>
                  </div>
                )}

                {collisionStatus === 'done' && (
                  <div className={`status-message ${collisionRiskCount > 0 ? 'warning' : 'success'}`}>
                    {collisionRiskCount > 0
                      ? `⚠ ${collisionRiskCount} risky sample point(s) — see red sections on the map`
                      : '✓ No collision risk detected'}
                    {collisionEffInterval > 0 && (
                      <div className="collision-hint" style={{ marginTop: '4px' }}>
                        Sampled every {collisionEffInterval.toFixed(2)} m.
                        {collisionEffInterval > collisionThreshold + 0.001 && (
                          <strong>
                            {' '}⚠ Line too long to fully cover at this clearance — there may be gaps.
                            Increase the clearance threshold, or split the route (use Skip first points).
                          </strong>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {collisionStatus === 'error' && (
                  <div className="status-message warning">
                    Analysis failed — make sure a terrain layer is loaded
                  </div>
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

            {(() => {
              const allCoords = activeMission.flightLines.flatMap((line) => line.coordinates);
              const totalDist = allCoords.slice(1).reduce(
                (sum, coord, i) => sum + calculateDistance(allCoords[i], coord),
                0
              );
              const speed = activeMission.parameters.speed;
              const totalSec = speed > 0 ? Math.round(totalDist / speed) : 0;
              const mins = Math.floor(totalSec / 60);
              const secs = totalSec % 60;
              return (
                <>
                  <div className="result-item">
                    <span className="result-label">Total Distance:</span>
                    <span className="result-value">
                      {totalDist >= 1000
                        ? `${(totalDist / 1000).toFixed(2)} km`
                        : `${totalDist.toFixed(0)} m`}
                    </span>
                  </div>
                  <div className="result-item">
                    <span className="result-label">Est. Flight Time:</span>
                    <span className="result-value">
                      {mins > 0 ? `${mins} min ${secs} sec` : `${secs} sec`}
                    </span>
                  </div>
                </>
              );
            })()}

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
    </div>
  );
};
