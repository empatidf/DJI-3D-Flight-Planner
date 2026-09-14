/**
 * CesiumMap Component
 * Main 3D/2D visualization component using CesiumJS
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
  ConstantProperty,
  ColorMaterialProperty,
  CallbackPositionProperty,
  CartographicGeocoderService,
  IonGeocoderService,
  Cesium3DTileset,
  Cesium3DTileStyle,
  HeightReference,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useMissionStore, waypointKey } from '../stores/mission-store';
import { sampleTerrainForWaypoints, sampleTerrainWithSubPoints, analyzeCollisionRisk } from '../lib/terrain-sampler';
import {
  disposeLocalLayer,
  getLocalEntry,
  getLocalLayerIds,
  getLocalRegistryVersion,
  subscribeLocalRegistry,
} from '../lib/local-tiff/registry';
import type { Layer } from '../stores/mission-store';
import {
  DEFAULT_PANEL_STYLE,
  decodePanelCorners,
  type BarcodeScanData,
  type PanelStyle,
} from '../lib/barcode-panels';
import { BarcodePanelImageryProvider, PanelTileIndex } from '../lib/barcode-panel-imagery-provider';
import type { ImageryProvider, TerrainProvider } from 'cesium';
import { WaypointActionDialog, WaypointQuickEdit } from './WaypointEditors';
import type { WaypointAction } from '../lib/wpml-actions';

Ion.defaultAccessToken = '';

/**
 * Solar panels of one Barcode Scan mission, drawn as an imagery layer (see
 * lib/barcode-panel-imagery-provider for why not as geometry). The grid index
 * survives style changes; only the layer, i.e. its cached tiles, is replaced.
 */
interface PanelLayer {
  corners: string;
  index: PanelTileIndex;
  styleKey: string;
  layer: ImageryLayer;
}

export const CesiumMap = () => {
  const viewerRef = useRef<Viewer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const compassArrowRef = useRef<HTMLDivElement>(null);
  const [viewerInitVersion, setViewerInitVersion] = useState(0);
  // Bumped when the terrain provider changes and again once its tiles have streamed
  // in, so anything sampling terrain heights is rebuilt against the real surface.
  const [terrainReadyVersion, setTerrainReadyVersion] = useState(0);
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
  const [cropMenuState, setCropMenuState] = useState<{ x: number; y: number; pointIndex: number } | null>(null);
  const [cropUndoData, setCropUndoData] = useState<number[][] | null>(null);
  const [pointInfoState, setPointInfoState] = useState<{
    x: number; y: number;
    index: number; lon: number; lat: number;
    altitude: number; terrainHeight: number; agl: number; djiRelativeHeight: number;
  } | null>(null);
  const [waypointQuickEdit, setWaypointQuickEdit] = useState<{ x: number; y: number; pointIndex: number } | null>(null);
  const [waypointActionDialog, setWaypointActionDialog] = useState<{
    pointIndex: number;
    action: WaypointAction | null;
  } | null>(null);
  const cropCallbackRef = useRef<{
    perform: (pointIndex: number) => void;
    undo: (snapshot: number[][]) => void;
    getPointInfo: (pointIndex: number) => { index: number; lon: number; lat: number; altitude: number; terrainHeight: number; agl: number; djiRelativeHeight: number } | null;
  } | null>(null);
  const editCoordinatesRef = useRef<number[][] | null>(null);
  const editAltitudeRef = useRef<number>(100);
  const editActiveMissionIdRef = useRef<string | null>(null);
  const editPolylineIdRef = useRef<string | null>(null);
  const drawPointsRef = useRef<number[][]>([]);
  const drawHoverRef = useRef<number[] | null>(null);
  const suppressNextContextMenuRef = useRef<boolean>(false);
  const cropUndoDataRef = useRef<number[][] | null>(null);
  cropUndoDataRef.current = cropUndoData;
  const missionAoiRenderVersionRef = useRef<number>(0);
  const missionAoiTerrainCacheRef = useRef<Record<string, { coordKey: string; baseHeights: number[] }>>({});
  const lastAutoFocusedMissionIdRef = useRef<string | null>(null);
  const worldImageryLayerRef = useRef<ImageryLayer | null>(null);
  const worldLabelsLayerRef = useRef<ImageryLayer | null>(null);
  const customTilesetsRef = useRef<Record<string, Cesium3DTileset>>({});
  const customLayerLoadRunIdRef = useRef<number>(0);
  const terrainApplyRunIdRef = useRef<number>(0);
  const localImageryLayersRef = useRef<Record<string, ImageryLayer>>({});
  const localTerrainLayerIdRef = useRef<string | null>(null);
  const localAppliedViewerVersionRef = useRef<number>(-1);
  // Barcode Scan panel layers per mission, tied to the viewer that owns them.
  const panelLayersRef = useRef<{ viewer: Viewer | null; layers: Map<string, PanelLayer> }>({
    viewer: null,
    layers: new Map(),
  });
  // Opening a local file does not touch `layers`, so the layer effect would
  // never see it. The registry publishes its own version instead.
  const localRegistryVersion = useSyncExternalStore(subscribeLocalRegistry, getLocalRegistryVersion);
  const viewMode = useMissionStore((state) => state.viewMode);
  const cameraTarget = useMissionStore((state) => state.cameraTarget);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);
  const setLastMapView = useMissionStore((state) => state.setLastMapView);
  const missions = useMissionStore((state) => state.missions);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const kmlEditMode = useMissionStore((state) => state.kmlEditMode);
  const drawAoiMode = useMissionStore((state) => state.drawAoiMode);
  const drawWaypointMode = useMissionStore((state) => state.drawWaypointMode);
  const addTakeoffPointMode = useMissionStore((state) => state.addTakeoffPointMode);
  const setAddTakeoffPointMode = useMissionStore((state) => state.setAddTakeoffPointMode);
  const showAreaHeightGuides = useMissionStore((state) => state.showAreaHeightGuides);
  const showWaypointHeightGuides = useMissionStore((state) => state.showWaypointHeightGuides);
  const collisionRequest = useMissionStore((state) => state.collisionRequest);
  const setCollisionStatus = useMissionStore((state) => state.setCollisionStatus);
  const setCollisionRiskCount = useMissionStore((state) => state.setCollisionRiskCount);
  const setCollisionProgress = useMissionStore((state) => state.setCollisionProgress);
  const setCollisionEffInterval = useMissionStore((state) => state.setCollisionEffInterval);
  const updateMission = useMissionStore((state) => state.updateMission);
  const setSelectedWaypointIndex = useMissionStore((state) => state.setSelectedWaypointIndex);
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

    try {
      const geocoderServices: (CartographicGeocoderService | IonGeocoderService)[] = [
        new CartographicGeocoderService(),
      ];
      if (includeIon && Ion.defaultAccessToken) {
        geocoderServices.unshift(
          new IonGeocoderService({ scene: viewer.scene, accessToken: Ion.defaultAccessToken })
        );
      }

      const vm = viewer.geocoder.viewModel as unknown as { _geocoderServices?: unknown[]; geocoderServices?: unknown[] };
      // CesiumJS stores services in _geocoderServices (private) or geocoderServices (public).
      // Update both to ensure the widget picks up the new services.
      if (vm._geocoderServices) {
        vm._geocoderServices = geocoderServices;
      }
      if (vm.geocoderServices) {
        vm.geocoderServices = geocoderServices;
      }
      // Fallback: set via the public property path used in older Cesium versions
      if (!vm._geocoderServices && !vm.geocoderServices) {
        (viewer.geocoder.viewModel as unknown as { geocoderServices: unknown[] }).geocoderServices = geocoderServices;
      }
    } catch (error) {
      console.warn('Failed to update geocoder services:', error);
    }
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

    // Initialize geocoder with CartographicGeocoderService only (coordinate search).
    // IonGeocoderService (address search) is added later when the Cesium Ion token
    // is available, avoiding a broken geocoder in production where the token is not
    // yet set at Viewer construction time.
    const initialGeocoderServices: (CartographicGeocoderService | IonGeocoderService)[] = [
      new CartographicGeocoderService(),
    ];

    // Initialize Cesium Viewer (default world is loaded after token is provided)
    const viewer = new Viewer(containerRef.current, {
      baseLayerPicker: false,
      baseLayer: false,
      
      // UI elements
      animation: false,
      timeline: false,
      fullscreenButton: false,
      vrButton: false,
      geocoder: initialGeocoderServices,
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

  /**
   * Keep a floating menu inside the window: flip it left/up near an edge instead of
   * letting it run off-screen, which happened on right-clicks near the panel.
   */
  /**
   * Watch the terrain provider so height-dependent geometry can be rebuilt.
   *
   * On a cold load the flight lines and height guides render while the globe is
   * still on the flat ellipsoid — `globe.getHeight()` happily returns 0 there, so
   * every guide was measured against sea level instead of the Cesium Ion DSM that
   * only gets applied a moment later. Nothing re-rendered afterwards, which is why
   * toggling the terrain layer off/on "fixed" it.
   *
   * Provider swaps are rare, so re-rendering on them is cheap. The second bump waits
   * for the new provider's tiles to finish streaming, because heights read before
   * that are still missing or coarse.
   */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    // Hold the Event objects directly. Cleanup must not touch `viewer.scene`: React
    // StrictMode tears the first viewer down, and Cesium's getters throw once the
    // widget is destroyed, which blanked the whole app.
    const terrainProviderChanged = viewer.scene.terrainProviderChanged;
    const tileLoadProgress = viewer.scene.globe.tileLoadProgressEvent;

    let disposed = false;
    let awaitingTiles = false;
    let sawPendingTiles = false;

    const handleProviderChanged = () => {
      if (disposed) return;
      awaitingTiles = true;
      sawPendingTiles = false;
      // Heights sampled against the old provider are now meaningless. Cleared here
      // (synchronously, before the re-render) so the AOI effect re-samples instead
      // of reusing its coordinate-keyed cache.
      missionAoiTerrainCacheRef.current = {};
      // Immediate pass so geometry at least stops using the previous provider.
      setTerrainReadyVersion((version) => version + 1);
    };

    const handleTileProgress = (queuedTileCount: number) => {
      if (disposed || !awaitingTiles) return;

      if (queuedTileCount > 0) {
        sawPendingTiles = true;
        return;
      }

      // Queue drained after the swap — heights for the current view are now real.
      if (!sawPendingTiles) return;
      awaitingTiles = false;
      sawPendingTiles = false;
      missionAoiTerrainCacheRef.current = {};
      setTerrainReadyVersion((version) => version + 1);
    };

    terrainProviderChanged.addEventListener(handleProviderChanged);
    tileLoadProgress.addEventListener(handleTileProgress);

    return () => {
      disposed = true;
      terrainProviderChanged.removeEventListener(handleProviderChanged);
      tileLoadProgress.removeEventListener(handleTileProgress);
    };
  }, [viewerInitVersion]);

  // Escape closes the waypoint context menu, matching the rest of the floating UI.
  useEffect(() => {
    if (!cropMenuState) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCropMenuState(null);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [cropMenuState]);

  const clampMenuToViewport = (x: number, y: number, width: number, height: number) => {
    const margin = 8;
    const left = x + width + margin > window.innerWidth ? Math.max(margin, x - width) : x;
    const top = y + height + margin > window.innerHeight ? Math.max(margin, window.innerHeight - height - margin) : y;
    return { left: `${left}px`, top: `${top}px` };
  };

  /**
   * Memoised terrain lookup.
   *
   * `globe.getHeight()` was being called from inside CallbackProperty callbacks,
   * i.e. once per point per frame — a 300-waypoint route in edit mode issued
   * ~35k queries/second and made the browser stutter. Results are cached per
   * coordinate; a lookup that fails (terrain tiles not streamed in yet) is *not*
   * cached, so it self-heals on a later frame.
   */
  const createTerrainSampler = (viewer: Viewer) => {
    const cache = new Map<string, number>();

    return {
      get(lon: number, lat: number, fallback = 0): number {
        const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
        const cached = cache.get(key);
        if (cached !== undefined) return cached;

        const height = viewer.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat));
        if (typeof height !== 'number' || !Number.isFinite(height)) return fallback;

        // Dragging a point mints a new key per frame; keep the map bounded.
        if (cache.size > 20000) cache.clear();
        cache.set(key, height);
        return height;
      },
    };
  };

  /**
   * Re-assert the imagery stack order: world basemap at the bottom, world labels
   * above it, then every custom Cesium Ion overlay on top.
   *
   * World layers and custom layers are loaded by two independent async effects, so
   * whichever provider resolved last used to end up on top. That is why a custom
   * RGB orthophoto could report "added" and still be invisible until the layer was
   * toggled off/on (which re-ran the custom loader and put it back on top).
   * Both loaders call this once they are done, so the order no longer depends on
   * which network request wins.
   */
  /**
   * A visible local DSM whose file is actually open owns the terrain provider.
   * It is the most detailed, site-specific elevation available, so it wins over
   * both Cesium World Terrain and any Ion TERRAIN asset.
   */
  const hasLiveLocalTerrain = (candidates: Layer[]) =>
    candidates.some((layer) =>
      layer.visible &&
      layer.type === 'local-tiff' &&
      layer.localKind === 'TERRAIN' &&
      !!getLocalEntry(layer.id)?.terrainProvider
    );

  const enforceImageryOrder = (viewer: Viewer) => {
    const collection = viewer.imageryLayers;
    const worldImagery = worldImageryLayerRef.current;
    const worldLabels = worldLabelsLayerRef.current;

    if (worldImagery && collection.contains(worldImagery)) {
      collection.lowerToBottom(worldImagery);
    }

    if (worldLabels && collection.contains(worldLabels)) {
      collection.lowerToBottom(worldLabels);
      // Sit directly above the basemap rather than at the very bottom.
      if (worldImagery && collection.contains(worldImagery)) {
        collection.raise(worldLabels);
      }
    }

    // Raise custom overlays bottom-up so their relative order is preserved.
    const customLayers: ImageryLayer[] = [];
    for (let i = 0; i < collection.length; i++) {
      const layer = collection.get(i);
      // @ts-expect-error - custom marker property set when the layer is added
      if (layer._customLayerId) customLayers.push(layer);
    }
    customLayers.forEach((layer) => collection.raiseToTop(layer));

    // Barcode panel outlines belong above the orthophotos they are drawn over.
    customLayers
      .filter((layer) => String((layer as unknown as { _customLayerId?: string })._customLayerId).startsWith('panels-'))
      .forEach((layer) => collection.raiseToTop(layer));

    viewer.scene.requestRender();
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

        // Custom overlays may already have been added while these were loading.
        enforceImageryOrder(viewer);
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
        : activeMission.barcode
          ? [
              [activeMission.barcode.bounds.west, activeMission.barcode.bounds.south],
              [activeMission.barcode.bounds.east, activeMission.barcode.bounds.north],
            ]
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

    // A visible Cesium Ion TERRAIN asset (e.g. a DSM) owns the terrain provider.
    // Without this guard the two effects raced and whichever finished last won, so
    // the DSM was silently replaced by flat/world terrain on some page loads.
    const hasIonTerrainLayer = layers.some(
      (layer) => layer.visible && layer.cesiumAssetType === 'TERRAIN' && Number.isFinite(Number(layer.cesiumAssetId))
    );

    if (hasIonTerrainLayer) {
      console.log('[Terrain] Cesium Ion terrain asset is visible — leaving terrainProvider to the layer loader');
      return;
    }

    if (hasLiveLocalTerrain(layers)) {
      console.log('[Terrain] Local DSM is visible — leaving terrainProvider to the local layer loader');
      return;
    }

    const runId = ++terrainApplyRunIdRef.current;

    if (terrainLayer?.visible) {
      // Enable 3D terrain with vertex normals and water mask for better visualization
      console.log('Loading 3D terrain...');
      createWorldTerrainAsync({
        requestVertexNormals: true,
        requestWaterMask: true,
      }).then((terrainProvider) => {
        if (!viewerRef.current || viewerRef.current !== viewer) return;
        if (terrainApplyRunIdRef.current !== runId) return;
        viewerRef.current.terrainProvider = terrainProvider;
        console.log('3D terrain loaded - navigate to mountainous areas to see elevation');
      }).catch((error) => {
        console.error('Failed to load Cesium World Terrain:', error);
      });
    } else {
      // Disable terrain (use flat ellipsoid)
      console.log('Switching to flat terrain');
      viewer.terrainProvider = new EllipsoidTerrainProvider();
    }
  }, [layers, viewerInitVersion, firstLoadLayerRefreshTick, localRegistryVersion]);

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
        // Static array — a non-constant CallbackProperty re-read it every frame.
        existingEntity.polyline.positions = new ConstantProperty(closedFallbackPositions);
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
        if (viewer.isDestroyed()) return;

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
        entity.polyline.positions = new ConstantProperty(refinedPositions);
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
    
    // Dependencies include missions array - any change triggers immediate re-render.
    // terrainReadyVersion re-samples the AOI border after a terrain provider swap.
  }, [missions, activeMissionIdForKmlEdit, kmlEditMode, terrainReadyVersion]);

  // Barcode Scan: draw each mission's solar panels
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    const registry = panelLayersRef.current;
    // StrictMode builds a second viewer; the first one's primitives died with it.
    if (registry.viewer !== viewer) {
      registry.viewer = viewer;
      registry.layers.clear();
    }
    const { layers } = registry;
    const imageryLayers = viewer.imageryLayers;

    const drop = (entry: PanelLayer) => {
      if (imageryLayers.contains(entry.layer)) imageryLayers.remove(entry.layer, true);
    };

    const addPanelLayer = (missionId: string, index: PanelTileIndex, style: PanelStyle) => {
      const layer = imageryLayers.addImageryProvider(
        new BarcodePanelImageryProvider(index, style) as unknown as ImageryProvider
      );
      // @ts-expect-error - marker property read by enforceImageryOrder
      layer._customLayerId = `panels-${missionId}`;
      return layer;
    };

    const barcodeMissions = new Map<string, { data: BarcodeScanData; visible: boolean }>();
    missions.forEach((mission) => {
      if (mission.missionType === 'barcode' && mission.barcode && mission.barcode.panelCount > 0) {
        barcodeMissions.set(mission.id, { data: mission.barcode, visible: mission.visible });
      }
    });

    // Deleted missions and replaced layouts lose their layer. Hidden missions
    // keep it, so showing them again is instant.
    layers.forEach((entry, missionId) => {
      const mission = barcodeMissions.get(missionId);
      if (!mission || mission.data.corners !== entry.corners) {
        drop(entry);
        layers.delete(missionId);
      }
    });

    let changed = false;
    barcodeMissions.forEach(({ data, visible }, missionId) => {
      const style: PanelStyle = { ...DEFAULT_PANEL_STYLE, ...data.style };
      const styleKey = JSON.stringify(style);
      let entry = layers.get(missionId);

      if (!entry) {
        const index = new PanelTileIndex(decodePanelCorners(data.corners), data.bounds, data.panelSize);
        entry = { corners: data.corners, index, styleKey, layer: addPanelLayer(missionId, index, style) };
        layers.set(missionId, entry);
        changed = true;
      } else if (entry.styleKey !== styleKey) {
        // Tiles are cached per layer, so a new style needs a fresh layer.
        drop(entry);
        entry.styleKey = styleKey;
        entry.layer = addPanelLayer(missionId, entry.index, style);
        changed = true;
      }

      entry.layer.show = visible && (style.outlineEnabled || style.fillEnabled);
    });

    if (changed) enforceImageryOrder(viewer);
    viewer.scene.requestRender();
  }, [missions, viewerInitVersion]);

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
      const globeHeight = viewer.scene.globe.getHeight(Cartographic.fromDegrees(coord[0], coord[1]));
      const base = typeof globeHeight === 'number' && Number.isFinite(globeHeight) ? globeHeight : 0;
      return [coord[0], coord[1], base + missionAltitude];
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

    const terrainSampler = createTerrainSampler(viewer);

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

    const getTerrainHeightAt = (coord: number[]) => terrainSampler.get(coord[0], coord[1]);

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

    // Async terrain refinement: replace globe-height approximation with accurate sampled heights
    const refineEditOverlayWithTerrain = async () => {
      const waypointsForSampling = activeMission.aoi!.coordinates.map((coord) => [coord[0], coord[1], missionAltitude]);
      const terrainPoints = await sampleTerrainForWaypoints(viewer, waypointsForSampling, missionAltitude);
      if (editCoordinatesRef.current === null) return;
      if (viewer.isDestroyed()) return;
      editCoordinatesRef.current = terrainPoints.map((coord) => [coord[0], coord[1], coord[2]]);
      rebuildEditHandles();
      viewer.scene.requestRender();
    };
    refineEditOverlayWithTerrain().catch((error) => {
      console.error('Failed to terrain-adjust KML edit overlay:', error);
    });

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
    let editLinePositions: Cartesian3[] | null = null;

    const lineEntity = viewer.entities.add({
      id: `wp-edit-line-${activeMissionId}`,
      polyline: {
        // Rebuilt only when a point actually moves; this used to allocate one
        // Cartesian3 per waypoint on every frame.
        positions: new CallbackProperty(() => {
          if (!editLinePositions) {
            editLinePositions = editCoordinates.current.map((coord) =>
              Cartesian3.fromDegrees(coord[0], coord[1])
            );
          }
          return editLinePositions;
        }, false),
        width: 3,
        material: Color.YELLOW,
        clampToGround: true,
      },
    });

    let pointEntities: Entity[] = [];
    let addPointEntities: Entity[] = [];
    let guideLineEntities: Entity[] = [];
    let guideLabelEntities: Entity[] = [];
    let deletePointEntity: Entity | null = null;
    let selectedPointIndex: number | null = null;
    let draggingPointIndex: number | null = null;
    let skipNextAppendClick = false;
    // Overrides are keyed by coordinate, so a dragged point needs its key moved.
    let dragStartKey: string | null = null;

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

    /** Move a per-waypoint override to the point's new coordinate key after a drag. */
    const remapOverrideKey = (oldKey: string, newKey: string) => {
      if (oldKey === newKey) return;

      const missionFromStore = useMissionStore
        .getState()
        .missions.find((mission) => mission.id === activeMissionId);
      const line = missionFromStore?.flightLines?.[0];
      const override = line?.waypointOverrides?.[oldKey];
      if (!missionFromStore || !line || !override) return;

      const overrides = { ...line.waypointOverrides };
      delete overrides[oldKey];
      overrides[newKey] = override;

      updateMission(activeMissionId, {
        flightLines: [{ ...line, waypointOverrides: overrides }, ...missionFromStore.flightLines.slice(1)],
      });
    };

    const terrainSampler = createTerrainSampler(viewer);

    /**
     * Handle positions are read by CallbackPositionProperty on every frame. With a
     * few hundred waypoints that meant rebuilding every Cartesian3 60x/second, so
     * they are cached and invalidated only when a point actually moves.
     */
    const pointPositionCache = new Map<number, Cartesian3>();
    const midPointPositionCache = new Map<number, Cartesian3>();

    const invalidatePositionCaches = (pointIndex?: number) => {
      editLinePositions = null;

      if (pointIndex === undefined) {
        pointPositionCache.clear();
        midPointPositionCache.clear();
        return;
      }
      pointPositionCache.delete(pointIndex);
      // A moved point reshapes the edges on either side of it.
      midPointPositionCache.delete(pointIndex - 1);
      midPointPositionCache.delete(pointIndex);
    };

    const buildMidPointCartesian = (edgeIndex: number) => {
      const cached = midPointPositionCache.get(edgeIndex);
      if (cached) return cached;

      const coords = editCoordinates.current;
      if (coords.length < 2 || edgeIndex < 0 || edgeIndex >= coords.length - 1) {
        return Cartesian3.fromDegrees(0, 0);
      }
      const first = coords[edgeIndex];
      const second = coords[edgeIndex + 1];
      const midLon = (first[0] + second[0]) / 2;
      const midLat = (first[1] + second[1]) / 2;
      const position = Cartesian3.fromDegrees(midLon, midLat, terrainSampler.get(midLon, midLat));
      midPointPositionCache.set(edgeIndex, position);
      return position;
    };

    const getTerrainHeightAt = (coord: number[]) => terrainSampler.get(coord[0], coord[1]);

    const buildPointCartesian = (index: number) => {
      const cached = pointPositionCache.get(index);
      if (cached) return cached;

      const current = editCoordinates.current[index];
      if (!current) return Cartesian3.fromDegrees(0, 0);

      const position = Cartesian3.fromDegrees(current[0], current[1], getTerrainHeightAt(current));
      pointPositionCache.set(index, position);
      return position;
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

      // Publish the selection so the Flight Planning panel can show/edit this waypoint.
      setSelectedWaypointIndex(selectedPointIndex);

      // Indices shift on insert/delete/crop, so drop every cached handle position.
      invalidatePositionCaches();

      const coords = editCoordinates.current;
      pointEntities = coords.map((_, index) => {
        const isSelected = selectedPointIndex === index;
        return viewer.entities.add({
          id: `wp-edit-point-${activeMissionId}-${index}`,
          position: new CallbackPositionProperty(() => buildPointCartesian(index), false),
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

      // Height guides are intentionally hidden during edit mode — editing at ground
      // level makes them misleading. They reappear in normal view after saving.

      if (selectedPointIndex !== null && coords.length > 2) {
        deletePointEntity = viewer.entities.add({
          id: `wp-edit-delete-${activeMissionId}`,
          position: new CallbackPositionProperty(() => buildPointCartesian(selectedPointIndex!), false),
          label: {
            text: '🗑',
            font: 'bold 20px sans-serif',
            fillColor: Color.RED,
            outlineColor: Color.WHITE,
            outlineWidth: 3,
            pixelOffset: new Cartesian2(-28, 0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    };

    cropCallbackRef.current = {
      perform: (pointIndex: number) => {
        const coords = editCoordinates.current;
        if (pointIndex <= 0 || pointIndex >= coords.length) return;
        const snapshot = coords.map((c) => [...c]);
        setCropUndoData(snapshot);
        editCoordinates.current = [coords[0], ...coords.slice(pointIndex)];
        selectedPointIndex = 0;
        rebuildEditHandles();
        persistCoordinatesToStore();
        viewer.scene.requestRender();
      },
      undo: (snapshot: number[][]) => {
        editCoordinates.current = snapshot.map((c) => [...c]);
        selectedPointIndex = null;
        rebuildEditHandles();
        persistCoordinatesToStore();
        viewer.scene.requestRender();
      },
      getPointInfo: (pointIndex: number) => {
        const coords = editCoordinates.current;
        const coord = coords[pointIndex];
        if (!coord) return null;
        const terrainH = getTerrainHeightAt(coord);
        return {
          index: pointIndex,
          lon: coord[0],
          lat: coord[1],
          altitude: Number.isFinite(coord[2]) ? coord[2] : missionAltitude,
          terrainHeight: terrainH,
          agl: (Number.isFinite(coord[2]) ? coord[2] : missionAltitude) - terrainH,
          djiRelativeHeight: getDjiRelativeHeightAt(pointIndex),
        };
      },
    };

    rebuildEditHandles();

    const appendHoverRef = { current: null as number[] | null };

    const getIsAppendMode = () =>
      selectedPointIndex !== null && selectedPointIndex === editCoordinates.current.length - 1;

    const appendPreviewEntity = viewer.entities.add({
      id: `wp-edit-append-preview-${activeMissionId}`,
      polyline: {
        positions: new CallbackProperty(() => {
          if (!getIsAppendMode() || !appendHoverRef.current) return [];
          const coords = editCoordinates.current;
          const last = coords[coords.length - 1];
          if (!last) return [];
          return [
            Cartesian3.fromDegrees(last[0], last[1]),
            Cartesian3.fromDegrees(appendHoverRef.current[0], appendHoverRef.current[1]),
          ];
        }, false),
        width: 3,
        material: Color.YELLOW,
        clampToGround: true,
      },
    });

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((event: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(event.position) as { id?: Entity } | undefined;
      if (!picked?.id || typeof picked.id.id !== 'string') return;

      if (picked.id.id === `wp-edit-delete-${activeMissionId}`) {
        if (selectedPointIndex !== null && editCoordinates.current.length > 2) {
          const deletedIndex = selectedPointIndex;
          editCoordinates.current.splice(deletedIndex, 1);
          selectedPointIndex = Math.max(0, deletedIndex - 1);
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
        const dragged = editCoordinates.current[draggingPointIndex];
        dragStartKey = dragged ? waypointKey(dragged[0], dragged[1]) : null;
        skipNextAppendClick = true;
        rebuildEditHandles();
        setNavigationEnabled(false);
      }
    }, ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      if (draggingPointIndex !== null) {
        const lonLat = getLonLatFromScreenPosition(viewer, event.endPosition);
        if (!lonLat) return;
        const currentCoords = editCoordinates.current;
        const altitude = Number.isFinite(currentCoords[draggingPointIndex][2])
          ? currentCoords[draggingPointIndex][2]
          : missionAltitude;
        currentCoords[draggingPointIndex] = [lonLat.lon, lonLat.lat, altitude];
        invalidatePositionCaches(draggingPointIndex);
        viewer.scene.requestRender();
        return;
      }

      if (getIsAppendMode()) {
        const lonLat = getLonLatFromScreenPosition(viewer, event.endPosition);
        if (lonLat) {
          appendHoverRef.current = [lonLat.lon, lonLat.lat];
          viewer.scene.requestRender();
        }
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((event: { position: Cartesian2 }) => {
      if (!getIsAppendMode()) return;

      // The same click that selected the last point must not also append a new one.
      if (skipNextAppendClick) {
        skipNextAppendClick = false;
        return;
      }

      // Ignore clicks on interactive handle entities; clicks on the line or terrain should add a point
      const picked = viewer.scene.pick(event.position) as { id?: Entity } | undefined;
      if (picked?.id && typeof picked.id.id === 'string') {
        const pid = picked.id.id;
        if (
          pid.startsWith(`wp-edit-point-${activeMissionId}-`) ||
          pid.startsWith(`wp-edit-add-${activeMissionId}-`) ||
          pid === `wp-edit-delete-${activeMissionId}`
        ) return;
      }

      const lonLat = getLonLatFromScreenPosition(viewer, event.position);
      if (!lonLat) return;

      const coords = editCoordinates.current;
      const lastCoord = coords[coords.length - 1];
      const altitude = lastCoord && Number.isFinite(lastCoord[2]) ? lastCoord[2] : missionAltitude;

      coords.push([lonLat.lon, lonLat.lat, altitude]);
      selectedPointIndex = coords.length - 1;
      rebuildEditHandles();
      persistCoordinatesToStore();
      viewer.scene.requestRender();
    }, ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((event: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(event.position) as { id?: Entity } | undefined;

      // Right-click on any waypoint point → context menu
      if (picked?.id && typeof picked.id.id === 'string') {
        const pointMatch = picked.id.id.match(new RegExp(`^wp-edit-point-${activeMissionId}-(\\d+)$`));
        if (pointMatch) {
          suppressNextContextMenuRef.current = true;
          setCropMenuState({ x: event.position.x, y: event.position.y, pointIndex: Number(pointMatch[1]) });
          return;
        }
      }

      // Right-click while in append mode → exit append mode
      if (getIsAppendMode()) {
        suppressNextContextMenuRef.current = true;
        appendHoverRef.current = null;
        selectedPointIndex = null;
        rebuildEditHandles();
        viewer.scene.requestRender();
        return;
      }

      // Any other right-click after a crop → show undo-only menu
      if (cropUndoDataRef.current) {
        suppressNextContextMenuRef.current = true;
        setCropMenuState({ x: event.position.x, y: event.position.y, pointIndex: -1 });
      }
    }, ScreenSpaceEventType.RIGHT_CLICK);

    const stopDrag = () => {
      if (draggingPointIndex !== null) {
        const moved = editCoordinates.current[draggingPointIndex];
        persistCoordinatesToStore();
        if (dragStartKey && moved) {
          remapOverrideKey(dragStartKey, waypointKey(moved[0], moved[1]));
        }
        dragStartKey = null;
        draggingPointIndex = null;
        setNavigationEnabled(true);
      }
    };

    handler.setInputAction(stopDrag, ScreenSpaceEventType.LEFT_UP);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return;
      if (selectedPointIndex === null || editCoordinates.current.length <= 2) return;
      const deletedIndex = selectedPointIndex;
      editCoordinates.current.splice(deletedIndex, 1);
      selectedPointIndex = Math.max(0, deletedIndex - 1);
      rebuildEditHandles();
      persistCoordinatesToStore();
      viewer.scene.requestRender();
    };

    document.addEventListener('keydown', handleKeyDown);

    // Keep the map in sync with edits made from the Flight Planning panel:
    // selection changes and per-waypoint altitude changes.
    let lastSyncedLine: unknown = null;
    const unsubscribeStore = useMissionStore.subscribe((state) => {
      const requested = state.selectedWaypointIndex;
      const clamped =
        requested !== null && requested >= 0 && requested < editCoordinates.current.length ? requested : null;

      if (clamped !== selectedPointIndex) {
        selectedPointIndex = clamped;
        rebuildEditHandles();
        viewer.scene.requestRender();
      }

      const storeLine = state.missions.find((mission) => mission.id === activeMissionId)?.flightLines?.[0];
      if (storeLine === lastSyncedLine) return;
      lastSyncedLine = storeLine;

      const storeCoords = storeLine?.coordinates;
      if (storeCoords && storeCoords.length === editCoordinates.current.length && draggingPointIndex === null) {
        let altitudeChanged = false;
        storeCoords.forEach((coord, index) => {
          const local = editCoordinates.current[index];
          if (local && coord[2] !== local[2]) {
            local[2] = coord[2];
            altitudeChanged = true;
          }
        });
        if (altitudeChanged) viewer.scene.requestRender();
      }
    });

    return () => {
      handler.destroy();
      unsubscribeStore();
      document.removeEventListener('keydown', handleKeyDown);
      cropCallbackRef.current = null;
      setCropMenuState(null);
      setCropUndoData(null);
      setPointInfoState(null);
      setWaypointQuickEdit(null);
      setWaypointActionDialog(null);
      setSelectedWaypointIndex(null);
      setNavigationEnabled(true);
      viewer.entities.remove(lineEntity);
      viewer.entities.remove(appendPreviewEntity);
      removeEntityGroup(pointEntities);
      removeEntityGroup(addPointEntities);
      removeEntityGroup(guideLineEntities);
      removeEntityGroup(guideLabelEntities);
      if (deletePointEntity) {
        viewer.entities.remove(deletePointEntity);
      }
    };
  }, [activeMissionId, kmlEditMode, updateMission, setSelectedWaypointIndex]);

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
          return path.map((coord) => Cartesian3.fromDegrees(coord[0], coord[1]));
        }, false),
        width: 3,
        material: Color.CYAN,
        clampToGround: true,
      },
    });

    const drawPointEntities: Entity[] = [];
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    const addDrawPointEntity = (coord: number[], index: number) => {
      const entity = viewer.entities.add({
        id: `draw-aoi-point-${activeMissionId}-${index}`,
        position: Cartesian3.fromDegrees(coord[0], coord[1]),
        point: {
          pixelSize: 10,
          color: Color.YELLOW,
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
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
        takeoffPoint: null, // reset on new draw
      });

      setDrawAoiMode(false);
      setAddTakeoffPointMode(true);
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

  // Add takeoff point mode: single click sets the takeoff position for area missions
  useEffect(() => {
    if (!viewerRef.current || !activeMissionId || !addTakeoffPointMode) return;

    const viewer = viewerRef.current;

    // Show a cursor overlay hint
    viewer.canvas.style.cursor = 'crosshair';

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction(async (event: { position: Cartesian2 }) => {
      const lonLat = getLonLatFromScreenPosition(viewer, event.position);
      if (!lonLat) return;

      // Terrain-sample the clicked point so altitude = terrain + AGL
      const activeMission = useMissionStore.getState().missions.find(m => m.id === activeMissionId);
      const agl = activeMission?.parameters.altitude ?? 0;
      const sampled = await sampleTerrainForWaypoints(viewer, [[lonLat.lon, lonLat.lat, agl]], agl);
      const alt = sampled[0]?.[2] ?? agl;

      if (viewer.isDestroyed()) return;
      updateMission(activeMissionId, { takeoffPoint: [lonLat.lon, lonLat.lat, alt] });
      setAddTakeoffPointMode(false);
      viewer.canvas.style.cursor = '';
      viewer.scene.requestRender();
    }, ScreenSpaceEventType.LEFT_CLICK);

    return () => {
      handler.destroy();
      viewer.canvas.style.cursor = '';
    };
  }, [activeMissionId, addTakeoffPointMode, setAddTakeoffPointMode, updateMission]);

  // Render takeoff point entity for active area mission
  useEffect(() => {
    if (!viewerRef.current) return;
    const viewer = viewerRef.current;
    const entityId = `takeoff-point-${activeMissionId}`;

    // Remove stale entity first
    const stale = viewer.entities.getById(entityId);
    if (stale) viewer.entities.remove(stale);

    const activeMission = missions.find(m => m.id === activeMissionId);
    if (!activeMission?.takeoffPoint || activeMission.missionType !== 'area' || !activeMission.visible) return;

    const [lon, lat, alt] = activeMission.takeoffPoint;

    viewer.entities.add({
      id: entityId,
      position: Cartesian3.fromDegrees(lon, lat, alt),
      point: {
        pixelSize: 14,
        color: Color.YELLOW,
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '🛫 T',
        font: 'bold 11px sans-serif',
        fillColor: Color.YELLOW,
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        pixelOffset: new Cartesian2(14, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    viewer.scene.requestRender();

    return () => {
      if (viewer.isDestroyed()) return;
      const entity = viewer.entities.getById(entityId);
      if (entity) viewer.entities.remove(entity);
    };
  }, [activeMissionId, missions]);

  // Waypoint draw mode: click points, live preview line, right-click to finish route
  useEffect(() => {
    if (!viewerRef.current || !activeMissionId || !drawWaypointMode) return;

    const viewer = viewerRef.current;
    const activeMission = useMissionStore
      .getState()
      .missions.find((mission) => mission.id === activeMissionId);

    if (!activeMission) return;

    // Draw at ground level (altitude 0) so the user can click precise locations.
    // The mission altitude is applied only after the user finishes drawing (right-click).
    const drawAltitude = 0;
    const missionAltitude = Number.isFinite(activeMission.parameters.altitude)
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
        clampToGround: true,
      },
    });

    const drawPointEntities: Entity[] = [];
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    const addDrawPointEntity = (coord: number[], index: number) => {
      const entity = viewer.entities.add({
        id: `draw-waypoint-point-${activeMissionId}-${index}`,
        position: Cartesian3.fromDegrees(coord[0], coord[1]),
        point: {
          pixelSize: 10,
          color: Color.YELLOW,
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
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

      // Check if terrain follow is enabled for this mission
      const currentMission = useMissionStore
        .getState()
        .missions.find((m) => m.id === activeMissionId);
      const useTerrainFollow = currentMission?.parameters?.alwaysTerrainFollow ?? false;
      const terrainAccuracy = currentMission?.parameters?.terrainFollowAccuracy ?? 2;

      // Apply the mission altitude to the drawn ground-level points
      let terrainAdjustedWaypoints: number[][];
      if (useTerrainFollow) {
        terrainAdjustedWaypoints = await sampleTerrainWithSubPoints(viewer, points, missionAltitude, terrainAccuracy);
      } else {
        terrainAdjustedWaypoints = await sampleTerrainForWaypoints(viewer, points, missionAltitude);
      }

      // The mission type is fixed at creation; drawing only replaces the route.
      updateMission(activeMissionId, {
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
    
    // Remove existing custom imagery layers.
    // Only the `custom-` ones: local GeoTIFF layers are also tagged with
    // _customLayerId (so enforceImageryOrder keeps them on top) but they are
    // owned by the local loader below. Tearing them down here removed the
    // orthophoto from the globe on every unrelated layer change, while the
    // local loader still held the reference and so never re-added it.
    const layersToRemove: ImageryLayer[] = [];
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      const imageryLayer = viewer.imageryLayers.get(i);
      // @ts-ignore - accessing custom property
      const customId: string | undefined = imageryLayer._customLayerId;
      if (customId && customId.startsWith('custom-')) {
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
            // Local DSM wins: it is site-specific and finer than any Ion terrain.
            if (hasLiveLocalTerrain(layers)) {
              console.log(`[LayerLoad] Skipping Ion TERRAIN ${layer.name}: a local DSM owns the terrain`);
              continue;
            }
            const terrainProvider = await CesiumTerrainProvider.fromIonAssetId(assetId, ionLoadOptions);
            if (customLayerLoadRunIdRef.current !== runId) return;
            if (!viewerRef.current || viewerRef.current !== viewer) return;

            // Invalidate any in-flight world-terrain load so it cannot overwrite this.
            terrainApplyRunIdRef.current++;
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
          // raise() only moves one position, which left the overlay buried under the
          // world basemap/labels whenever those finished loading later.
          enforceImageryOrder(viewer);
        }
      }
    };

    applyCustomLayers();

    return () => {
      customLayerLoadRunIdRef.current++;
    };
  }, [layers, cesiumToken, viewerInitVersion, firstLoadLayerRefreshTick]);

  /**
   * Render local GeoTIFF layers — an offline orthophoto as imagery, a local DSM
   * as the terrain. Deliberately independent of the Cesium Ion loader above:
   * it needs no token, and unlike that loader it diffs instead of tearing every
   * layer down. Rebuilding here would re-open and re-decode the TIFF on every
   * opacity slider tick.
   */
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;

    // The previous viewer was destroyed (StrictMode remount): its ImageryLayer
    // objects are gone, so drop the bookkeeping rather than removing them.
    if (localAppliedViewerVersionRef.current !== viewerInitVersion) {
      localImageryLayersRef.current = {};
      localTerrainLayerIdRef.current = null;
      localAppliedViewerVersionRef.current = viewerInitVersion;
    }

    const localLayers = layers.filter((layer) => layer.type === 'local-tiff');
    // Visible AND actually open — after a reload the row exists but the file
    // has to be restored by the user before there is anything to draw.
    const liveById = new Map<string, Layer>();
    localLayers.forEach((layer) => {
      if (layer.visible && getLocalEntry(layer.id)) liveById.set(layer.id, layer);
    });

    // Drop imagery that was hidden, deleted or unloaded.
    Object.entries(localImageryLayersRef.current).forEach(([layerId, imageryLayer]) => {
      const layer = liveById.get(layerId);
      if (!layer || layer.localKind !== 'IMAGERY') {
        viewer.imageryLayers.remove(imageryLayer, true);
        delete localImageryLayersRef.current[layerId];
      }
    });

    let addedImagery = false;
    liveById.forEach((layer, layerId) => {
      if (layer.localKind !== 'IMAGERY') return;
      const alpha = Number.isFinite(layer.opacity) ? layer.opacity : 1;

      const existing = localImageryLayersRef.current[layerId];
      // Trust the collection, not the bookkeeping: if something else dropped
      // the layer, fall through and add it again instead of silently skipping.
      if (existing && viewer.imageryLayers.contains(existing)) {
        existing.alpha = alpha; // opacity in place — no reload
        return;
      }
      if (existing) delete localImageryLayersRef.current[layerId];

      const provider = getLocalEntry(layerId)?.imageryProvider;
      if (!provider) return;

      // Duck-typed provider: Cesium accepts it, its .d.ts asks for the class.
      const imageryLayer = viewer.imageryLayers.addImageryProvider(
        provider as unknown as ImageryProvider
      );
      // @ts-expect-error - marker property read by enforceImageryOrder
      imageryLayer._customLayerId = `local-${layerId}`;
      imageryLayer.alpha = alpha;
      localImageryLayersRef.current[layerId] = imageryLayer;
      addedImagery = true;
      console.log(`Added local imagery layer: ${layer.name}`);
    });

    if (addedImagery) enforceImageryOrder(viewer);

    // Terrain. The world-terrain effect runs earlier in this same commit and
    // already stepped aside for us, so only the apply side is needed here:
    // when the DSM goes away that effect restores world or flat terrain.
    const dsmLayer = localLayers.find(
      (layer) => liveById.has(layer.id) &&
        layer.localKind === 'TERRAIN' &&
        getLocalEntry(layer.id)?.terrainProvider
    );

    if (dsmLayer) {
      const provider = getLocalEntry(dsmLayer.id)!.terrainProvider! as unknown as TerrainProvider;
      if (viewer.terrainProvider !== provider) {
        // Invalidate any in-flight world-terrain load so it cannot overwrite this.
        terrainApplyRunIdRef.current++;
        viewer.terrainProvider = provider;
        localTerrainLayerIdRef.current = dsmLayer.id;
        console.log(`Applied local DSM terrain: ${dsmLayer.name}`);
      }
    } else {
      localTerrainLayerIdRef.current = null;
    }

    // Free the rasters of layers the user removed. This runs last, once the
    // imagery is off the collection and the terrain effect above has already
    // pointed the viewer somewhere else — disposing while Cesium still holds a
    // provider would strand it mid-request.
    const knownIds = new Set(localLayers.map((layer) => layer.id));
    getLocalLayerIds()
      .filter((id) => !knownIds.has(id))
      .forEach((id) => {
        const stale = getLocalEntry(id);
        if (stale?.terrainProvider &&
            viewer.terrainProvider === (stale.terrainProvider as unknown as TerrainProvider)) {
          // Do not bump terrainApplyRunIdRef: a world-terrain load may already
          // be in flight for this same change and should still win.
          viewer.terrainProvider = new EllipsoidTerrainProvider();
        }
        console.log(`Unloaded local layer ${id}`);
        disposeLocalLayer(id);
      });

    viewer.scene.requestRender();
  }, [layers, viewerInitVersion, firstLoadLayerRefreshTick, localRegistryVersion]);

  // Collision analysis: run on request, draw risky stretches in red, clear on request === null
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const removeCollisionEntities = () => {
      const toRemove = viewer.entities.values.filter(
        (entity) => typeof entity.id === 'string' && entity.id.startsWith('collision-risk-')
      );
      toRemove.forEach((entity) => viewer.entities.remove(entity));
    };

    if (!collisionRequest) {
      removeCollisionEntities();
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const mission = useMissionStore.getState().missions.find((m) => m.id === activeMissionId);
        if (!mission || !mission.flightLines || mission.flightLines.length === 0) {
          setCollisionRiskCount(0);
          setCollisionStatus('error');
          return;
        }

        removeCollisionEntities();
        const fallbackAlt = mission.parameters.altitude;
        const lines = mission.flightLines;
        let riskCount = 0;
        let segIndex = 0;
        let maxEffInterval = 0;
        // Skip the first N waypoints across the ordered flight lines (transit leg)
        let remainingSkip = Math.max(0, Math.floor(collisionRequest.skipPoints));

        for (let li = 0; li < lines.length; li++) {
          const coords = (lines[li].coordinates ?? []).filter(
            (c) => Number.isFinite(c[0]) && Number.isFinite(c[1])
          );
          const skipForLine = Math.min(remainingSkip, coords.length);
          remainingSkip -= skipForLine;

          if (coords.length - skipForLine < 2) {
            setCollisionProgress((li + 1) / lines.length);
            continue;
          }

          const result = await analyzeCollisionRisk(
            viewer,
            coords,
            collisionRequest.threshold,
            collisionRequest.interval,
            5000,
            fallbackAlt,
            skipForLine,
            (f) => setCollisionProgress((li + f) / lines.length)
          );
          if (cancelled) return;

          riskCount += result.riskyStationCount;
          maxEffInterval = Math.max(maxEffInterval, result.effIntervalM);
          result.segments.forEach((seg) => {
            const positions = seg.map((p) => Cartesian3.fromDegrees(p[0], p[1], p[2]));
            viewer.entities.add({
              id: `collision-risk-${activeMissionId}-${segIndex++}`,
              name: 'Collision Risk',
              polyline: {
                positions,
                width: 8,
                material: Color.RED,
                clampToGround: false,
                arcType: 0,
              },
            });
          });
        }

        if (cancelled) return;
        setCollisionProgress(1);
        setCollisionEffInterval(maxEffInterval);
        setCollisionRiskCount(riskCount);
        setCollisionStatus('done');
      } catch (error) {
        console.error('Collision analysis failed:', error);
        if (!cancelled) setCollisionStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [collisionRequest, activeMissionId, setCollisionStatus, setCollisionRiskCount, setCollisionProgress, setCollisionEffInterval]);

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
    const terrainSampler = createTerrainSampler(viewer);
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

      // Archived routes are drawn in red so they stand out from live missions
      // when the user un-hides them from the Archived tab.
      const routeColor = mission.archived ? Color.RED : Color.YELLOW;
      const routeMaterial = new ColorMaterialProperty(routeColor);
      const connectorMaterial = new ColorMaterialProperty(routeColor.withAlpha(0.9));

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
            existingLineEntity.polyline.positions = new ConstantProperty(positions);
            // Re-apply on the update path too, so archiving recolours a route
            // that already has an entity instead of leaving it yellow.
            existingLineEntity.polyline.material = routeMaterial;
          } else {
            viewer.entities.add({
              id: lineEntityId,
              name: `Flight Line ${lineIndex + 1}`,
              polyline: {
                positions: positions,
                width: 4,
                material: routeMaterial,
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
              existingConnector.polyline.positions = new ConstantProperty(connectorPositions);
              existingConnector.polyline.material = connectorMaterial;
            } else {
              viewer.entities.add({
                id: connectorEntityId,
                name: `Flight Connector ${drawableIndex + 1}`,
                polyline: {
                  positions: connectorPositions,
                  width: 3,
                  material: connectorMaterial,
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
            const getTerrainHeightAtPoint = () => terrainSampler.get(coord[0], coord[1], pointAltitude);

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
    // terrainReadyVersion rebuilds the height guides once the real terrain is in place.
  }, [
    missions,
    kmlEditMode,
    activeMissionIdForKmlEdit,
    showWaypointHeightGuides,
    showAreaHeightGuides,
    terrainReadyVersion,
  ]);

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
      {cropMenuState && (
        <div className="wp-menu" style={clampMenuToViewport(cropMenuState.x, cropMenuState.y, 236, 260)}>
          {cropMenuState.pointIndex >= 0 && (
            <div className="wp-menu-head">Waypoint #{cropMenuState.pointIndex + 1}</div>
          )}

          {cropMenuState.pointIndex >= 0 && (
            <>
              <button
                type="button"
                className="wp-menu-item"
                onClick={() => {
                  setWaypointQuickEdit({
                    x: cropMenuState.x + 12,
                    y: cropMenuState.y,
                    pointIndex: cropMenuState.pointIndex,
                  });
                  setCropMenuState(null);
                }}
              >
                <span className="wp-menu-icon">✎</span>
                <span className="wp-menu-label">Edit waypoint</span>
                <span className="wp-menu-hint">alt · speed</span>
              </button>
              <button
                type="button"
                className="wp-menu-item"
                onClick={() => {
                  setWaypointActionDialog({ pointIndex: cropMenuState.pointIndex, action: null });
                  setCropMenuState(null);
                }}
              >
                <span className="wp-menu-icon">＋</span>
                <span className="wp-menu-label">Add action</span>
              </button>

              <div className="wp-menu-sep" />

              <button
                type="button"
                className="wp-menu-item"
                onClick={() => {
                  const info = cropCallbackRef.current?.getPointInfo(cropMenuState.pointIndex);
                  if (info) {
                    const panelWidth = 260;
                    const safeX =
                      cropMenuState.x + panelWidth + 12 > window.innerWidth
                        ? cropMenuState.x - panelWidth - 12
                        : cropMenuState.x + 12;
                    const safeY = Math.min(cropMenuState.y, window.innerHeight - 220);
                    setPointInfoState({ x: safeX, y: safeY, ...info });
                  }
                  setCropMenuState(null);
                }}
              >
                <span className="wp-menu-icon">ⓘ</span>
                <span className="wp-menu-label">Info</span>
              </button>
              <button
                type="button"
                className="wp-menu-item"
                onClick={() => {
                  const info = cropCallbackRef.current?.getPointInfo(cropMenuState.pointIndex);
                  if (info) {
                    navigator.clipboard.writeText(`${info.lat.toFixed(7)},${info.lon.toFixed(7)}`);
                  }
                  setCropMenuState(null);
                }}
              >
                <span className="wp-menu-icon">⧉</span>
                <span className="wp-menu-label">Copy coordinates</span>
              </button>
            </>
          )}

          {(cropMenuState.pointIndex > 0 || cropUndoData) && <div className="wp-menu-sep" />}

          {cropMenuState.pointIndex > 0 && (
            <button
              type="button"
              className="wp-menu-item is-danger"
              onClick={() => {
                cropCallbackRef.current?.perform(cropMenuState.pointIndex);
                setCropMenuState(null);
              }}
            >
              <span className="wp-menu-icon">✂</span>
              <span className="wp-menu-label">Crop from here</span>
            </button>
          )}
          {cropUndoData && (
            <button
              type="button"
              className="wp-menu-item"
              onClick={() => {
                cropCallbackRef.current?.undo(cropUndoData);
                setCropUndoData(null);
                setCropMenuState(null);
              }}
            >
              <span className="wp-menu-icon">↩</span>
              <span className="wp-menu-label">Undo crop</span>
            </button>
          )}

          <div className="wp-menu-sep" />
          <button type="button" className="wp-menu-item is-muted" onClick={() => setCropMenuState(null)}>
            <span className="wp-menu-icon">✕</span>
            <span className="wp-menu-label">Cancel</span>
            <span className="wp-menu-hint">Esc</span>
          </button>
        </div>
      )}
      {pointInfoState && (
        <div
          className="point-info-panel"
          style={{ left: `${pointInfoState.x}px`, top: `${pointInfoState.y}px` }}
        >
          <div className="point-info-header">
            <span>Point #{pointInfoState.index + 1}</span>
            <button type="button" onClick={() => setPointInfoState(null)}>✕</button>
          </div>
          <div className="point-info-row">
            <span className="point-info-label">Lat</span>
            <span className="point-info-value">{pointInfoState.lat.toFixed(7)}°</span>
          </div>
          <div className="point-info-row">
            <span className="point-info-label">Lon</span>
            <span className="point-info-value">{pointInfoState.lon.toFixed(7)}°</span>
          </div>
          <div className="point-info-row">
            <span className="point-info-label">Flight Alt</span>
            <span className="point-info-value">{pointInfoState.altitude.toFixed(1)} m</span>
          </div>
          <div className="point-info-row">
            <span className="point-info-label">Terrain</span>
            <span className="point-info-value">{pointInfoState.terrainHeight.toFixed(1)} m</span>
          </div>
          <div className="point-info-row">
            <span className="point-info-label">AGL</span>
            <span className="point-info-value">{pointInfoState.agl.toFixed(1)} m</span>
          </div>
          <div className="point-info-row">
            <span className="point-info-label">DJI Rel. Height</span>
            <span className="point-info-value">{pointInfoState.djiRelativeHeight.toFixed(1)} m</span>
          </div>
        </div>
      )}
      {waypointQuickEdit && activeMissionId && (
        <WaypointQuickEdit
          key={`quick-${waypointQuickEdit.pointIndex}`}
          missionId={activeMissionId}
          pointIndex={waypointQuickEdit.pointIndex}
          x={waypointQuickEdit.x}
          y={waypointQuickEdit.y}
          onClose={() => setWaypointQuickEdit(null)}
          onAddAction={() => {
            setWaypointActionDialog({ pointIndex: waypointQuickEdit.pointIndex, action: null });
            setWaypointQuickEdit(null);
          }}
        />
      )}
      {waypointActionDialog && activeMissionId && (
        <WaypointActionDialog
          key={`action-${waypointActionDialog.pointIndex}-${waypointActionDialog.action?.id ?? 'new'}`}
          missionId={activeMissionId}
          pointIndex={waypointActionDialog.pointIndex}
          action={waypointActionDialog.action}
          onClose={() => setWaypointActionDialog(null)}
        />
      )}
      {cropUndoData && (
        <button
          className="waypoint-undo-crop-btn"
          onClick={() => {
            cropCallbackRef.current?.undo(cropUndoData);
            setCropUndoData(null);
          }}
        >
          ↩ Undo Crop
        </button>
      )}
    </div>
  );
};
