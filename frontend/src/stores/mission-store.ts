/**
 * Mission State Management Store
 * Manages mission data, active mission, and flight planning parameters
 */

import { create } from 'zustand';
import type { CameraSpec, DroneSpec } from '../lib/drone-specs';

export interface FlightParameters {
  altitude: number; // meters AGL
  speed: number; // m/s
  forwardOverlap: number; // percentage
  sideOverlap: number; // percentage
  flightAngle: number; // degrees
  gimbalPitch: number; // degrees (-90 = nadir)
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
  drone: DroneSpec;
  camera: CameraSpec;
  aoi: AreaOfInterest | null;
  parameters: FlightParameters;
  flightLines: FlightLine[];
  visible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Layer {
  id: string;
  name: string;
  type: 'basemap' | 'terrain' | 'mission' | 'kml' | 'overlay' | 'rgb' | 'dsm';
  visible: boolean;
  opacity: number;
  data?: any;
  url?: string; // URL for external imagery/data sources
  imageUrl?: string; // Data URL for RGB/DSM image data
  geoTiffInfo?: {
    bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number };
    epsg: string;
    fileName: string;
    minZoom?: number;
    maxZoom?: number;
  };
}

export interface CameraTarget {
  longitude: number;
  latitude: number;
  altitude?: number;
  heading?: number;
  pitch?: number;
  roll?: number;
}

interface MissionStore {
  missions: Mission[];
  activeMissionId: string | null;
  layers: Layer[];
  viewMode: 'SCENE2D' | 'SCENE3D' | 'COLUMBUS_VIEW';
  cameraTarget: CameraTarget | null;
  
  // Mission actions
  addMission: (mission: Omit<Mission, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateMission: (id: string, updates: Partial<Mission>) => void;
  deleteMission: (id: string) => void;
  setActiveMission: (id: string | null) => void;
  getActiveMission: () => Mission | null;
  toggleMissionVisibility: (id: string) => void;
  
  // Layer actions
  addLayer: (layer: Omit<Layer, 'id'>) => void;
  updateLayer: (id: string, updates: Partial<Layer>) => void;
  deleteLayer: (id: string) => void;
  deleteLayerWithTiles: (id: string) => Promise<void>;
  toggleLayerVisibility: (id: string) => void;
  
  // View actions
  setViewMode: (mode: 'SCENE2D' | 'SCENE3D' | 'COLUMBUS_VIEW') => void;
  setCameraTarget: (target: CameraTarget | null) => void;
}

export const useMissionStore = create<MissionStore>((set, get) => ({
  missions: [],
  activeMissionId: null,
  layers: [
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
  ],
  cameraTarget: null,
  viewMode: 'SCENE3D',

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
    console.log('updateMission called:', { id, updates });
    set((state) => {
      const updatedMissions = state.missions.map((m) =>
        m.id === id ? { ...m, ...updates, updatedAt: new Date() } : m
      );
      console.log('Updated missions:', updatedMissions);
      return {
        missions: updatedMissions,
      };
    });
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

  deleteLayerWithTiles: async (id) => {
    // Delete from store
    set((state) => ({
      layers: state.layers.filter((l) => l.id !== id),
    }));
    
    // Delete tile directory
    try {
      await fetch(`/api/tile/${id}`, {
        method: 'DELETE',
      });
    } catch (error) {
      console.error('Failed to delete tiles:', error);
    }
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
}));
