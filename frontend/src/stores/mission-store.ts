/**
 * Mission State Management Store
 * Manages mission data, active mission, and flight planning parameters
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '../lib/safe-json-storage';
import type { CameraSpec, DroneSpec } from '../lib/drone-specs';
import type { WaypointAction } from '../lib/wpml-actions';
import type { BarcodeScanData } from '../lib/barcode-panels';

export interface FlightParameters {
  altitude: number; // meters AGL
  speed: number; // m/s
  forwardOverlap: number; // percentage
  sideOverlap: number; // percentage
  flightAngle: number; // degrees
  gimbalPitch: number; // degrees (-90 = nadir)
  gimbalYaw: number; // degrees
  droneYaw: number; // degrees
  waypointTakePhoto: boolean;
  waypointRecordVideo: boolean;
  waypointHoverEnabled: boolean;
  waypointHoverTime: number; // seconds
  waypointAutoDroneHeading: boolean; // legacy — superseded by globalHeadingMode
  waypointAutoGimbalYaw: boolean;
  /**
   * DJI Pilot 2 → "Aircraft Yaw". Written to globalWaypointHeadingParam.
   * `followWayline` = Along the Route · `manually` = Manual · `smoothTransition` = Custom.
   */
  globalHeadingMode?: 'followWayline' | 'manually' | 'smoothTransition';
  /** DJI Pilot 2 → "Gimbal Control". `manual` = Manual · `usePointSetting` = For Each Waypoint. */
  gimbalPitchMode?: 'manual' | 'usePointSetting';
  waypointTurnDistance: number; // meters — damping distance for coordinate turns
  alwaysTerrainFollow: boolean; // when true, sub-sample terrain between waypoints
  terrainFollowAccuracy: number; // meters — insert sub-waypoint when elevation changes more than this
  terrainFollowMinDist: number; // meters — minimum horizontal distance between consecutive sub-waypoints
  terrainFollowSkipPoints?: number; // leading waypoints (transit leg) left untouched by terrain follow
  elevationToleranceEnabled: boolean; // area-only: when true, skip redundant points on flat terrain
  elevationTolerance: number; // meters — keep a point only if terrain elevation differs this much from the last kept point
  /** Height climbed to after takeoff before heading to the first waypoint (wpml:takeOffSecurityHeight). */
  safeTakeoffAltitude?: number; // meters, DJI range 1.2–1500
  /** What the aircraft does after the last waypoint (wpml:finishAction). */
  finishAction?: FinishAction;
}

export type FinishAction = 'goHome' | 'noAction' | 'autoLand' | 'gotoFirstWaypoint';

export interface AreaOfInterest {
  type: 'polygon' | 'kml';
  coordinates: number[][]; // [lon, lat, alt][]
  name: string;
}

/**
 * Per-waypoint settings that override the mission-wide FlightParameters.
 * Every field is optional — an undefined field means "use the global value".
 */
export interface WaypointOverride {
  speed?: number; // m/s — emitted as wpml:waypointSpeed
  droneYaw?: number; // degrees — emitted in wpml:waypointHeadingParam
  gimbalPitch?: number; // degrees — applied to the per-point gimbalRotate action
  gimbalYaw?: number; // degrees
  turnDistance?: number; // meters — wpml:waypointTurnDampingDist
  actions?: WaypointAction[]; // extra WPML actions executed at this waypoint
  /** false = suppress the mission-wide actions here and run only `actions`. */
  useGlobalActions?: boolean;
  note?: string;
}

/**
 * What a waypoint is for. Barcode Scan routes mark every point, so an app
 * reading the exported KMZ can tell a barcode from a pure flying point.
 */
export type WaypointKind = 'barcode' | 'transit';

export interface FlightLine {
  id: string;
  coordinates: number[][]; // waypoints [lon, lat, alt][]
  photoPoints: number[][]; // photo capture points
  /** Kind of every waypoint, same order as `coordinates`; Barcode Scan routes only. */
  pointKinds?: WaypointKind[];
  originalCoordinates?: number[][]; // pre-terrain-follow snapshot, used to revert
  /**
   * Per-waypoint overrides keyed by `waypointKey(lon, lat)` rather than by index,
   * so they survive operations that insert or drop points (terrain follow,
   * decimation, crop) as long as the point itself is kept.
   */
  waypointOverrides?: Record<string, WaypointOverride>;
}

/**
 * A mission saved without a valid type (older versions) is shown as an area
 * mission everywhere, so it gets that type when loaded. Without it the DJI
 * export treated such a mission as neither area nor waypoint route and wrote
 * the waypoint-route default, a Manual aircraft yaw.
 */
export const withMissionType = <T extends Mission>(mission: T): T =>
  mission.missionType === 'area' || mission.missionType === 'waypoint' || mission.missionType === 'barcode'
    ? mission
    : { ...mission, missionType: 'area' };

/** Stable key for a waypoint override. ~1 cm resolution. */
export const waypointKey = (lon: number, lat: number): string =>
  `${Number(lon).toFixed(7)},${Number(lat).toFixed(7)}`;

export interface Mission {
  id: string;
  name: string;
  missionType: 'area' | 'waypoint' | 'barcode';
  drone: DroneSpec;
  camera: CameraSpec;
  aoi: AreaOfInterest | null;
  takeoffPoint: number[] | null; // [lon, lat, alt] — first waypoint of area mission
  parameters: FlightParameters;
  flightLines: FlightLine[];
  layerSnapshot?: Layer[];
  visible: boolean;
  /** Marked as already flown — shown in red in the mission list. */
  flown?: boolean;
  /** Moved to the Archived tab: read-only and hidden on the map by default. */
  archived?: boolean;
  /** Barcode Scan missions only: the solar park's panel layout and how it is drawn. */
  barcode?: BarcodeScanData;
  createdAt: Date;
  updatedAt: Date;
}

export interface Layer {
  id: string;
  name: string;
  type: 'basemap' | 'terrain' | 'mission' | 'kml' | 'overlay' | 'cesium-ion' | 'local-tiff';
  visible: boolean;
  opacity: number;
  data?: any;
  url?: string; // URL for external imagery/data sources
  cesiumAssetId?: number; // Cesium Ion asset ID
  cesiumAssetType?: 'IMAGERY' | 'TERRAIN' | '3DTILES'; // Cesium Ion asset type

  // Local GeoTIFF layers (type === 'local-tiff'). Descriptors only — the open
  // File, the CogSource and the decoded raster live in lib/local-tiff/registry,
  // because this array is JSON-serialised into localStorage.
  localKind?: 'IMAGERY' | 'TERRAIN';
  localFileName?: string;
  /** key of the File System Access handle kept in IndexedDB, if any */
  localHandleKey?: string;
  localBounds?: { west: number; south: number; east: number; north: number };
}

/**
 * The setup the user last chose, carried into the next new mission.
 *
 * Kept separately from the missions themselves because the drone and camera
 * pickers only live in the Flight Planning panel's local state until the user
 * presses "Save Parameters" — reading the previous mission would hand back a
 * stale drone. Terrain follow is deliberately absent: a new mission always
 * starts with it off.
 */
export interface MissionDefaults {
  droneId?: string;
  cameraId?: string;
  altitude?: number;
  speed?: number;
}

export interface CameraTarget {
  longitude: number;
  latitude: number;
  altitude?: number;
  heading?: number;
  pitch?: number;
  roll?: number;
}

export interface MapViewState {
  longitude: number;
  latitude: number;
  altitude: number;
  heading: number;
  pitch: number;
  roll: number;
}

interface MissionStore {
  missions: Mission[];
  activeMissionId: string | null;
  kmlEditMode: boolean;
  drawAoiMode: boolean;
  drawWaypointMode: boolean;
  addTakeoffPointMode: boolean;
  showAreaHeightGuides: boolean;
  showWaypointHeightGuides: boolean;
  // Waypoint selection (transient — not persisted). Index into flightLines[0].coordinates.
  selectedWaypointIndex: number | null;
  // Collision analysis (transient — not persisted)
  collisionRequest: { threshold: number; interval: number; skipPoints: number; nonce: number } | null;
  collisionStatus: 'idle' | 'running' | 'done' | 'error';
  collisionRiskCount: number;
  collisionProgress: number; // 0..1
  collisionEffInterval: number; // actual along-line spacing used (m)
  layers: Layer[];
  viewMode: 'SCENE2D' | 'SCENE3D' | 'COLUMBUS_VIEW';
  cameraTarget: CameraTarget | null;
  lastMapView: MapViewState | null;
  cesiumToken: string;
  missionDefaults: MissionDefaults;
  /**
   * Missions used to be persisted here, in localStorage. They now live in the
   * project folder with an IndexedDB copy (lib/project-folder). Until that copy
   * is verified this stays false and localStorage keeps holding the missions.
   */
  missionsMigrated: boolean;
  /** Barcode Scan mission whose installation-direction line is drawn on the map (transient). */
  installationLineMissionId: string | null;
  /** Barcode Scan mission whose tables are being picked on the map (transient). */
  tableSelectMissionId: string | null;

  // Mission actions
  addMission: (mission: Omit<Mission, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateMission: (id: string, updates: Partial<Mission>) => void;
  deleteMission: (id: string) => void;
  setActiveMission: (id: string | null) => void;
  getActiveMission: () => Mission | null;
  toggleMissionVisibility: (id: string) => void;
  setMissionsVisibility: (ids: string[], visible: boolean) => void;
  toggleMissionFlown: (id: string) => void;
  setMissionArchived: (id: string, archived: boolean) => void;
  setMissionLayerSnapshot: (id: string, layers: Layer[]) => void;
  markMissionsMigrated: () => void;
  setInstallationLineMissionId: (id: string | null) => void;
  setTableSelectMissionId: (id: string | null) => void;

  // Per-waypoint actions (operate on flightLines[0] of the given mission)
  setSelectedWaypointIndex: (index: number | null) => void;
  getWaypointOverride: (missionId: string, pointIndex: number) => WaypointOverride | null;
  setWaypointOverride: (missionId: string, pointIndex: number, patch: Partial<WaypointOverride>) => void;
  clearWaypointOverride: (missionId: string, pointIndex: number) => void;
  setWaypointAltitude: (missionId: string, pointIndex: number, altitude: number) => void;
  addWaypointAction: (missionId: string, pointIndex: number, action: WaypointAction) => void;
  updateWaypointAction: (missionId: string, pointIndex: number, action: WaypointAction) => void;
  deleteWaypointAction: (missionId: string, pointIndex: number, actionId: string) => void;
  moveWaypointAction: (missionId: string, pointIndex: number, actionId: string, direction: -1 | 1) => void;

  // Layer actions
  /** returns the generated layer id, so callers can key side data to it */
  addLayer: (layer: Omit<Layer, 'id'>) => string;
  setLayers: (layers: Layer[]) => void;
  updateLayer: (id: string, updates: Partial<Layer>) => void;
  deleteLayer: (id: string) => void;
  toggleLayerVisibility: (id: string) => void;
  
  // View actions
  setViewMode: (mode: 'SCENE2D' | 'SCENE3D' | 'COLUMBUS_VIEW') => void;
  setCameraTarget: (target: CameraTarget | null) => void;
  setLastMapView: (view: MapViewState | null) => void;
  setKmlEditMode: (enabled: boolean) => void;
  setDrawAoiMode: (enabled: boolean) => void;
  setDrawWaypointMode: (enabled: boolean) => void;
  setAddTakeoffPointMode: (enabled: boolean) => void;
  requestCollisionAnalysis: (threshold: number, interval: number, skipPoints: number) => void;
  clearCollisionAnalysis: () => void;
  setCollisionStatus: (status: 'idle' | 'running' | 'done' | 'error') => void;
  setCollisionRiskCount: (count: number) => void;
  setCollisionProgress: (progress: number) => void;
  setCollisionEffInterval: (interval: number) => void;
  setShowAreaHeightGuides: (enabled: boolean) => void;
  setShowWaypointHeightGuides: (enabled: boolean) => void;
  setCesiumToken: (token: string) => void;
  setMissionDefaults: (patch: MissionDefaults) => void;
}

type PersistedMissionState = Pick<
  MissionStore,
  'activeMissionId' | 'layers' | 'viewMode' | 'showAreaHeightGuides' | 'showWaypointHeightGuides' | 'cesiumToken' | 'lastMapView' | 'missionDefaults' | 'missionsMigrated'
> & {
  /** Only present in storage written before missions moved out (see missionsMigrated). */
  missions?: Mission[];
};

export const MISSION_STORE_KEY = '3d-planer-mission-store';

/** Random suffix: two missions created in the same millisecond must not share an id. */
export const createMissionId = () => `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Parameters for a brand-new mission. Aircraft height and speed carry over from
 * the last mission; terrain follow deliberately starts off every time.
 */
export const buildNewMissionParameters = (defaults: MissionDefaults, drone: DroneSpec): FlightParameters => ({
  altitude: defaults.altitude ?? 100,
  speed: Math.min(defaults.speed ?? 8, drone.cruiseSpeed),
  forwardOverlap: 80,
  sideOverlap: 70,
  flightAngle: 0,
  gimbalPitch: -90,
  gimbalYaw: 0,
  droneYaw: 0,
  waypointTakePhoto: false,
  waypointRecordVideo: false,
  waypointHoverEnabled: false,
  waypointHoverTime: 2,
  waypointAutoDroneHeading: false,
  globalHeadingMode: 'manually',
  gimbalPitchMode: 'manual',
  waypointAutoGimbalYaw: false,
  waypointTurnDistance: 0.2,
  alwaysTerrainFollow: false,
  terrainFollowAccuracy: 2,
  terrainFollowMinDist: 5,
  terrainFollowSkipPoints: 1,
  elevationToleranceEnabled: false,
  elevationTolerance: 1,
  safeTakeoffAltitude: 20,
  finishAction: 'goHome',
});

const defaultLayers: Layer[] = [
  {
    id: 'basemap',
    name: 'Base Map',
    type: 'basemap',
    visible: true,
    opacity: 1.0,
  },
  {
    id: 'terrain',
    name: 'Terrain',
    type: 'terrain',
    visible: false,
    opacity: 1.0,
  },
];

const areLayersEquivalent = (a: Layer[], b: Layer[]) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  return a.every((layerA, index) => {
    const layerB = b[index];
    if (!layerB) return false;

    return (
      layerA.id === layerB.id &&
      layerA.name === layerB.name &&
      layerA.type === layerB.type &&
      layerA.visible === layerB.visible &&
      layerA.opacity === layerB.opacity &&
      layerA.url === layerB.url &&
      layerA.cesiumAssetId === layerB.cesiumAssetId &&
      layerA.cesiumAssetType === layerB.cesiumAssetType &&
      // localBounds is fixed when the layer is created, so it cannot diverge
      // while the id and the handle key still match.
      layerA.localKind === layerB.localKind &&
      layerA.localFileName === layerB.localFileName &&
      layerA.localHandleKey === layerB.localHandleKey
    );
  });
};

export const useMissionStore = create<MissionStore>()(
  persist(
    (set, get) => ({
      missions: [],
      activeMissionId: null,
      kmlEditMode: false,
      drawAoiMode: false,
      drawWaypointMode: false,
      addTakeoffPointMode: false,
      showAreaHeightGuides: false,
      showWaypointHeightGuides: false,
      selectedWaypointIndex: null,
      collisionRequest: null,
      collisionStatus: 'idle',
      collisionRiskCount: 0,
      collisionProgress: 0,
      collisionEffInterval: 0,
      layers: defaultLayers,
      cameraTarget: null,
      lastMapView: null,
      viewMode: 'SCENE3D',
      cesiumToken: '',
      missionDefaults: {},
      missionsMigrated: false,
      installationLineMissionId: null,
      tableSelectMissionId: null,

      // Mission actions
      addMission: (mission) => {
        const id = createMissionId();
        const newMission: Mission = {
          ...mission,
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        set((state) => ({
          missions: [...state.missions, newMission],
          activeMissionId: id,
        }));

        return id;
      },

      updateMission: (id, updates) => {
        set((state) => ({
          missions: state.missions.map((m) =>
            m.id === id ? { ...m, ...updates, updatedAt: new Date() } : m
          ),
        }));
      },

      deleteMission: (id) => {
        set((state) => ({
          missions: state.missions.filter((m) => m.id !== id),
          activeMissionId: state.activeMissionId === id ? null : state.activeMissionId,
        }));
      },

      setActiveMission: (id) => {
        set({ activeMissionId: id });
      },

      getActiveMission: () => {
        const { missions, activeMissionId } = get();
        return missions.find((m) => m.id === activeMissionId) || null;
      },

      toggleMissionVisibility: (id) => {
        set((state) => ({
          missions: state.missions.map((m) =>
            m.id === id ? { ...m, visible: !m.visible } : m
          ),
        }));
      },

      /** Bulk show/hide, used by the "Show all" / "Hide all" buttons per tab. */
      setMissionsVisibility: (ids, visible) => {
        const target = new Set(ids);
        set((state) => ({
          missions: state.missions.map((m) => (target.has(m.id) ? { ...m, visible } : m)),
        }));
      },

      toggleMissionFlown: (id) => {
        set((state) => ({
          missions: state.missions.map((m) =>
            m.id === id ? { ...m, flown: !m.flown, updatedAt: new Date() } : m
          ),
        }));
      },

      /**
       * Archiving hides the mission on the map and drops it as the active mission,
       * so the Flight Planning panel can never edit an archived route. Restoring
       * puts it back in the working set and makes it visible again.
       */
      setMissionArchived: (id, archived) => {
        set((state) => ({
          missions: state.missions.map((m) =>
            m.id === id ? { ...m, archived, visible: !archived, updatedAt: new Date() } : m
          ),
          activeMissionId:
            archived && state.activeMissionId === id ? null : state.activeMissionId,
        }));
      },

      /**
       * Remember the map layers with a mission. Not an edit of the route, so
       * updatedAt stays put — folder sync trusts it to pick the newer copy.
       */
      setMissionLayerSnapshot: (id, layers) => {
        set((state) => ({
          missions: state.missions.map((m) => (m.id === id ? { ...m, layerSnapshot: layers } : m)),
        }));
      },

      markMissionsMigrated: () => {
        set({ missionsMigrated: true });
      },

      setInstallationLineMissionId: (id) => {
        set((state) => (state.installationLineMissionId === id ? state : { installationLineMissionId: id }));
      },

      setTableSelectMissionId: (id) => {
        set((state) => (state.tableSelectMissionId === id ? state : { tableSelectMissionId: id }));
      },

      // Per-waypoint overrides -------------------------------------------------
      setSelectedWaypointIndex: (index) => {
        set((state) => (state.selectedWaypointIndex === index ? state : { selectedWaypointIndex: index }));
      },

      getWaypointOverride: (missionId, pointIndex) => {
        const line = get().missions.find((m) => m.id === missionId)?.flightLines?.[0];
        const coord = line?.coordinates?.[pointIndex];
        if (!line || !coord) return null;
        return line.waypointOverrides?.[waypointKey(coord[0], coord[1])] ?? null;
      },

      setWaypointOverride: (missionId, pointIndex, patch) => {
        set((state) => ({
          missions: state.missions.map((mission) => {
            if (mission.id !== missionId) return mission;

            const line = mission.flightLines?.[0];
            const coord = line?.coordinates?.[pointIndex];
            if (!line || !coord) return mission;

            const key = waypointKey(coord[0], coord[1]);
            const merged: WaypointOverride = { ...(line.waypointOverrides?.[key] ?? {}), ...patch };

            // Drop keys explicitly reset to undefined so "use global" really means global.
            (Object.keys(patch) as (keyof WaypointOverride)[]).forEach((field) => {
              if (patch[field] === undefined) delete merged[field];
            });

            const overrides = { ...(line.waypointOverrides ?? {}) };
            if (Object.keys(merged).length === 0) {
              delete overrides[key];
            } else {
              overrides[key] = merged;
            }

            return {
              ...mission,
              flightLines: [{ ...line, waypointOverrides: overrides }, ...mission.flightLines.slice(1)],
              updatedAt: new Date(),
            };
          }),
        }));
      },

      clearWaypointOverride: (missionId, pointIndex) => {
        set((state) => ({
          missions: state.missions.map((mission) => {
            if (mission.id !== missionId) return mission;

            const line = mission.flightLines?.[0];
            const coord = line?.coordinates?.[pointIndex];
            if (!line || !coord || !line.waypointOverrides) return mission;

            const overrides = { ...line.waypointOverrides };
            delete overrides[waypointKey(coord[0], coord[1])];

            return {
              ...mission,
              flightLines: [{ ...line, waypointOverrides: overrides }, ...mission.flightLines.slice(1)],
              updatedAt: new Date(),
            };
          }),
        }));
      },

      setWaypointAltitude: (missionId, pointIndex, altitude) => {
        if (!Number.isFinite(altitude)) return;

        set((state) => ({
          missions: state.missions.map((mission) => {
            if (mission.id !== missionId) return mission;

            const line = mission.flightLines?.[0];
            if (!line?.coordinates?.[pointIndex]) return mission;

            const coordinates = line.coordinates.map((coord, index) =>
              index === pointIndex ? [coord[0], coord[1], altitude] : coord
            );

            return {
              ...mission,
              flightLines: [{ ...line, coordinates }, ...mission.flightLines.slice(1)],
              updatedAt: new Date(),
            };
          }),
        }));
      },

      addWaypointAction: (missionId, pointIndex, action) => {
        const existing = get().getWaypointOverride(missionId, pointIndex);
        get().setWaypointOverride(missionId, pointIndex, {
          actions: [...(existing?.actions ?? []), action],
        });
      },

      updateWaypointAction: (missionId, pointIndex, action) => {
        const existing = get().getWaypointOverride(missionId, pointIndex);
        if (!existing?.actions) return;
        get().setWaypointOverride(missionId, pointIndex, {
          actions: existing.actions.map((item) => (item.id === action.id ? action : item)),
        });
      },

      deleteWaypointAction: (missionId, pointIndex, actionId) => {
        const existing = get().getWaypointOverride(missionId, pointIndex);
        if (!existing?.actions) return;
        const actions = existing.actions.filter((item) => item.id !== actionId);
        get().setWaypointOverride(missionId, pointIndex, { actions: actions.length ? actions : undefined });
      },

      moveWaypointAction: (missionId, pointIndex, actionId, direction) => {
        const existing = get().getWaypointOverride(missionId, pointIndex);
        if (!existing?.actions) return;

        const actions = [...existing.actions];
        const from = actions.findIndex((item) => item.id === actionId);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= actions.length) return;

        [actions[from], actions[to]] = [actions[to], actions[from]];
        get().setWaypointOverride(missionId, pointIndex, { actions });
      },

      // Layer actions
      addLayer: (layer) => {
        const id = `layer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const newLayer: Layer = { ...layer, id };
        set((state) => ({
          layers: [...state.layers, newLayer],
        }));
        return id;
      },

      setLayers: (layers) => {
        set((state) => {
          const nextLayers = layers.length > 0 ? layers : defaultLayers;
          if (areLayersEquivalent(state.layers, nextLayers)) {
            return state;
          }
          return { layers: nextLayers };
        });
      },

      updateLayer: (id, updates) => {
        set((state) => ({
          layers: state.layers.map((l) => (l.id === id ? { ...l, ...updates } : l)),
        }));
      },

      deleteLayer: (id) => {
        set((state) => ({
          layers: state.layers.filter((l) => l.id !== id),
        }));
      },

      toggleLayerVisibility: (id) => {
        set((state) => ({
          layers: state.layers.map((l) =>
            l.id === id ? { ...l, visible: !l.visible } : l
          ),
        }));
      },

      // View actions
      setViewMode: (mode) => {
        set({ viewMode: mode });
      },

      setCameraTarget: (target) => {
        set({ cameraTarget: target });
      },

      setLastMapView: (view) => {
        set({ lastMapView: view });
      },

      setKmlEditMode: (enabled) => {
        set({ kmlEditMode: enabled });
      },

      setDrawAoiMode: (enabled) => {
        set({ drawAoiMode: enabled });
      },

      setDrawWaypointMode: (enabled) => {
        set({ drawWaypointMode: enabled });
      },

      setAddTakeoffPointMode: (enabled) => {
        set({ addTakeoffPointMode: enabled });
      },

      requestCollisionAnalysis: (threshold, interval, skipPoints) => {
        set((state) => ({
          collisionRequest: {
            threshold,
            interval,
            skipPoints,
            nonce: (state.collisionRequest?.nonce ?? 0) + 1,
          },
          collisionStatus: 'running',
          collisionRiskCount: 0,
          collisionProgress: 0,
        }));
      },

      clearCollisionAnalysis: () => {
        set({ collisionRequest: null, collisionStatus: 'idle', collisionRiskCount: 0, collisionProgress: 0, collisionEffInterval: 0 });
      },

      setCollisionStatus: (status) => {
        set({ collisionStatus: status });
      },

      setCollisionRiskCount: (count) => {
        set({ collisionRiskCount: count });
      },

      setCollisionProgress: (progress) => {
        set({ collisionProgress: progress });
      },

      setCollisionEffInterval: (interval) => {
        set({ collisionEffInterval: interval });
      },

      setShowAreaHeightGuides: (enabled) => {
        set({ showAreaHeightGuides: enabled });
      },

      setShowWaypointHeightGuides: (enabled) => {
        set({ showWaypointHeightGuides: enabled });
      },

      setCesiumToken: (token) => {
        set({ cesiumToken: token.trim() });
      },

      setMissionDefaults: (patch) => {
        set((state) => ({ missionDefaults: { ...state.missionDefaults, ...patch } }));
      },
    }),
    {
      name: MISSION_STORE_KEY,
      storage: createSafeJSONStorage<PersistedMissionState>(MISSION_STORE_KEY),
      partialize: (state): PersistedMissionState => ({
        // Keep writing missions here until folder sync has copied them over.
        // Barcode Scan layouts run to megabytes, more than localStorage holds:
        // they only ever live in the browser cache and the project folder.
        ...(state.missionsMigrated
          ? {}
          : { missions: state.missions.filter((mission) => mission.missionType !== 'barcode') }),
        missionsMigrated: state.missionsMigrated,
        activeMissionId: state.activeMissionId,
        layers: state.layers,
        viewMode: state.viewMode,
        showAreaHeightGuides: state.showAreaHeightGuides,
        showWaypointHeightGuides: state.showWaypointHeightGuides,
        cesiumToken: state.cesiumToken,
        lastMapView: state.lastMapView,
        missionDefaults: state.missionDefaults,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<PersistedMissionState>;

        const hydratedMissions = (persisted.missions ?? []).map((mission) =>
          withMissionType({
            ...mission,
            createdAt: new Date(mission.createdAt),
            updatedAt: new Date(mission.updatedAt),
          })
        );

        const missionsMigrated = persisted.missionsMigrated ?? false;
        // After the move the missions arrive later from IndexedDB, and folder
        // sync drops an active id that turns out not to exist.
        const activeMissionId =
          missionsMigrated || hydratedMissions.some((m) => m.id === persisted.activeMissionId)
            ? persisted.activeMissionId ?? null
            : null;

        return {
          ...currentState,
          missions: hydratedMissions,
          missionsMigrated,
          activeMissionId,
          layers: persisted.layers && persisted.layers.length > 0 ? persisted.layers : currentState.layers,
          viewMode: persisted.viewMode ?? currentState.viewMode,
          showAreaHeightGuides: persisted.showAreaHeightGuides ?? currentState.showAreaHeightGuides,
          showWaypointHeightGuides: persisted.showWaypointHeightGuides ?? currentState.showWaypointHeightGuides,
          cesiumToken: persisted.cesiumToken ?? currentState.cesiumToken,
          lastMapView: persisted.lastMapView ?? currentState.lastMapView,
          missionDefaults: persisted.missionDefaults ?? currentState.missionDefaults,
          kmlEditMode: false,
          drawAoiMode: false,
          drawWaypointMode: false,
          selectedWaypointIndex: null,
          cameraTarget: null,
        };
      },
    }
  )
);
