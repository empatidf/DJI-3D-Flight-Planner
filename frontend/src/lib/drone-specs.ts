/**
 * Drone and Camera Specifications Database
 * Contains technical specs for supported DJI drones and payloads
 */

export interface CameraSpec {
  id: string;
  name: string;
  sensorWidth: number; // mm
  sensorHeight: number; // mm
  imageWidth: number; // pixels
  imageHeight: number; // pixels
  focalLength: number; // mm
  pixelPitch: number; // μm
  aperture: string;
  shutterSpeed: number; // seconds (default)
  imageFormat: string[];
}

export interface DroneSpec {
  id: string;
  name: string;
  manufacturer: string;
  cameras: CameraSpec[];
  maxSpeed: number; // m/s
  cruiseSpeed: number; // m/s (recommended)
  maxAltitude: number; // meters AGL
  batteryLife: number; // minutes
  maxWindSpeed: number; // m/s
  weight: number; // kg
  rtk: boolean;
}

// DJI Mavic 3 Enterprise - Wide Camera (4/3 CMOS)
const mavic3eWideCamera: CameraSpec = {
  id: 'mavic3e-wide',
  name: 'Mavic 3E Wide Camera',
  sensorWidth: 17.3,
  sensorHeight: 13.0,
  imageWidth: 5280,
  imageHeight: 3956,
  focalLength: 12.29,
  pixelPitch: 3.3,
  aperture: 'f/2.8-f/11',
  shutterSpeed: 1/2000,
  imageFormat: ['JPEG', 'DNG'],
};

// DJI Mavic 3 Enterprise - Zoom Camera (1/2" CMOS)
const mavic3eZoomCamera: CameraSpec = {
  id: 'mavic3e-zoom',
  name: 'Mavic 3E Zoom Camera',
  sensorWidth: 6.4,
  sensorHeight: 4.8,
  imageWidth: 4000,
  imageHeight: 3000,
  focalLength: 27.2, // at max optical zoom
  pixelPitch: 1.6,
  aperture: 'f/4.4',
  shutterSpeed: 1/2000,
  imageFormat: ['JPEG'],
};

// DJI Zenmuse P1 with 35mm lens
const p1_35mmCamera: CameraSpec = {
  id: 'p1-35mm',
  name: 'DJI P1 35mm Lens',
  sensorWidth: 35.9,
  sensorHeight: 24.0,
  imageWidth: 8192,
  imageHeight: 5460,
  focalLength: 35.0,
  pixelPitch: 4.4,
  aperture: 'f/2.8-f/16',
  shutterSpeed: 1/2000,
  imageFormat: ['JPEG', 'DNG'],
};

// DJI Zenmuse L2 LiDAR (photogrammetry mode with RGB camera)
const l2LidarCamera: CameraSpec = {
  id: 'l2-lidar',
  name: 'DJI L2 LiDAR RGB Camera',
  sensorWidth: 17.3,
  sensorHeight: 13.0,
  imageWidth: 5280,
  imageHeight: 3956,
  focalLength: 12.29,
  pixelPitch: 3.3,
  aperture: 'f/2.8',
  shutterSpeed: 1/2000,
  imageFormat: ['JPEG', 'DNG'],
};

// DJI Mavic 3 Enterprise Drone
export const mavic3eDrone: DroneSpec = {
  id: 'mavic3e',
  name: 'DJI Mavic 3 Enterprise',
  manufacturer: 'DJI',
  cameras: [mavic3eWideCamera, mavic3eZoomCamera],
  maxSpeed: 19, // m/s
  cruiseSpeed: 10, // m/s (recommended for mapping)
  maxAltitude: 500, // meters (software limit, regulatory limits apply)
  batteryLife: 45, // minutes (no payload)
  maxWindSpeed: 12, // m/s
  weight: 0.915, // kg
  rtk: false,
};

// DJI Matrice 300 RTK Drone
export const matrice300Drone: DroneSpec = {
  id: 'm300-rtk',
  name: 'DJI Matrice 300 RTK',
  manufacturer: 'DJI',
  cameras: [p1_35mmCamera, l2LidarCamera],
  maxSpeed: 23, // m/s
  cruiseSpeed: 12, // m/s (recommended for mapping)
  maxAltitude: 500, // meters
  batteryLife: 55, // minutes (no payload)
  maxWindSpeed: 15, // m/s
  weight: 3.77, // kg (without payload)
  rtk: true,
};

// All supported drones
export const DRONES: DroneSpec[] = [mavic3eDrone, matrice300Drone];

// Helper functions
export const getDroneById = (id: string): DroneSpec | undefined => {
  return DRONES.find(drone => drone.id === id);
};

export const getCameraById = (droneId: string, cameraId: string): CameraSpec | undefined => {
  const drone = getDroneById(droneId);
  return drone?.cameras.find(camera => camera.id === cameraId);
};

export const getCamerasForDrone = (droneId: string): CameraSpec[] => {
  const drone = getDroneById(droneId);
  return drone?.cameras || [];
};
