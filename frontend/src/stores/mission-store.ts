/**
 * Mission State Management Store
 * Manages mission data, active mission, and flight planning parameters
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { CameraSpec, DroneSpec } from '../lib/drone-specs';

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
  waypointAutoDroneHeading: boolean;
  waypointAutoGimbalYaw: boolean;
  alwaysTerrainFollow: boolean; // when true, sub-sample terrain between waypoints
  terrainFollowAccuracy: number; // meters — insert sub-waypoint when elevation changes more than this
}

export interface AreaOfInterest {
  type: 'polygon' | 'kml';
  coordinates: number[][]; // [lon, lat, alt][]
  name: string;
}

export interface FlightLine {
  id: string;
  coordinates: number[][]; // waypoints [lon, lat, alt][]
  photoPoints: number[][]; // photo capture points
}

export interface Mission {
  id: string;
  name: string;
  missionType: 'area' | 'waypoint';
  drone: DroneSpec;
  camera: CameraSpec;
  aoi: AreaOfInterest | null;
  parameters: FlightParameters;
  flightLines: FlightLine[];
  layerSnapshot?: Layer[];
  visible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Layer {
  id: string;
  name: string;
  type: 'basemap' | 'terrain' | 'mission' | 'kml' | 'overlay' | 'cesium-ion';
  visible: boolean;
  opacity: number;
  data?: any;
  url?: string; // URL for external imagery/data sources
  cesiumAssetId?: number; // Cesium Ion asset ID
  cesiumAssetType?: 'IMAGERY' | 'TERRAIN' | '3DTILES'; // Cesium Ion asset type
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
  showAreaHeightGuides: boolean;
  showWaypointHeightGuides: boolean;
  layers: Layer[];
  viewMode: 'SCENE2D' | 'SCENE3D' | 'COLUMBUS_VIEW';
  cameraTarget: CameraTarget | null;
  lastMapView: MapViewState | null;
  cesiumToken: string;
  
  // Mission actions
  addMission: (mission: Omit<Mission, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateMission: (id: string, updates: Partial<Mission>) => void;
  deleteMission: (id: string) => void;
  setActiveMission: (id: string | null) => void;
  getActiveMission: () => Mission | null;
  toggleMissionVisibility: (id: string) => void;
  
  // Layer actions
  addLayer: (layer: Omit<Layer, 'id'>) => void;
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
  setShowAreaHeightGuides: (enabled: boolean) => void;
  setShowWaypointHeightGuides: (enabled: boolean) => void;
  setCesiumToken: (token: string) => void;
}

type PersistedMissionState = Pick<
  MissionStore,
  'missions' | 'activeMissionId' | 'layers' | 'viewMode' | 'showAreaHeightGuides' | 'showWaypointHeightGuides' | 'cesiumToken' | 'lastMapView'
>;

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
      layerA.cesiumAssetType === layerB.cesiumAssetType
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
      showAreaHeightGuides: false,
      showWaypointHeightGuides: false,
      layers: defaultLayers,
      cameraTarget: null,
      lastMapView: null,
      viewMode: 'SCENE3D',
      cesiumToken: '',

      // Mission actions
      addMission: (mission) => {
        const id = `mission-${Date.now()}`;
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

      // Layer actions
      addLayer: (layer) => {
        const id = `layer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const newLayer: Layer = { ...layer, id };
        set((state) => ({
          layers: [...state.layers, newLayer],
        }));
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

      setShowAreaHeightGuides: (enabled) => {
        set({ showAreaHeightGuides: enabled });
      },

      setShowWaypointHeightGuides: (enabled) => {
        set({ showWaypointHeightGuides: enabled });
      },

      setCesiumToken: (token) => {
        set({ cesiumToken: token.trim() });
      },
    }),
    {
      name: '3d-planer-mission-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedMissionState => ({
        missions: state.missions,
        activeMissionId: state.activeMissionId,
        layers: state.layers,
        viewMode: state.viewMode,
        showAreaHeightGuides: state.showAreaHeightGuides,
        showWaypointHeightGuides: state.showWaypointHeightGuides,
        cesiumToken: state.cesiumToken,
        lastMapView: state.lastMapView,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<PersistedMissionState>;

        const hydratedMissions = (persisted.missions ?? []).map((mission) => ({
          ...mission,
          createdAt: new Date(mission.createdAt),
          updatedAt: new Date(mission.updatedAt),
        }));

        const activeMissionId = hydratedMissions.some((m) => m.id === persisted.activeMissionId)
          ? persisted.activeMissionId ?? null
          : null;

        return {
          ...currentState,
          missions: hydratedMissions,
          activeMissionId,
          layers: persisted.layers && persisted.layers.length > 0 ? persisted.layers : currentState.layers,
          viewMode: persisted.viewMode ?? currentState.viewMode,
          showAreaHeightGuides: persisted.showAreaHeightGuides ?? currentState.showAreaHeightGuides,
          showWaypointHeightGuides: persisted.showWaypointHeightGuides ?? currentState.showWaypointHeightGuides,
          cesiumToken: persisted.cesiumToken ?? currentState.cesiumToken,
          lastMapView: persisted.lastMapView ?? currentState.lastMapView,
          kmlEditMode: false,
          drawAoiMode: false,
          drawWaypointMode: false,
          cameraTarget: null,
        };
      },
    }
  )
);
