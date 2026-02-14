/**
 * CesiumMap Component
 * Main 3D/2D visualization component using CesiumJS
 */

import { useEffect, useRef } from 'react';
import {
  Viewer,
  Ion,
  IonImageryProvider,
  CesiumTerrainProvider,
  createWorldTerrainAsync,
  SceneMode,
  Cartesian3,
  Math as CesiumMath,
  Color,
  Entity,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Cartographic,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Cartesian2,
  CallbackProperty,
  ConstantPositionProperty,
  CallbackPositionProperty,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useMissionStore } from '../stores/mission-store';
import { sampleTerrainForWaypoints } from '../lib/terrain-sampler';

// Set Cesium Ion access token
Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJhYjM3ZjBkMy0wZWFiLTQzNzYtYjk5Zi1mZDU4NzZhZGZkMmUiLCJpZCI6Mzg5Nzk1LCJpYXQiOjE3NzA4NTExMzd9.LATM9S0nkja1YrqNanCBDYhse2_bX-CqIa5rgkhIXNQ';

export const CesiumMap = () => {
  const viewerRef = useRef<Viewer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const editCoordinatesRef = useRef<number[][] | null>(null);
  const editAltitudeRef = useRef<number>(100);
  const editActiveMissionIdRef = useRef<string | null>(null);
  const editPolylineIdRef = useRef<string | null>(null);
  const drawPointsRef = useRef<number[][]>([]);
  const drawHoverRef = useRef<number[] | null>(null);
  const viewMode = useMissionStore((state) => state.viewMode);
  const cameraTarget = useMissionStore((state) => state.cameraTarget);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);
  const missions = useMissionStore((state) => state.missions);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const kmlEditMode = useMissionStore((state) => state.kmlEditMode);
  const drawAoiMode = useMissionStore((state) => state.drawAoiMode);
  const drawWaypointMode = useMissionStore((state) => state.drawWaypointMode);
  const showWaypointHeightGuides = useMissionStore((state) => state.showWaypointHeightGuides);
  const updateMission = useMissionStore((state) => state.updateMission);
  const setDrawAoiMode = useMissionStore((state) => state.setDrawAoiMode);
  const setDrawWaypointMode = useMissionStore((state) => state.setDrawWaypointMode);
  const layers = useMissionStore((state) => state.layers);

  const getLonLatFromScreenPosition = (viewer: Viewer, position: Cartesian2) => {
    let cartesian: Cartesian3 | undefined;

    if (viewer.scene.pickPositionSupported) {
      const precise = viewer.scene.pickPosition(position);
      if (precise) {
        cartesian = precise;
      }
    }

    if (!cartesian) {
      const ray = viewer.camera.getPickRay(position);
      if (ray) {
        cartesian = viewer.scene.globe.pick(ray, viewer.scene);
      }
    }

    if (!cartesian) {
      cartesian = viewer.camera.pickEllipsoid(position) ?? undefined;
    }

    if (!cartesian) return null;

    const cartographic = Cartographic.fromCartesian(cartesian);
    return {
      lon: CesiumMath.toDegrees(cartographic.longitude),
      lat: CesiumMath.toDegrees(cartographic.latitude),
    };
  };

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;

    // Initialize Cesium Viewer with default satellite imagery
    const viewer = new Viewer(containerRef.current, {
      baseLayerPicker: false,
      
      // UI elements
      animation: false,
      timeline: false,
      fullscreenButton: false,
      vrButton: false,
      geocoder: true,
      homeButton: true,
      sceneModePicker: true,
      navigationHelpButton: true,
      
      // Scene settings
      requestRenderMode: false,
      maximumRenderTimeChange: Infinity,
    });
    
    // Cesium Viewer comes with Bing Maps satellite imagery by default
    // Add labels layer on top for city names and features
    IonImageryProvider.fromAssetId(3).then((labelsProvider) => {
      viewer.imageryLayers.addImageryProvider(labelsProvider); // Bing Maps Road Labels
    });

    // Set initial terrain provider to flat ellipsoid
    // Will be toggled by Layer Manager terrain checkbox
    viewer.terrainProvider = new EllipsoidTerrainProvider();

    // Configure scene for better 3D terrain visualization
    viewer.scene.globe.enableLighting = false;
    // Disable depth test so flight lines are always visible, even with terrain loaded
    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.globe.tileCacheSize = 1000;
    
    // Enable terrain exaggeration for better visibility (2x exaggeration)
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;

    // Set initial camera position (centered view of Earth)
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(0, 30, 20000000), // Above equator, high enough to see Earth
      orientation: {
        heading: CesiumMath.toRadians(0),
        pitch: CesiumMath.toRadians(-90), // Looking straight down
        roll: 0.0,
      },
    });

    viewerRef.current = viewer;
    
    // Store viewer globally for terrain sampling access
    // @ts-ignore
    window.cesiumViewer = viewer;

    // Cleanup
    return () => {
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, []);

  // Handle view mode changes
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    
    switch (viewMode) {
      case 'SCENE2D':
        viewer.scene.mode = SceneMode.SCENE2D;
        break;
      case 'SCENE3D':
        viewer.scene.mode = SceneMode.SCENE3D;
        break;
      case 'COLUMBUS_VIEW':
        viewer.scene.mode = SceneMode.COLUMBUS_VIEW;
        break;
    }
  }, [viewMode]);

  // Handle camera target changes (fly to location)
  useEffect(() => {
    if (!viewerRef.current || !cameraTarget) return;

    const viewer = viewerRef.current;
    
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(
        cameraTarget.longitude,
        cameraTarget.latitude,
        cameraTarget.altitude || 5000
      ),
      orientation: {
        heading: CesiumMath.toRadians(cameraTarget.heading || 0),
        pitch: CesiumMath.toRadians(cameraTarget.pitch || -45),
        roll: cameraTarget.roll || 0.0,
      },
      duration: 2.0,
      complete: () => {
        // Clear the target after flying to it
        setCameraTarget(null);
      },
    });
  }, [cameraTarget, setCameraTarget]);

  // Handle terrain visibility
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    const terrainLayer = layers.find(l => l.id === 'terrain');
    
    if (terrainLayer?.visible) {
      // Enable 3D terrain with vertex normals and water mask for better visualization
      console.log('Loading 3D terrain...');
      createWorldTerrainAsync({
        requestVertexNormals: true,
        requestWaterMask: true,
      }).then((terrainProvider) => {
        if (viewerRef.current) {
          viewerRef.current.terrainProvider = terrainProvider;
          console.log('3D terrain loaded - navigate to mountainous areas to see elevation');
        }
      }).catch((error) => {
        console.error('Failed to load Cesium World Terrain:', error);
      });
    } else {
      // Disable terrain (use flat ellipsoid)
      console.log('Switching to flat terrain');
      viewer.terrainProvider = new EllipsoidTerrainProvider();
    }
  }, [layers]);

  // Render mission AOI polygons - updates immediately when altitude changes
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    
    // Remove existing mission entities
    const entitiesToRemove: Entity[] = [];
    viewer.entities.values.forEach((entity) => {
      if (entity.id.startsWith('mission-aoi-')) {
        entitiesToRemove.push(entity);
      }
    });
    entitiesToRemove.forEach((entity) => viewer.entities.remove(entity));

    // Add polygons for visible missions with AOI - async for terrain sampling
    missions.forEach(async (mission) => {
      if (!mission.visible || !mission.aoi) return;

      const coordinates = mission.aoi.coordinates;
      if (coordinates.length < 3) return;

      const isActiveKmlEditMission =
        kmlEditMode &&
        mission.id === activeMissionId;

      // Live edit overlay handles active mission in edit mode
      if (isActiveKmlEditMission) return;

      // Use mission altitude for polygon elevation (AGL)
      const missionAltitude = mission.parameters.altitude;

      // Sample terrain and create positions with terrain-following
      const waypointsWithAltitude = coordinates.map(coord => [coord[0], coord[1], missionAltitude]);
      const terrainAdjustedPoints = await sampleTerrainForWaypoints(viewer, waypointsWithAltitude, missionAltitude);
      
      // Convert coordinates to Cartesian3 positions with terrain-following altitudes
      const positions = terrainAdjustedPoints.map(coord =>
        Cartesian3.fromDegrees(coord[0], coord[1], coord[2])
      );

      // Add polygon entity at terrain-following altitude - using polyline for better visibility
      // Close the polygon by adding first point at end
      const closedPositions = [...positions, positions[0]];
      
      viewer.entities.add({
        id: `mission-aoi-${mission.id}`,
        name: mission.aoi.name,
        polyline: {
          positions: closedPositions,
          width: 3,
          material: Color.CYAN,
          clampToGround: false,
          arcType: 0, // NONE - straight lines
        },
      });

    });
    
    // Dependencies include missions array - any change triggers immediate re-render
  }, [missions, activeMissionId, kmlEditMode]);

  // AOI point drag editing for active mission
  useEffect(() => {
    if (!viewerRef.current || !activeMissionId || !kmlEditMode) return;

    const viewer = viewerRef.current;
    const activeMission = useMissionStore
      .getState()
      .missions.find((mission) => mission.id === activeMissionId);

    if (!activeMission?.aoi) return;

    const missionAltitude = activeMission.parameters.altitude;
    const initialCoordinates = activeMission.aoi.coordinates.map((coord) => {
      const altitude = Number.isFinite(coord[2]) ? coord[2] : missionAltitude;
      return [coord[0], coord[1], altitude];
    });

    editCoordinatesRef.current = initialCoordinates;
    editAltitudeRef.current = missionAltitude;
    editActiveMissionIdRef.current = activeMissionId;

    const outlineId = `kml-edit-outline-${activeMissionId}`;
    editPolylineIdRef.current = outlineId;

    const buildClosedPositions = (coords: number[][]) => {
      const positions = coords.map((coord) => Cartesian3.fromDegrees(coord[0], coord[1], coord[2]));
      return positions.length > 0 ? [...positions, positions[0]] : positions;
    };

    viewer.entities.add({
      id: outlineId,
      name: `${activeMission.aoi.name} (editing)`,
      polyline: {
        positions: new CallbackProperty(() => {
          const coords = editCoordinatesRef.current ?? initialCoordinates;
          return buildClosedPositions(coords);
        }, false),
        width: 3,
        material: Color.CYAN,
        clampToGround: false,
        arcType: 0,
      },
    });

    let pointEntities: Entity[] = [];
    let addPointEntities: Entity[] = [];
    let deletePointEntity: Entity | null = null;
    let selectedPointIndex: number | null = null;

    const persistCoordinatesToStore = () => {
      const coordsToSave = editCoordinatesRef.current;
      const missionFromStore = useMissionStore
        .getState()
        .missions.find((mission) => mission.id === activeMissionId);

      if (coordsToSave && missionFromStore?.aoi) {
        updateMission(activeMissionId, {
          aoi: {
            ...missionFromStore.aoi,
            coordinates: coordsToSave.map((coord) => [coord[0], coord[1], coord[2]]),
          },
        });
      }
    };

    const removeEntityGroup = (entities: Entity[]) => {
      entities.forEach((entity) => viewer.entities.remove(entity));
    };

    const buildMidPointCartesian = (edgeIndex: number) => {
      const coords = editCoordinatesRef.current;
      if (!coords || coords.length < 2) return Cartesian3.fromDegrees(0, 0, editAltitudeRef.current);

      const nextIndex = (edgeIndex + 1) % coords.length;
      const first = coords[edgeIndex];
      const second = coords[nextIndex];
      const midpointLon = (first[0] + second[0]) / 2;
      const midpointLat = (first[1] + second[1]) / 2;
      const midpointAlt = (first[2] + second[2]) / 2;
      return Cartesian3.fromDegrees(midpointLon, midpointLat, midpointAlt);
    };

    const rebuildEditHandles = () => {
      removeEntityGroup(pointEntities);
      removeEntityGroup(addPointEntities);
      pointEntities = [];
      addPointEntities = [];

      if (deletePointEntity) {
        viewer.entities.remove(deletePointEntity);
        deletePointEntity = null;
      }

      const coords = editCoordinatesRef.current;
      if (!coords || coords.length === 0) return;

      pointEntities = coords.map((coord, index) => {
        const isSelected = selectedPointIndex === index;
        return viewer.entities.add({
          id: `kml-edit-point-${activeMissionId}-${index}`,
          position: Cartesian3.fromDegrees(coord[0], coord[1], coord[2]),
          point: {
            pixelSize: isSelected ? 13 : 11,
            color: isSelected ? Color.RED : Color.CYAN,
            outlineColor: Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      });

      addPointEntities = coords.map((_, edgeIndex) => {
        return viewer.entities.add({
          id: `kml-edit-add-${activeMissionId}-${edgeIndex}`,
          position: new CallbackPositionProperty(() => buildMidPointCartesian(edgeIndex), false),
          label: {
            text: '+',
            font: 'bold 20px sans-serif',
            fillColor: Color.RED,
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      });

      if (selectedPointIndex !== null && coords.length > 3) {
        deletePointEntity = viewer.entities.add({
          id: `kml-edit-delete-${activeMissionId}`,
          position: new CallbackPositionProperty(() => {
            const current = editCoordinatesRef.current;
            if (!current || selectedPointIndex === null || !current[selectedPointIndex]) {
              return Cartesian3.fromDegrees(0, 0, editAltitudeRef.current);
            }
            const selected = current[selectedPointIndex];
            return Cartesian3.fromDegrees(selected[0], selected[1], selected[2]);
          }, false),
          label: {
            text: '🗑',
            font: '18px sans-serif',
            pixelOffset: new Cartesian2(-26, 0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    };

    rebuildEditHandles();

    let draggingPointIndex: number | null = null;
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    const setNavigationEnabled = (enabled: boolean) => {
      const controller = viewer.scene.screenSpaceCameraController;
      controller.enableRotate = enabled;
      controller.enableTranslate = enabled;
      controller.enableTilt = enabled;
      controller.enableZoom = enabled;
      controller.enableLook = enabled;
    };

    handler.setInputAction((event: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(event.position) as { id?: Entity } | undefined;
      if (!picked?.id || typeof picked.id.id !== 'string') return;

      if (picked.id.id === `kml-edit-delete-${activeMissionId}`) {
        const coords = editCoordinatesRef.current;
        if (coords && selectedPointIndex !== null && coords.length > 3) {
          coords.splice(selectedPointIndex, 1);
          selectedPointIndex = null;
          rebuildEditHandles();
          persistCoordinatesToStore();
          viewer.scene.requestRender();
        }
        return;
      }

      const addMatch = picked.id.id.match(new RegExp(`^kml-edit-add-${activeMissionId}-(\\d+)$`));
      if (addMatch) {
        const edgeIndex = Number(addMatch[1]);
        const coords = editCoordinatesRef.current;
        if (coords && coords.length >= 2 && edgeIndex >= 0 && edgeIndex < coords.length) {
          const nextIndex = (edgeIndex + 1) % coords.length;
          const first = coords[edgeIndex];
          const second = coords[nextIndex];
          const midpoint: number[] = [
            (first[0] + second[0]) / 2,
            (first[1] + second[1]) / 2,
            (first[2] + second[2]) / 2,
          ];
          coords.splice(nextIndex, 0, midpoint);
          selectedPointIndex = nextIndex;
          rebuildEditHandles();
          persistCoordinatesToStore();
          viewer.scene.requestRender();
        }
        return;
      }

      const pointMatch = picked.id.id.match(new RegExp(`^kml-edit-point-${activeMissionId}-(\\d+)$`));
      if (pointMatch) {
        draggingPointIndex = Number(pointMatch[1]);
        selectedPointIndex = draggingPointIndex;
        rebuildEditHandles();
        setNavigationEnabled(false);
        return;
      }

      selectedPointIndex = null;
      rebuildEditHandles();
      viewer.scene.requestRender();
    }, ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      if (draggingPointIndex === null) return;

      const lonLat = getLonLatFromScreenPosition(viewer, event.endPosition);
      if (!lonLat) return;

      const currentCoords = editCoordinatesRef.current;
      if (!currentCoords) return;

      const altitude = Number.isFinite(currentCoords[draggingPointIndex][2])
        ? currentCoords[draggingPointIndex][2]
        : editAltitudeRef.current;

      currentCoords[draggingPointIndex] = [lonLat.lon, lonLat.lat, altitude];

      const draggedPoint = pointEntities[draggingPointIndex];
      if (draggedPoint) {
        draggedPoint.position = new ConstantPositionProperty(
          Cartesian3.fromDegrees(lonLat.lon, lonLat.lat, altitude)
        );
      }

      viewer.scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);

    const stopDrag = () => {
      if (draggingPointIndex !== null) {
        persistCoordinatesToStore();

        draggingPointIndex = null;
        setNavigationEnabled(true);
      }
    };

    handler.setInputAction(stopDrag, ScreenSpaceEventType.LEFT_UP);

    return () => {
      handler.destroy();
      setNavigationEnabled(true);
      if (editPolylineIdRef.current) {
        viewer.entities.removeById(editPolylineIdRef.current);
        editPolylineIdRef.current = null;
      }
      removeEntityGroup(pointEntities);
      removeEntityGroup(addPointEntities);
      if (deletePointEntity) {
        viewer.entities.remove(deletePointEntity);
      }
      editCoordinatesRef.current = null;
      editActiveMissionIdRef.current = null;
    };
  }, [activeMissionId, kmlEditMode, updateMission]);

  // Waypoint line editing for imported waypoint missions
  useEffect(() => {
    if (!viewerRef.current || !activeMissionId || !kmlEditMode) return;

    const viewer = viewerRef.current;
    const activeMission = useMissionStore
      .getState()
      .missions.find((mission) => mission.id === activeMissionId);

    if (
      !activeMission ||
      activeMission.missionType !== 'waypoint' ||
      !activeMission.flightLines ||
      activeMission.flightLines.length === 0 ||
      activeMission.flightLines[0].coordinates.length < 2
    ) {
      return;
    }

    const missionAltitude = activeMission.parameters.altitude;
    const initialCoordinates = activeMission.flightLines[0].coordinates.map((coord) => {
      const altitude = Number.isFinite(coord[2]) ? coord[2] : missionAltitude;
      return [coord[0], coord[1], altitude];
    });

    const editCoordinates = { current: initialCoordinates } as { current: number[][] };

    const lineEntity = viewer.entities.add({
      id: `wp-edit-line-${activeMissionId}`,
      polyline: {
        positions: new CallbackProperty(() => {
          return editCoordinates.current.map((coord) => Cartesian3.fromDegrees(coord[0], coord[1], coord[2]));
        }, false),
        width: 3,
        material: Color.YELLOW,
        clampToGround: false,
        arcType: 0,
      },
    });

    let pointEntities: Entity[] = [];
    let addPointEntities: Entity[] = [];
    let guideLineEntities: Entity[] = [];
    let guideLabelEntities: Entity[] = [];
    let deletePointEntity: Entity | null = null;
    let selectedPointIndex: number | null = null;
    let draggingPointIndex: number | null = null;

    const setNavigationEnabled = (enabled: boolean) => {
      const controller = viewer.scene.screenSpaceCameraController;
      controller.enableRotate = enabled;
      controller.enableTranslate = enabled;
      controller.enableTilt = enabled;
      controller.enableZoom = enabled;
      controller.enableLook = enabled;
    };

    const removeEntityGroup = (entities: Entity[]) => {
      entities.forEach((entity) => viewer.entities.remove(entity));
    };

    const persistCoordinatesToStore = () => {
      const missionFromStore = useMissionStore
        .getState()
        .missions.find((mission) => mission.id === activeMissionId);

      if (!missionFromStore || missionFromStore.missionType !== 'waypoint' || !missionFromStore.flightLines?.length) {
        return;
      }

      const updatedFirstLine = {
        ...missionFromStore.flightLines[0],
        coordinates: editCoordinates.current.map((coord) => [coord[0], coord[1], coord[2]]),
      };

      updateMission(activeMissionId, {
        flightLines: [updatedFirstLine, ...missionFromStore.flightLines.slice(1)],
      });
    };

    const buildMidPointCartesian = (edgeIndex: number) => {
      const coords = editCoordinates.current;
      if (coords.length < 2 || edgeIndex < 0 || edgeIndex >= coords.length - 1) {
        return Cartesian3.fromDegrees(0, 0, missionAltitude);
      }
      const first = coords[edgeIndex];
      const second = coords[edgeIndex + 1];
      return Cartesian3.fromDegrees(
        (first[0] + second[0]) / 2,
        (first[1] + second[1]) / 2,
        (first[2] + second[2]) / 2
      );
    };

    const getTerrainHeightAt = (coord: number[]) => {
      const globeHeight = viewer.scene.globe.getHeight(Cartographic.fromDegrees(coord[0], coord[1]));
      return typeof globeHeight === 'number' && Number.isFinite(globeHeight) ? globeHeight : 0;
    };

    const toVerticalText = (height: number) => {
      const text = `${height.toFixed(1)}m`;
      return text.split('').join('\n');
    };

    const getDjiRelativeHeightAt = (index: number) => {
      const coords = editCoordinates.current;
      if (!coords.length || !coords[index]) return missionAltitude;

      const firstAltitude = Number.isFinite(coords[0][2]) ? coords[0][2] : missionAltitude;
      const pointAltitude = Number.isFinite(coords[index][2]) ? coords[index][2] : missionAltitude;

      return missionAltitude + (pointAltitude - firstAltitude);
    };

    const rebuildEditHandles = () => {
      removeEntityGroup(pointEntities);
      removeEntityGroup(addPointEntities);
      removeEntityGroup(guideLineEntities);
      removeEntityGroup(guideLabelEntities);
      pointEntities = [];
      addPointEntities = [];
      guideLineEntities = [];
      guideLabelEntities = [];

      if (deletePointEntity) {
        viewer.entities.remove(deletePointEntity);
        deletePointEntity = null;
      }

      const coords = editCoordinates.current;
      pointEntities = coords.map((coord, index) => {
        const isSelected = selectedPointIndex === index;
        return viewer.entities.add({
          id: `wp-edit-point-${activeMissionId}-${index}`,
          position: Cartesian3.fromDegrees(coord[0], coord[1], coord[2]),
          point: {
            pixelSize: isSelected ? 13 : 11,
            color: isSelected ? Color.RED : Color.CYAN,
            outlineColor: Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      });

      if (coords.length >= 2) {
        addPointEntities = coords.slice(0, -1).map((_, edgeIndex) => {
          return viewer.entities.add({
            id: `wp-edit-add-${activeMissionId}-${edgeIndex}`,
            position: new CallbackPositionProperty(() => buildMidPointCartesian(edgeIndex), false),
            label: {
              text: '+',
              font: 'bold 20px sans-serif',
              fillColor: Color.RED,
              outlineColor: Color.BLACK,
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        });
      }

      if (showWaypointHeightGuides) {
        guideLineEntities = coords.map((_, index) => {
          return viewer.entities.add({
            id: `wp-edit-guide-line-${activeMissionId}-${index}`,
            polyline: {
              positions: new CallbackProperty(() => {
                const current = editCoordinates.current[index];
                if (!current) return [];
                const terrainHeight = getTerrainHeightAt(current);
                return [
                  Cartesian3.fromDegrees(current[0], current[1], current[2]),
                  Cartesian3.fromDegrees(current[0], current[1], terrainHeight),
                ];
              }, false),
              width: 2,
              material: Color.CYAN.withAlpha(0.75),
              clampToGround: false,
              arcType: 0,
            },
          });
        });

        guideLabelEntities = coords.map((_, index) => {
          return viewer.entities.add({
            id: `wp-edit-guide-label-${activeMissionId}-${index}`,
            position: new CallbackPositionProperty(() => {
              const current = editCoordinates.current[index];
              if (!current) return Cartesian3.fromDegrees(0, 0, missionAltitude);
              const terrainHeight = getTerrainHeightAt(current);
              const midHeight = (current[2] + terrainHeight) / 2;
              return Cartesian3.fromDegrees(current[0], current[1], midHeight);
            }, false),
            label: {
              text: new CallbackProperty(() => {
                const current = editCoordinates.current[index];
                if (!current) return '';
                const djiRelativeHeight = getDjiRelativeHeightAt(index);
                return toVerticalText(djiRelativeHeight);
              }, false),
              font: 'bold 11px sans-serif',
              fillColor: Color.WHITE,
              outlineColor: Color.BLACK,
              outlineWidth: 2,
              pixelOffset: new Cartesian2(8, 0),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        });
      }

      if (selectedPointIndex !== null && coords.length > 2) {
        deletePointEntity = viewer.entities.add({
          id: `wp-edit-delete-${activeMissionId}`,
          position: new CallbackPositionProperty(() => {
            const selected = editCoordinates.current[selectedPointIndex!];
            return selected
              ? Cartesian3.fromDegrees(selected[0], selected[1], selected[2])
              : Cartesian3.fromDegrees(0, 0, missionAltitude);
          }, false),
          label: {
            text: '🗑',
            font: '18px sans-serif',
            pixelOffset: new Cartesian2(-26, 0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    };

    rebuildEditHandles();

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((event: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(event.position) as { id?: Entity } | undefined;
      if (!picked?.id || typeof picked.id.id !== 'string') return;

      if (picked.id.id === `wp-edit-delete-${activeMissionId}`) {
        if (selectedPointIndex !== null && editCoordinates.current.length > 2) {
          editCoordinates.current.splice(selectedPointIndex, 1);
          selectedPointIndex = null;
          rebuildEditHandles();
          persistCoordinatesToStore();
          viewer.scene.requestRender();
        }
        return;
      }

      const addMatch = picked.id.id.match(new RegExp(`^wp-edit-add-${activeMissionId}-(\\d+)$`));
      if (addMatch) {
        const edgeIndex = Number(addMatch[1]);
        const coords = editCoordinates.current;
        if (edgeIndex >= 0 && edgeIndex < coords.length - 1) {
          const first = coords[edgeIndex];
          const second = coords[edgeIndex + 1];
          const midpoint: number[] = [
            (first[0] + second[0]) / 2,
            (first[1] + second[1]) / 2,
            (first[2] + second[2]) / 2,
          ];
          coords.splice(edgeIndex + 1, 0, midpoint);
          selectedPointIndex = edgeIndex + 1;
          rebuildEditHandles();
          persistCoordinatesToStore();
          viewer.scene.requestRender();
        }
        return;
      }

      const pointMatch = picked.id.id.match(new RegExp(`^wp-edit-point-${activeMissionId}-(\\d+)$`));
      if (pointMatch) {
        draggingPointIndex = Number(pointMatch[1]);
        selectedPointIndex = draggingPointIndex;
        rebuildEditHandles();
        setNavigationEnabled(false);
      }
    }, ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      if (draggingPointIndex === null) return;

      const lonLat = getLonLatFromScreenPosition(viewer, event.endPosition);
      if (!lonLat) return;

      const currentCoords = editCoordinates.current;
      const altitude = Number.isFinite(currentCoords[draggingPointIndex][2])
        ? currentCoords[draggingPointIndex][2]
        : missionAltitude;

      currentCoords[draggingPointIndex] = [lonLat.lon, lonLat.lat, altitude];

      const draggedPoint = pointEntities[draggingPointIndex];
      if (draggedPoint) {
        draggedPoint.position = new ConstantPositionProperty(
          Cartesian3.fromDegrees(lonLat.lon, lonLat.lat, altitude)
        );
      }

      viewer.scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);

    const stopDrag = () => {
      if (draggingPointIndex !== null) {
        persistCoordinatesToStore();
        draggingPointIndex = null;
        setNavigationEnabled(true);
      }
    };

    handler.setInputAction(stopDrag, ScreenSpaceEventType.LEFT_UP);

    return () => {
      handler.destroy();
      setNavigationEnabled(true);
      viewer.entities.remove(lineEntity);
      removeEntityGroup(pointEntities);
      removeEntityGroup(addPointEntities);
      removeEntityGroup(guideLineEntities);
      removeEntityGroup(guideLabelEntities);
      if (deletePointEntity) {
        viewer.entities.remove(deletePointEntity);
      }
    };
  }, [activeMissionId, kmlEditMode, showWaypointHeightGuides, updateMission]);

  // AOI draw mode: click points, live preview line, right-click to finish polygon
  useEffect(() => {
    if (!viewerRef.current || !activeMissionId || !drawAoiMode) return;

    const viewer = viewerRef.current;
    const activeMission = useMissionStore
      .getState()
      .missions.find((mission) => mission.id === activeMissionId);

    if (!activeMission) return;

    const drawAltitude = 0;
    drawPointsRef.current = [];
    drawHoverRef.current = null;

    const drawLineEntity = viewer.entities.add({
      id: `draw-aoi-line-${activeMissionId}`,
      polyline: {
        positions: new CallbackProperty(() => {
          const points = drawPointsRef.current;
          const hover = drawHoverRef.current;
          const path = hover ? [...points, hover] : points;
          return path.map((coord) => Cartesian3.fromDegrees(coord[0], coord[1], coord[2]));
        }, false),
        width: 3,
        material: Color.CYAN,
        clampToGround: false,
        arcType: 0,
      },
    });

    const drawPointEntities: Entity[] = [];
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    const addDrawPointEntity = (coord: number[], index: number) => {
      const entity = viewer.entities.add({
        id: `draw-aoi-point-${activeMissionId}-${index}`,
        position: Cartesian3.fromDegrees(coord[0], coord[1], coord[2]),
        point: {
          pixelSize: 10,
          color: Color.YELLOW,
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      drawPointEntities.push(entity);
    };

    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      const lonLat = getLonLatFromScreenPosition(viewer, event.endPosition);
      if (!lonLat) return;

      drawHoverRef.current = [lonLat.lon, lonLat.lat, drawAltitude];
      viewer.scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((event: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(event.position) as { id?: Entity } | undefined;
      if (picked?.id && typeof picked.id.id === 'string' && picked.id.id.startsWith(`draw-aoi-point-${activeMissionId}-`)) {
        return;
      }

      const lonLat = getLonLatFromScreenPosition(viewer, event.position);
      if (!lonLat) return;

      const newPoint: number[] = [lonLat.lon, lonLat.lat, drawAltitude];
      drawPointsRef.current = [...drawPointsRef.current, newPoint];
      addDrawPointEntity(newPoint, drawPointsRef.current.length - 1);
      viewer.scene.requestRender();
    }, ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction(() => {
      const points = drawPointsRef.current;
      if (points.length < 3) return;

      const polygonCoords = points.map((coord) => [coord[0], coord[1], coord[2]]);
      updateMission(activeMissionId, {
        aoi: {
          type: 'polygon',
          coordinates: polygonCoords,
          name: `Drawn Area ${new Date().toLocaleTimeString()}`,
        },
        flightLines: [],
      });

      setDrawAoiMode(false);
      viewer.scene.requestRender();
    }, ScreenSpaceEventType.RIGHT_CLICK);

    return () => {
      handler.destroy();
      viewer.entities.remove(drawLineEntity);
      drawPointEntities.forEach((entity) => viewer.entities.remove(entity));
      drawPointsRef.current = [];
      drawHoverRef.current = null;
    };
  }, [activeMissionId, drawAoiMode, setDrawAoiMode, updateMission]);

  // Waypoint draw mode: click points, live preview line, right-click to finish route
  useEffect(() => {
    if (!viewerRef.current || !activeMissionId || !drawWaypointMode) return;

    const viewer = viewerRef.current;
    const activeMission = useMissionStore
      .getState()
      .missions.find((mission) => mission.id === activeMissionId);

    if (!activeMission) return;

    const drawAltitude = Number.isFinite(activeMission.parameters.altitude)
      ? activeMission.parameters.altitude
      : 100;
    drawPointsRef.current = [];
    drawHoverRef.current = null;

    const drawLineEntity = viewer.entities.add({
      id: `draw-waypoint-line-${activeMissionId}`,
      polyline: {
        positions: new CallbackProperty(() => {
          const points = drawPointsRef.current;
          const hover = drawHoverRef.current;
          const path = hover ? [...points, hover] : points;
          return path.map((coord) => Cartesian3.fromDegrees(coord[0], coord[1], coord[2]));
        }, false),
        width: 3,
        material: Color.YELLOW,
        clampToGround: false,
        arcType: 0,
      },
    });

    const drawPointEntities: Entity[] = [];
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    const addDrawPointEntity = (coord: number[], index: number) => {
      const entity = viewer.entities.add({
        id: `draw-waypoint-point-${activeMissionId}-${index}`,
        position: Cartesian3.fromDegrees(coord[0], coord[1], coord[2]),
        point: {
          pixelSize: 10,
          color: Color.YELLOW,
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      drawPointEntities.push(entity);
    };

    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      const lonLat = getLonLatFromScreenPosition(viewer, event.endPosition);
      if (!lonLat) return;

      drawHoverRef.current = [lonLat.lon, lonLat.lat, drawAltitude];
      viewer.scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((event: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(event.position) as { id?: Entity } | undefined;
      if (
        picked?.id &&
        typeof picked.id.id === 'string' &&
        picked.id.id.startsWith(`draw-waypoint-point-${activeMissionId}-`)
      ) {
        return;
      }

      const lonLat = getLonLatFromScreenPosition(viewer, event.position);
      if (!lonLat) return;

      const newPoint: number[] = [lonLat.lon, lonLat.lat, drawAltitude];
      drawPointsRef.current = [...drawPointsRef.current, newPoint];
      addDrawPointEntity(newPoint, drawPointsRef.current.length - 1);
      viewer.scene.requestRender();
    }, ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction(async () => {
      const points = drawPointsRef.current;
      if (points.length < 2) return;

      const terrainAdjustedWaypoints = await sampleTerrainForWaypoints(viewer, points, drawAltitude);

      updateMission(activeMissionId, {
        missionType: 'waypoint',
        aoi: null,
        flightLines: [
          {
            id: `waypoint-draw-${Date.now()}`,
            coordinates: terrainAdjustedWaypoints,
            photoPoints: [],
          },
        ],
      });

      setDrawWaypointMode(false);
      viewer.scene.requestRender();
    }, ScreenSpaceEventType.RIGHT_CLICK);

    return () => {
      handler.destroy();
      viewer.entities.remove(drawLineEntity);
      drawPointEntities.forEach((entity) => viewer.entities.remove(entity));
      drawPointsRef.current = [];
      drawHoverRef.current = null;
    };
  }, [activeMissionId, drawWaypointMode, setDrawWaypointMode, updateMission]);

  // Render imagery layers (RGB/DSM/Cesium Ion)
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    
    // Remove existing custom imagery layers
    const layersToRemove: ImageryLayer[] = [];
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      const imageryLayer = viewer.imageryLayers.get(i);
      // @ts-ignore - accessing custom property
      if (imageryLayer._customLayerId) {
        layersToRemove.push(imageryLayer);
      }
    }
    layersToRemove.forEach((layer) => viewer.imageryLayers.remove(layer));

    // Add imagery layers for visible layers
    layers.forEach(async (layer) => {
      if (!layer.visible) return;
      
      let imageryLayer: ImageryLayer | null = null;
      
      // Handle Cesium Ion assets
      if (layer.type === 'cesium-ion' && layer.cesiumAssetId) {
        try {
          // Handle TERRAIN assets differently from IMAGERY
          if (layer.cesiumAssetType === 'TERRAIN') {
            const terrainProvider = await CesiumTerrainProvider.fromIonAssetId(layer.cesiumAssetId);
            viewer.terrainProvider = terrainProvider;
            console.log(`Applied Cesium Ion TERRAIN: ${layer.name} (Asset: ${layer.cesiumAssetId})`);
            // Terrain doesn't use imagery layers, so skip the rest
            return;
          } else {
            // IMAGERY or 3DTILES - use IonImageryProvider
            const provider = await IonImageryProvider.fromAssetId(layer.cesiumAssetId);
            imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
            console.log(`Added Cesium Ion ${layer.cesiumAssetType || 'IMAGERY'} layer: ${layer.name} (Asset: ${layer.cesiumAssetId})`);
          }
        } catch (error) {
          console.error(`Failed to load Cesium Ion asset ${layer.cesiumAssetId}:`, error);
          return;
        }
      }
      // Future: Add support for other layer types here
      
      if (imageryLayer) {
        // Store custom ID for removal
        // @ts-ignore - adding custom property
        imageryLayer._customLayerId = `custom-${layer.id}`;
        
        // Set opacity (transparency slider)
        imageryLayer.alpha = layer.opacity;
        
        // Move custom layers to top (above basemap and labels)
        viewer.imageryLayers.raise(imageryLayer);
      }
    });
  }, [layers]);

  // Render flight lines and waypoints
  useEffect(() => {
    console.log('=== FLIGHT LINE RENDERING EFFECT TRIGGERED ===');
    console.log('Missions array:', missions);
    console.log('Missions length:', missions.length);
    console.log('Missions with flight lines:', missions.filter(m => m.flightLines && m.flightLines.length > 0).length);
    
    if (!viewerRef.current) {
      console.log('No viewer ref - skipping render');
      return;
    }

    const viewer = viewerRef.current;
    
    // Remove existing flight line entities
    const entitiesToRemove: Entity[] = [];
    viewer.entities.values.forEach((entity) => {
      if (typeof entity.id !== 'string') return;
      if (
        entity.id.startsWith('flight-line-') ||
        entity.id.startsWith('flight-connector-') ||
        entity.id.startsWith('waypoint-guide-line-') ||
        entity.id.startsWith('waypoint-guide-label-') ||
        entity.id.startsWith('waypoint-')
      ) {
        entitiesToRemove.push(entity);
      }
    });
    console.log(`Removing ${entitiesToRemove.length} old flight line entities`);
    entitiesToRemove.forEach((entity) => viewer.entities.remove(entity));

    // Add flight lines for visible missions
    let totalLinesRendered = 0;
    missions.forEach((mission) => {
      console.log(`Mission ${mission.name} (${mission.id}):`, {
        visible: mission.visible,
        hasFlightLines: !!mission.flightLines,
        numLines: mission.flightLines?.length || 0,
        flightLines: mission.flightLines
      });
      
      if (!mission.visible) {
        console.log(`  Skipping ${mission.name} - not visible`);
        return;
      }
      
      if (!mission.flightLines || mission.flightLines.length === 0) {
        console.log(`  Skipping ${mission.name} - no flight lines`);
        return;
      }

      if (kmlEditMode && mission.id === activeMissionId && mission.missionType === 'waypoint') {
        console.log(`  Skipping ${mission.name} default render - waypoint edit overlay active`);
        return;
      }

      console.log(`Rendering flight lines for mission ${mission.name}: ${mission.flightLines.length} lines`);
      
      const missionAltitude = mission.parameters.altitude;

      const isValidCoord = (coord: number[] | undefined): coord is number[] => {
        return !!coord && Number.isFinite(coord[0]) && Number.isFinite(coord[1]);
      };

      const drawableLines = mission.flightLines
        .map((line, lineIndex) => ({
          line,
          lineIndex,
          safeCoordinates: line.coordinates.filter(isValidCoord),
        }))
        .filter(({ safeCoordinates }) => safeCoordinates.length > 0);

      if (drawableLines.length === 0) {
        console.log(`  Skipping ${mission.name} - no drawable coordinates`);
        return;
      }

      const firstLineRef = drawableLines[0];
      const lastLineRef = drawableLines[drawableLines.length - 1];
      const firstWaypointRef = {
        lineIndex: firstLineRef.lineIndex,
        wpIndex: 0,
      };
      const lastWaypointRef = {
        lineIndex: lastLineRef.lineIndex,
        wpIndex: lastLineRef.safeCoordinates.length - 1,
      };

      drawableLines.forEach(({ line, lineIndex, safeCoordinates }, drawableIndex) => {
        if (safeCoordinates.length < 2) {
          console.log(`  Skipping line ${lineIndex} - insufficient coordinates`);
        } else {
          console.log(`  Line ${lineIndex}: ${safeCoordinates.length} waypoints, first coord:`, safeCoordinates[0]);

          // Create polyline for flight path
          const positions = safeCoordinates.map(coord =>
            Cartesian3.fromDegrees(
              coord[0],
              coord[1],
              Number.isFinite(coord[2]) ? coord[2] : missionAltitude
            )
          );
          
          console.log(`  Creating polyline with ${positions.length} positions`);

          const polylineEntity = viewer.entities.add({
            id: `flight-line-${mission.id}-${lineIndex}`,
            name: `Flight Line ${lineIndex + 1}`,
            polyline: {
              positions: positions,
              width: 4,
              material: Color.YELLOW,
              clampToGround: false,
              arcType: 0, // NONE - straight lines
            },
          });
          
          console.log(`  ✓ Created polyline entity: ${polylineEntity.id}`);
          totalLinesRendered++;
        }

        // Always connect end of current line to start of next line to show direction continuity
        if (drawableIndex < drawableLines.length - 1) {
          const currentLast = safeCoordinates[safeCoordinates.length - 1];
          const nextFirst = drawableLines[drawableIndex + 1].safeCoordinates[0];
          if (currentLast && nextFirst) {
            viewer.entities.add({
              id: `flight-connector-${mission.id}-${drawableIndex}`,
              name: `Flight Connector ${drawableIndex + 1}`,
              polyline: {
                positions: [
                  Cartesian3.fromDegrees(
                    currentLast[0],
                    currentLast[1],
                    Number.isFinite(currentLast[2]) ? currentLast[2] : missionAltitude
                  ),
                  Cartesian3.fromDegrees(
                    nextFirst[0],
                    nextFirst[1],
                    Number.isFinite(nextFirst[2]) ? nextFirst[2] : missionAltitude
                  ),
                ],
                width: 3,
                material: Color.YELLOW.withAlpha(0.9),
                clampToGround: false,
                arcType: 0,
              },
            });
          }
        }

        // Add waypoint markers
        safeCoordinates.forEach((coord, wpIndex) => {
          const isPhotoPoint = line.photoPoints?.some(
            pp => pp[0] === coord[0] && pp[1] === coord[1]
          );
          const isStartPoint =
            lineIndex === firstWaypointRef.lineIndex &&
            wpIndex === firstWaypointRef.wpIndex;
          const isEndPoint =
            lineIndex === lastWaypointRef.lineIndex &&
            wpIndex === lastWaypointRef.wpIndex;

          const pointSize = isStartPoint || isEndPoint ? 13 : isPhotoPoint ? 10 : 6;
          const pointColor = isStartPoint
            ? Color.LIME
            : isEndPoint
              ? Color.YELLOW
              : isPhotoPoint
                ? Color.RED
                : Color.YELLOW;

          viewer.entities.add({
            id: `waypoint-${mission.id}-${lineIndex}-${wpIndex}`,
            position: Cartesian3.fromDegrees(
              coord[0],
              coord[1],
              Number.isFinite(coord[2]) ? coord[2] : missionAltitude
            ),
            point: {
              pixelSize: pointSize,
              color: pointColor,
              outlineColor: Color.WHITE,
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY, // Always visible
            },
            label: isStartPoint
              ? {
                  text: 'S',
                  font: 'bold 16px sans-serif',
                  fillColor: Color.WHITE,
                  outlineColor: Color.BLACK,
                  outlineWidth: 2,
                  pixelOffset: new Cartesian2(14, 0),
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                }
              : undefined,
          });

          if (mission.missionType === 'waypoint' && showWaypointHeightGuides) {
            const terrainHeightRaw = viewer.scene.globe.getHeight(Cartographic.fromDegrees(coord[0], coord[1]));
            const terrainHeight = typeof terrainHeightRaw === 'number' && Number.isFinite(terrainHeightRaw)
              ? terrainHeightRaw
              : 0;

            const firstCoord = safeCoordinates[0];
            const firstAltitude = Number.isFinite(firstCoord?.[2]) ? firstCoord[2] : missionAltitude;
            const pointAltitude = Number.isFinite(coord[2]) ? coord[2] : missionAltitude;
            const djiRelativeHeight = missionAltitude + (pointAltitude - firstAltitude);

            viewer.entities.add({
              id: `waypoint-guide-line-${mission.id}-${lineIndex}-${wpIndex}`,
              polyline: {
                positions: [
                  Cartesian3.fromDegrees(coord[0], coord[1], pointAltitude),
                  Cartesian3.fromDegrees(coord[0], coord[1], terrainHeight),
                ],
                width: 2,
                material: Color.CYAN.withAlpha(0.75),
                clampToGround: false,
                arcType: 0,
              },
            });

            viewer.entities.add({
              id: `waypoint-guide-label-${mission.id}-${lineIndex}-${wpIndex}`,
              position: Cartesian3.fromDegrees(coord[0], coord[1], (pointAltitude + terrainHeight) / 2),
              label: {
                text: `${djiRelativeHeight.toFixed(1)}m`.split('').join('\n'),
                font: 'bold 11px sans-serif',
                fillColor: Color.WHITE,
                outlineColor: Color.BLACK,
                outlineWidth: 2,
                pixelOffset: new Cartesian2(8, 0),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            });
          }
        });
      });
    });
    
    console.log(`=== RENDER COMPLETE: ${totalLinesRendered} flight lines rendered ===`);
    console.log(`Total entities in viewer: ${viewer.entities.values.length}`);
  }, [missions, kmlEditMode, activeMissionId, showWaypointHeightGuides]);

  return (
    <div 
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        position: 'relative',
      }}
    />
  );
};
