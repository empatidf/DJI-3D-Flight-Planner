/**
 * CesiumMap Component
 * Main 3D/2D visualization component using CesiumJS
 */

import { useEffect, useRef, useState } from 'react';
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
  CartographicGeocoderService,
  IonGeocoderService,
  Cesium3DTileset,
  Cesium3DTileStyle,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useMissionStore } from '../stores/mission-store';
import { sampleTerrainForWaypoints } from '../lib/terrain-sampler';

Ion.defaultAccessToken = '';

export const CesiumMap = () => {
  const viewerRef = useRef<Viewer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const compassArrowRef = useRef<HTMLDivElement>(null);
  const [viewerInitVersion, setViewerInitVersion] = useState(0);
  const [firstLoadLayerRefreshTick, setFirstLoadLayerRefreshTick] = useState(0);
  const firstLoadLayerRefreshDoneRef = useRef(false);
  const [contextMenuState, setContextMenuState] = useState<{
    visible: boolean;
    x: number;
    y: number;
    lon: number;
    lat: number;
  }>({
    visible: false,
    x: 0,
    y: 0,
    lon: 0,
    lat: 0,
  });
  const editCoordinatesRef = useRef<number[][] | null>(null);
  const editAltitudeRef = useRef<number>(100);
  const editActiveMissionIdRef = useRef<string | null>(null);
  const editPolylineIdRef = useRef<string | null>(null);
  const drawPointsRef = useRef<number[][]>([]);
  const drawHoverRef = useRef<number[] | null>(null);
  const suppressNextContextMenuRef = useRef<boolean>(false);
  const missionAoiRenderVersionRef = useRef<number>(0);
  const missionAoiTerrainCacheRef = useRef<Record<string, { coordKey: string; baseHeights: number[] }>>({});
  const lastAutoFocusedMissionIdRef = useRef<string | null>(null);
  const worldImageryLayerRef = useRef<ImageryLayer | null>(null);
  const worldLabelsLayerRef = useRef<ImageryLayer | null>(null);
  const customTilesetsRef = useRef<Record<string, Cesium3DTileset>>({});
  const customLayerLoadRunIdRef = useRef<number>(0);
  const viewMode = useMissionStore((state) => state.viewMode);
  const cameraTarget = useMissionStore((state) => state.cameraTarget);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);
  const setLastMapView = useMissionStore((state) => state.setLastMapView);
  const missions = useMissionStore((state) => state.missions);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const kmlEditMode = useMissionStore((state) => state.kmlEditMode);
  const drawAoiMode = useMissionStore((state) => state.drawAoiMode);
  const drawWaypointMode = useMissionStore((state) => state.drawWaypointMode);
  const showAreaHeightGuides = useMissionStore((state) => state.showAreaHeightGuides);
  const showWaypointHeightGuides = useMissionStore((state) => state.showWaypointHeightGuides);
  const updateMission = useMissionStore((state) => state.updateMission);
  const setDrawAoiMode = useMissionStore((state) => state.setDrawAoiMode);
  const setDrawWaypointMode = useMissionStore((state) => state.setDrawWaypointMode);
  const layers = useMissionStore((state) => state.layers);
  const cesiumToken = useMissionStore((state) => state.cesiumToken);
  const activeMissionIdForKmlEdit = kmlEditMode ? activeMissionId : null;

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

  const updateGeocoderServices = (viewer: Viewer, includeIon: boolean) => {
    if (!viewer.geocoder) return;

    const geocoderServices = [new CartographicGeocoderService()];
    if (includeIon) {
      geocoderServices.unshift(new IonGeocoderService({ scene: viewer.scene }));
    }

    ((viewer.geocoder.viewModel as unknown) as { geocoderServices: unknown[] }).geocoderServices = geocoderServices;
  };

  const loadIonImageryProviderWithRetry = async (
    assetId: number,
    accessToken: string,
    maxAttempts: number = 2,
    retryDelayMs: number = 700
  ) => {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await IonImageryProvider.fromAssetId(assetId, { accessToken } as any);
      } catch (error) {
        lastError = error;
        console.warn(`[LayerLoad] IMAGERY load attempt ${attempt}/${maxAttempts} failed for asset ${assetId}:`, error);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => window.setTimeout(resolve, retryDelayMs));
        }
      }
    }

    throw lastError;
  };

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;

    // Initialize Cesium Viewer (default world is loaded after token is provided)
    const viewer = new Viewer(containerRef.current, {
      baseLayerPicker: false,
      baseLayer: false,
      
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

    // Restore last map view if available, otherwise use global default view
    const persistedMapView = useMissionStore.getState().lastMapView;
    if (
      persistedMapView &&
      Number.isFinite(persistedMapView.longitude) &&
      Number.isFinite(persistedMapView.latitude) &&
      Number.isFinite(persistedMapView.altitude) &&
      Number.isFinite(persistedMapView.heading) &&
      Number.isFinite(persistedMapView.pitch) &&
      Number.isFinite(persistedMapView.roll)
    ) {
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(
          persistedMapView.longitude,
          persistedMapView.latitude,
          persistedMapView.altitude
        ),
        orientation: {
          heading: CesiumMath.toRadians(persistedMapView.heading),
          pitch: CesiumMath.toRadians(persistedMapView.pitch),
          roll: CesiumMath.toRadians(persistedMapView.roll),
        },
      });
    } else {
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(0, 30, 20000000),
        orientation: {
          heading: CesiumMath.toRadians(0),
          pitch: CesiumMath.toRadians(-90),
          roll: 0.0,
        },
      });
    }

    viewerRef.current = viewer;
    setViewerInitVersion((prev) => prev + 1);
    console.log('[Init] Cesium viewer created; viewerInitVersion incremented');

    let compassAngleDegrees = 0;

    const updateCompassHeading = () => {
      if (!compassArrowRef.current) return;

      const headingDegrees = CesiumMath.toDegrees(viewer.camera.heading);
      if (!Number.isFinite(headingDegrees)) return;

      const targetAngle = -headingDegrees;
      let delta = targetAngle - compassAngleDegrees;

      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;

      compassAngleDegrees += delta;
      compassArrowRef.current.style.transform = `translateZ(0) rotate(${compassAngleDegrees}deg)`;
    };

    updateCompassHeading();
    viewer.scene.postRender.addEventListener(updateCompassHeading);

    const persistMapView = () => {
      const cartographic = viewer.camera.positionCartographic;
      const longitude = CesiumMath.toDegrees(cartographic.longitude);
      const latitude = CesiumMath.toDegrees(cartographic.latitude);
      const altitude = cartographic.height;
      const heading = CesiumMath.toDegrees(viewer.camera.heading);
      const pitch = CesiumMath.toDegrees(viewer.camera.pitch);
      const roll = CesiumMath.toDegrees(viewer.camera.roll);

      if (
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(altitude) ||
        !Number.isFinite(heading) ||
        !Number.isFinite(pitch) ||
        !Number.isFinite(roll)
      ) {
        return;
      }

      setLastMapView({
        longitude,
        latitude,
        altitude,
        heading,
        pitch,
        roll,
      });
    };

    viewer.camera.moveEnd.addEventListener(persistMapView);

    // Support both coordinates and address search
    updateGeocoderServices(viewer, !!cesiumToken.trim());
    
    // Store viewer globally for terrain sampling access
    // @ts-ignore
    window.cesiumViewer = viewer;

    // Cleanup
    return () => {
      viewer.scene.postRender.removeEventListener(updateCompassHeading);
      viewer.camera.moveEnd.removeEventListener(persistMapView);
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!contextMenuState.visible) return;

    const closeMenu = () => {
      setContextMenuState((prev) => ({ ...prev, visible: false }));
    };

    window.addEventListener('click', closeMenu);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);

    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [contextMenuState.visible]);

  const handleMapContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    if (suppressNextContextMenuRef.current) {
      suppressNextContextMenuRef.current = false;
      setContextMenuState((prev) => ({ ...prev, visible: false }));
      return;
    }

    if (drawAoiMode || drawWaypointMode) {
      setContextMenuState((prev) => ({ ...prev, visible: false }));
      return;
    }

    const viewer = viewerRef.current;
    const container = containerRef.current;
    if (!viewer || !container) return;

    const rect = container.getBoundingClientRect();
    const position = new Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
    const lonLat = getLonLatFromScreenPosition(viewer, position);

    if (!lonLat) {
      setContextMenuState((prev) => ({ ...prev, visible: false }));
      return;
    }

    setContextMenuState({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      lon: lonLat.lon,
      lat: lonLat.lat,
    });
  };

  const handleCopyClickedCoordinate = async () => {
    if (!contextMenuState.visible) return;

    const coordinateText = `${contextMenuState.lat.toFixed(7)}, ${contextMenuState.lon.toFixed(7)}`;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(coordinateText);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = coordinateText;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!copied) {
          throw new Error('Fallback copy command was rejected');
        }
      }
    } catch {
      window.prompt('Copy coordinates (Ctrl+C, Enter):', coordinateText);
    }

    setContextMenuState((prev) => ({ ...prev, visible: false }));
  };

  // Load default world layers only when a valid token is present
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;

    const removeWorldLayers = () => {
      if (worldImageryLayerRef.current) {
        viewer.imageryLayers.remove(worldImageryLayerRef.current, true);
        worldImageryLayerRef.current = null;
      }
      if (worldLabelsLayerRef.current) {
        viewer.imageryLayers.remove(worldLabelsLayerRef.current, true);
        worldLabelsLayerRef.current = null;
      }
    };

    removeWorldLayers();

    const token = cesiumToken.trim();
    console.log('[WorldLayers] Effect triggered', {
      hasViewer: !!viewerRef.current,
      viewerInitVersion,
      hasToken: !!token,
    });

    if (!token) {
      Ion.defaultAccessToken = '';
      updateGeocoderServices(viewer, false);
      viewer.scene.requestRender();
      return;
    }

    Ion.defaultAccessToken = token;
    updateGeocoderServices(viewer, true);
    let cancelled = false;

    const loadWorldLayers = async () => {
      try {
        const imageryProvider = await IonImageryProvider.fromAssetId(2);
        if (cancelled || !viewerRef.current) return;
        worldImageryLayerRef.current = viewer.imageryLayers.addImageryProvider(imageryProvider, 0);

        const labelsProvider = await IonImageryProvider.fromAssetId(3);
        if (cancelled || !viewerRef.current) return;
        worldLabelsLayerRef.current = viewer.imageryLayers.addImageryProvider(labelsProvider);

        viewer.scene.requestRender();
      } catch (error) {
        console.error('Failed to load Cesium world layers:', error);
      }
    };

    loadWorldLayers();

    return () => {
      cancelled = true;
    };
  }, [cesiumToken, viewerInitVersion]);

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

  // Auto-focus active mission on refresh and when selected mission changes
  useEffect(() => {
    if (!viewerRef.current) return;
    if (!activeMissionId) {
      lastAutoFocusedMissionIdRef.current = null;
      return;
    }
    if (cameraTarget) return;
    if (lastAutoFocusedMissionIdRef.current === activeMissionId) return;

    const activeMission = missions.find((mission) => mission.id === activeMissionId);
    if (!activeMission) return;

    const sourceCoordinates =
      activeMission.aoi?.coordinates?.length
        ? activeMission.aoi.coordinates
        : (activeMission.flightLines ?? []).flatMap((line) => line.coordinates ?? []);

    const validCoordinates = sourceCoordinates.filter(
      (coord): coord is number[] => !!coord && Number.isFinite(coord[0]) && Number.isFinite(coord[1])
    );

    if (validCoordinates.length === 0) return;

    const lons = validCoordinates.map((coord) => coord[0]);
    const lats = validCoordinates.map((coord) => coord[1]);

    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const span = Math.max(maxLon - minLon, maxLat - minLat);
    const focusAltitude = Math.max(800, span * 140000);

    viewerRef.current.camera.flyTo({
      destination: Cartesian3.fromDegrees(centerLon, centerLat, focusAltitude),
      orientation: {
        heading: CesiumMath.toRadians(0),
        pitch: CesiumMath.toRadians(-90),
        roll: 0,
      },
      duration: 1.5,
    });

    lastAutoFocusedMissionIdRef.current = activeMissionId;
  }, [activeMissionId, missions, cameraTarget]);

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
  }, [layers, viewerInitVersion, firstLoadLayerRefreshTick]);

  // One-time re-apply pass after first viewer initialization (equivalent to uncheck/check once)
  useEffect(() => {
    if (!viewerRef.current) return;
    if (viewerInitVersion === 0) return;
    if (firstLoadLayerRefreshDoneRef.current) return;

    firstLoadLayerRefreshDoneRef.current = true;

    const timer = window.setTimeout(() => {
      setFirstLoadLayerRefreshTick((prev) => prev + 1);
    }, 600);

    return () => {
      window.clearTimeout(timer);
    };
  }, [viewerInitVersion]);

  // Render mission AOI polygons - updates immediately when altitude changes
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    const renderVersion = ++missionAoiRenderVersionRef.current;
    const activeAoiEntityIds = new Set<string>();
    const terrainLayerVisible = layers.some((layer) => layer.id === 'terrain' && layer.visible);

    // Add polygons for visible missions with AOI
    missions.forEach((mission) => {
      if (!mission.visible || !mission.aoi) return;

      const coordinates = mission.aoi.coordinates;
      if (coordinates.length < 3) return;

      const isActiveKmlEditMission =
        kmlEditMode &&
        mission.id === activeMissionIdForKmlEdit;

      // Live edit overlay handles active mission in edit mode
      if (isActiveKmlEditMission) return;

      const entityId = `mission-aoi-${mission.id}`;
      activeAoiEntityIds.add(entityId);

      // Use mission altitude for polygon elevation (AGL)
      const missionAltitude = mission.parameters.altitude;
      const coordKey = coordinates.map((coord) => `${coord[0].toFixed(8)},${coord[1].toFixed(8)}`).join('|');
      const cachedTerrain = missionAoiTerrainCacheRef.current[mission.id];
      const hasValidCache =
        !!cachedTerrain &&
        cachedTerrain.coordKey === coordKey &&
        cachedTerrain.baseHeights.length === coordinates.length;

      // Draw immediately with fallback altitude to keep interaction responsive
      const fallbackPositions = coordinates.map((coord) => {
        const altitude = missionAltitude;
        return Cartesian3.fromDegrees(coord[0], coord[1], altitude);
      });

      const immediatePositions = hasValidCache
        ? coordinates.map((coord, index) =>
            Cartesian3.fromDegrees(coord[0], coord[1], cachedTerrain.baseHeights[index] + missionAltitude)
          )
        : terrainLayerVisible
          ? coordinates.map((coord) => {
              const quickTerrainHeight = viewer.scene.globe.getHeight(Cartographic.fromDegrees(coord[0], coord[1]));
              const terrainBase =
                typeof quickTerrainHeight === 'number' && Number.isFinite(quickTerrainHeight)
                  ? quickTerrainHeight
                  : 0;
              return Cartesian3.fromDegrees(coord[0], coord[1], terrainBase + missionAltitude);
            })
          : fallbackPositions;

      const closedFallbackPositions = [...immediatePositions, immediatePositions[0]];

      const existingEntity = viewer.entities.getById(entityId);
      if (existingEntity?.polyline) {
        existingEntity.name = mission.aoi.name;
        existingEntity.polyline.positions = new CallbackProperty(() => closedFallbackPositions, false);
      } else {
        viewer.entities.add({
          id: entityId,
          name: mission.aoi.name,
          polyline: {
            positions: closedFallbackPositions,
            width: 3,
            material: Color.CYAN,
            clampToGround: false,
            arcType: 0,
          },
        });
      }

      viewer.scene.requestRender();

      // Refine with terrain-following positions asynchronously
      const updateTerrainAdjustedBorder = async () => {
        const waypointsWithAltitude = coordinates.map((coord) => [coord[0], coord[1], missionAltitude]);
        const terrainAdjustedPoints = await sampleTerrainForWaypoints(viewer, waypointsWithAltitude, missionAltitude);

        if (missionAoiRenderVersionRef.current !== renderVersion) return;

        const entity = viewer.entities.getById(entityId);
        if (!entity?.polyline) return;

        const positions = terrainAdjustedPoints.map((coord) =>
          Cartesian3.fromDegrees(coord[0], coord[1], coord[2])
        );

        missionAoiTerrainCacheRef.current[mission.id] = {
          coordKey,
          baseHeights: terrainAdjustedPoints.map((coord) => coord[2] - missionAltitude),
        };

        const refinedPositions = [...positions, positions[0]];
        entity.polyline.positions = new CallbackProperty(() => refinedPositions, false);
        viewer.scene.requestRender();
      };

      updateTerrainAdjustedBorder().catch((error) => {
        console.error(`Failed to terrain-adjust AOI border for mission ${mission.id}:`, error);
      });

    });

    // Remove stale AOI entities only (keeps active borders stable during slider drag)
    const staleEntities: Entity[] = [];
    viewer.entities.values.forEach((entity) => {
      if (entity.id.startsWith('mission-aoi-') && !activeAoiEntityIds.has(entity.id)) {
        staleEntities.push(entity);
      }
    });
    staleEntities.forEach((entity) => viewer.entities.remove(entity));

    const validMissionIds = new Set(
      missions
        .filter((mission) => mission.visible && !!mission.aoi && !(kmlEditMode && mission.id === activeMissionIdForKmlEdit))
        .map((mission) => mission.id)
    );
    Object.keys(missionAoiTerrainCacheRef.current).forEach((missionId) => {
      if (!validMissionIds.has(missionId)) {
        delete missionAoiTerrainCacheRef.current[missionId];
      }
    });
    
    // Dependencies include missions array - any change triggers immediate re-render
  }, [missions, activeMissionIdForKmlEdit, kmlEditMode]);

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
    let guideLineEntities: Entity[] = [];
    let guideLabelEntities: Entity[] = [];
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

    const getTerrainHeightAt = (coord: number[]) => {
      const globeHeight = viewer.scene.globe.getHeight(Cartographic.fromDegrees(coord[0], coord[1]));
      return typeof globeHeight === 'number' && Number.isFinite(globeHeight) ? globeHeight : 0;
    };

    const toVerticalText = (height: number) => `${height.toFixed(1)}m`.split('').join('\n');

    const getDjiRelativeHeightAt = (index: number) => {
      const coords = editCoordinatesRef.current;
      if (!coords || !coords[index]) return missionAltitude;

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

      if (showAreaHeightGuides) {
        guideLineEntities = coords.map((_, index) => {
          return viewer.entities.add({
            id: `kml-edit-guide-line-${activeMissionId}-${index}`,
            polyline: {
              positions: new CallbackProperty(() => {
                const current = editCoordinatesRef.current?.[index];
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
            id: `kml-edit-guide-label-${activeMissionId}-${index}`,
            position: new CallbackPositionProperty(() => {
              const current = editCoordinatesRef.current?.[index];
              if (!current) return Cartesian3.fromDegrees(0, 0, missionAltitude);
              const terrainHeight = getTerrainHeightAt(current);
              const midHeight = (current[2] + terrainHeight) / 2;
              return Cartesian3.fromDegrees(current[0], current[1], midHeight);
            }, false),
            label: {
              text: new CallbackProperty(() => {
                const current = editCoordinatesRef.current?.[index];
                if (!current) return '';
                return toVerticalText(getDjiRelativeHeightAt(index));
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
      removeEntityGroup(guideLineEntities);
      removeEntityGroup(guideLabelEntities);
      if (deletePointEntity) {
        viewer.entities.remove(deletePointEntity);
      }
      editCoordinatesRef.current = null;
      editActiveMissionIdRef.current = null;
    };
  }, [activeMissionId, kmlEditMode, showAreaHeightGuides, updateMission]);

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
      suppressNextContextMenuRef.current = true;

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
      suppressNextContextMenuRef.current = true;

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
    const token = cesiumToken.trim();
    const ionLoadOptions = { accessToken: token } as any;

    if (!token) {
      console.log('[LayerLoad] Skipping custom layer load: missing token');
      return;
    }

    Ion.defaultAccessToken = token;

    const visibleCustomLayers = layers.filter((layer) => layer.visible && Number.isFinite(Number(layer.cesiumAssetId)));
    console.log('[LayerLoad] Effect triggered', {
      viewerInitVersion,
      firstLoadLayerRefreshTick,
      totalLayers: layers.length,
      visibleCustomLayers: visibleCustomLayers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        assetId: layer.cesiumAssetId,
        assetType: layer.cesiumAssetType,
        type: layer.type,
        opacity: layer.opacity,
      })),
    });

    const visibleCesiumLayerById = new Map(
      layers
        .filter((layer) => layer.visible && Number.isFinite(Number(layer.cesiumAssetId)))
        .map((layer) => [layer.id, layer])
    );

    Object.entries(customTilesetsRef.current).forEach(([layerId, tileset]) => {
      const layer = visibleCesiumLayerById.get(layerId);
      if (!layer || layer.cesiumAssetType !== '3DTILES') {
        viewer.scene.primitives.remove(tileset);
        delete customTilesetsRef.current[layerId];
      }
    });
    
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

    const runId = ++customLayerLoadRunIdRef.current;

    const applyCustomLayers = async () => {
      const visibleLayers = layers.filter((layer) => {
        if (!layer.visible) return false;
        const assetId = Number(layer.cesiumAssetId);
        return Number.isFinite(assetId);
      });

      for (const layer of visibleLayers) {
        if (customLayerLoadRunIdRef.current !== runId) return;
        if (!viewerRef.current || viewerRef.current !== viewer) return;

        const assetId = Number(layer.cesiumAssetId);
        if (!Number.isFinite(assetId)) continue;

        console.log(`[LayerLoad] Loading layer ${layer.name} (${layer.id})`, {
          assetId,
          assetType: layer.cesiumAssetType,
          type: layer.type,
        });

        let imageryLayer: ImageryLayer | null = null;

        try {
          if (layer.cesiumAssetType === 'TERRAIN') {
            const terrainProvider = await CesiumTerrainProvider.fromIonAssetId(assetId, ionLoadOptions);
            if (customLayerLoadRunIdRef.current !== runId) return;
            if (!viewerRef.current || viewerRef.current !== viewer) return;

            viewer.terrainProvider = terrainProvider;
            console.log(`Applied Cesium Ion TERRAIN: ${layer.name} (Asset: ${assetId})`);
            viewer.scene.requestRender();
            continue;
          }

          if (layer.cesiumAssetType === '3DTILES') {
            const existingTileset = customTilesetsRef.current[layer.id];
            if (existingTileset) {
              existingTileset.show = true;
              existingTileset.style = new Cesium3DTileStyle({
                color: `color('white', ${layer.opacity})`,
              });
              viewer.scene.requestRender();
              continue;
            }

            const tileset = await Cesium3DTileset.fromIonAssetId(assetId, ionLoadOptions);
            if (customLayerLoadRunIdRef.current !== runId) return;
            if (!viewerRef.current || viewerRef.current !== viewer) return;

            tileset.style = new Cesium3DTileStyle({
              color: `color('white', ${layer.opacity})`,
            });

            viewer.scene.primitives.add(tileset);
            customTilesetsRef.current[layer.id] = tileset;
            console.log(`Added Cesium Ion 3DTILES layer: ${layer.name} (Asset: ${assetId})`);
            viewer.scene.requestRender();
            continue;
          }

          const provider = await loadIonImageryProviderWithRetry(assetId, token);
          if (customLayerLoadRunIdRef.current !== runId) return;
          if (!viewerRef.current || viewerRef.current !== viewer) return;

          imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
          console.log(`Added Cesium Ion ${layer.cesiumAssetType || 'IMAGERY'} layer: ${layer.name} (Asset: ${assetId})`);
        } catch (error) {
          console.error(`Failed to load Cesium Ion asset ${assetId}:`, error);
          continue;
        }

        if (imageryLayer) {
          // @ts-ignore - adding custom property
          imageryLayer._customLayerId = `custom-${layer.id}`;
          imageryLayer.alpha = Number.isFinite(layer.opacity) ? layer.opacity : 1;
          viewer.imageryLayers.raise(imageryLayer);
          viewer.scene.requestRender();
        }
      }
    };

    applyCustomLayers();

    return () => {
      customLayerLoadRunIdRef.current++;
    };
  }, [layers, cesiumToken, viewerInitVersion, firstLoadLayerRefreshTick]);

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
    const activeLineEntityIds = new Set<string>();
    
    // Remove dynamic point/guide entities (line entities are updated in-place)
    const entitiesToRemove: Entity[] = [];
    viewer.entities.values.forEach((entity) => {
      if (typeof entity.id !== 'string') return;
      if (
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

      if (kmlEditMode && mission.id === activeMissionIdForKmlEdit && mission.missionType === 'waypoint') {
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

      // For start/end markers only use lines that have ≥2 coords (actual flight lines).
      // A line with just 1 coord is a stale or orphan entry and must not become the "S" marker.
      const flightLineRefs = drawableLines.filter(({ safeCoordinates }) => safeCoordinates.length >= 2);
      const firstLineRef = flightLineRefs[0] ?? drawableLines[0];
      const lastLineRef  = flightLineRefs[flightLineRefs.length - 1] ?? drawableLines[drawableLines.length - 1];
      const firstMissionCoord = firstLineRef.safeCoordinates[0];
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

          const lineEntityId = `flight-line-${mission.id}-${lineIndex}`;
          activeLineEntityIds.add(lineEntityId);

          const existingLineEntity = viewer.entities.getById(lineEntityId);
          if (existingLineEntity?.polyline) {
            existingLineEntity.name = `Flight Line ${lineIndex + 1}`;
            existingLineEntity.polyline.positions = new CallbackProperty(() => positions, false);
          } else {
            viewer.entities.add({
              id: lineEntityId,
              name: `Flight Line ${lineIndex + 1}`,
              polyline: {
                positions: positions,
                width: 4,
                material: Color.YELLOW,
                clampToGround: false,
                arcType: 0,
              },
            });
          }
          
          console.log(`  ✓ Updated polyline entity: ${lineEntityId}`);
          totalLinesRendered++;
        }

        // Always connect end of current line to start of next line to show direction continuity
        if (drawableIndex < drawableLines.length - 1) {
          const currentLast = safeCoordinates[safeCoordinates.length - 1];
          const nextFirst = drawableLines[drawableIndex + 1].safeCoordinates[0];
          if (currentLast && nextFirst) {
            const connectorEntityId = `flight-connector-${mission.id}-${drawableIndex}`;
            activeLineEntityIds.add(connectorEntityId);

            const connectorPositions = [
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
            ];

            const existingConnector = viewer.entities.getById(connectorEntityId);
            if (existingConnector?.polyline) {
              existingConnector.name = `Flight Connector ${drawableIndex + 1}`;
              existingConnector.polyline.positions = new CallbackProperty(() => connectorPositions, false);
            } else {
              viewer.entities.add({
                id: connectorEntityId,
                name: `Flight Connector ${drawableIndex + 1}`,
                polyline: {
                  positions: connectorPositions,
                  width: 3,
                  material: Color.YELLOW.withAlpha(0.9),
                  clampToGround: false,
                  arcType: 0,
                },
              });
            }
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

          const shouldShowHeightGuides =
            (mission.missionType === 'waypoint' && showWaypointHeightGuides) ||
            (mission.missionType === 'area' && showAreaHeightGuides);

          if (shouldShowHeightGuides) {
            const firstCoord = mission.missionType === 'area' ? firstMissionCoord : safeCoordinates[0];
            const firstAltitude = Number.isFinite(firstCoord?.[2]) ? firstCoord[2] : missionAltitude;
            const pointAltitude = Number.isFinite(coord[2]) ? coord[2] : missionAltitude;
            const djiRelativeHeight = missionAltitude + (pointAltitude - firstAltitude);
            const getTerrainHeightAtPoint = () => {
              const terrainHeightRaw = viewer.scene.globe.getHeight(Cartographic.fromDegrees(coord[0], coord[1]));
              return typeof terrainHeightRaw === 'number' && Number.isFinite(terrainHeightRaw)
                ? terrainHeightRaw
                : pointAltitude;
            };

            viewer.entities.add({
              id: `waypoint-guide-line-${mission.id}-${lineIndex}-${wpIndex}`,
              polyline: {
                positions: new CallbackProperty(() => {
                  const terrainHeight = getTerrainHeightAtPoint();
                  return [
                    Cartesian3.fromDegrees(coord[0], coord[1], pointAltitude),
                    Cartesian3.fromDegrees(coord[0], coord[1], terrainHeight),
                  ];
                }, false),
                width: 2,
                material: Color.CYAN.withAlpha(0.75),
                clampToGround: false,
                arcType: 0,
              },
            });

            viewer.entities.add({
              id: `waypoint-guide-label-${mission.id}-${lineIndex}-${wpIndex}`,
              position: new CallbackPositionProperty(() => {
                const terrainHeight = getTerrainHeightAtPoint();
                return Cartesian3.fromDegrees(coord[0], coord[1], (pointAltitude + terrainHeight) / 2);
              }, false),
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

    const staleLineEntities: Entity[] = [];
    viewer.entities.values.forEach((entity) => {
      if (typeof entity.id !== 'string') return;
      if (
        (entity.id.startsWith('flight-line-') || entity.id.startsWith('flight-connector-')) &&
        !activeLineEntityIds.has(entity.id)
      ) {
        staleLineEntities.push(entity);
      }
    });
    staleLineEntities.forEach((entity) => viewer.entities.remove(entity));
    viewer.scene.requestRender();
    
    console.log(`=== RENDER COMPLETE: ${totalLinesRendered} flight lines rendered ===`);
    console.log(`Total entities in viewer: ${viewer.entities.values.length}`);
  }, [missions, kmlEditMode, activeMissionIdForKmlEdit, showWaypointHeightGuides, showAreaHeightGuides]);

  return (
    <div
      style={{
        width: '100%',
        height: '100vh',
        position: 'relative',
      }}
      onContextMenu={handleMapContextMenu}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div className="compass-overlay" aria-label="North compass">
        <div ref={compassArrowRef} className="compass-arrow">
          <span className="compass-arrow-icon">▲</span>
          <span className="compass-arrow-label">N</span>
        </div>
      </div>
      {contextMenuState.visible && (
        <div
          className="map-context-menu"
          style={{
            left: `${contextMenuState.x}px`,
            top: `${contextMenuState.y}px`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" className="map-context-menu-item" onClick={handleCopyClickedCoordinate}>
            Copy coordinates
          </button>
          <div className="map-context-menu-coord">
            {contextMenuState.lat.toFixed(7)}, {contextMenuState.lon.toFixed(7)}
          </div>
        </div>
      )}
    </div>
  );
};
