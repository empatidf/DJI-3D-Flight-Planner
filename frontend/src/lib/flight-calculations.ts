/**
 * Flight Planning Calculations
 * Photogrammetry flight planning formulas for GSD, overlaps, intervals, etc.
 */

import type { CameraSpec } from './drone-specs';

/**
 * Calculate Ground Sample Distance (GSD) in cm/pixel
 * @param sensorWidth - Camera sensor width in mm
 * @param focalLength - Lens focal length in mm
 * @param altitude - Flight altitude above ground level in meters
 * @param imageWidth - Image width in pixels
 * @returns GSD in cm/pixel
 */
export const calculateGSD = (
  sensorWidth: number,
  focalLength: number,
  altitude: number,
  imageWidth: number
): number => {
  // GSD = (sensor_width × altitude × 100) / (focal_length × image_width)
  return (sensorWidth * altitude * 100) / (focalLength * imageWidth);
};

/**
 * Calculate photo footprint dimensions on the ground
 * @param camera - Camera specifications
 * @param altitude - Flight altitude in meters
 * @returns Object with width and height in meters
 */
export const calculateFootprint = (
  camera: CameraSpec,
  altitude: number
): { width: number; height: number } => {
  const width = (camera.sensorWidth * altitude) / camera.focalLength;
  const height = (camera.sensorHeight * altitude) / camera.focalLength;
  return { width, height };
};

/**
 * Calculate photo interval based on forward overlap and speed
 * @param groundHeight - Photo footprint height in meters
 * @param forwardOverlap - Desired forward overlap percentage (0-100)
 * @param speed - Flight speed in m/s
 * @returns Photo interval in seconds
 */
export const calculatePhotoInterval = (
  groundHeight: number,
  forwardOverlap: number,
  speed: number
): number => {
  // Distance traveled between photos
  const forwardDistance = groundHeight * (1 - forwardOverlap / 100);
  // Time = distance / speed
  return forwardDistance / speed;
};

/**
 * Calculate flight line spacing based on side overlap
 * @param groundWidth - Photo footprint width in meters
 * @param sideOverlap - Desired side overlap percentage (0-100)
 * @returns Line spacing in meters
 */
export const calculateLineSpacing = (
  groundWidth: number,
  sideOverlap: number
): number => {
  return groundWidth * (1 - sideOverlap / 100);
};

/**
 * Calculate blur factor (motion blur in pixels)
 * @param speed - Flight speed in m/s
 * @param shutterSpeed - Camera shutter speed in seconds
 * @param gsd - Ground Sample Distance in cm/pixel
 * @returns Blur factor in pixels (should be < 1)
 */
export const calculateBlurFactor = (
  speed: number,
  shutterSpeed: number,
  gsd: number
): number => {
  // Convert ground speed to cm/s
  const speedCm = speed * 100; // cm/s
  // blur = (speed * shutter_time) / GSD
  return (speedCm * shutterSpeed) / gsd;
};

/**
 * Calculate maximum safe flight speed to avoid blur
 * @param gsd - Ground Sample Distance in cm/pixel
 * @param shutterSpeed - Camera shutter speed in seconds
 * @param maxBlur - Maximum acceptable blur in pixels (default 0.5)
 * @returns Maximum speed in m/s
 */
export const calculateMaxSpeedForBlur = (
  gsd: number,
  shutterSpeed: number,
  maxBlur: number = 0.5
): number => {
  // max_speed = (GSD * maxBlur) / shutter_speed
  // Convert GSD from cm to m and calculate
  return ((gsd / 100) * maxBlur) / shutterSpeed;
};

/**
 * Estimate flight time for a mission
 * @param totalDistance - Total flight distance in meters
 * @param speed - Flight speed in m/s
 * @param numTurns - Number of turns/transitions
 * @param turnTime - Average time per turn in seconds (default 8s)
 * @returns Object with flight time, turn time, and total time in minutes
 */
export const estimateFlightTime = (
  totalDistance: number,
  speed: number,
  numTurns: number,
  turnTime: number = 8
): { flightTime: number; turnTime: number; totalTime: number } => {
  const flightTimeSeconds = totalDistance / speed;
  const turnTimeSeconds = numTurns * turnTime;
  const totalSeconds = flightTimeSeconds + turnTimeSeconds;
  
  return {
    flightTime: flightTimeSeconds / 60,
    turnTime: turnTimeSeconds / 60,
    totalTime: totalSeconds / 60,
  };
};

/**
 * Estimate number of photos for a mission
 * @param totalDistance - Total flight distance in meters
 * @param photoInterval - Photo interval in seconds
 * @param speed - Flight speed in m/s
 * @returns Estimated number of photos
 */
export const estimatePhotoCount = (
  totalDistance: number,
  photoInterval: number,
  speed: number
): number => {
  const flightTimeSeconds = totalDistance / speed;
  return Math.ceil(flightTimeSeconds / photoInterval);
};

/**
 * Calculate storage requirements for a mission
 * @param photoCount - Number of photos
 * @param imageSizeMB - Average image size in MB
 * @returns Storage requirement in GB
 */
export const calculateStorageRequirement = (
  photoCount: number,
  imageSizeMB: number
): number => {
  return (photoCount * imageSizeMB) / 1024;
};

/**
 * Estimate battery usage and number of batteries needed
 * @param totalTime - Total mission time in minutes
 * @param batteryLife - Drone battery life in minutes
 * @param safetyFactor - Safety reserve factor (default 0.75 = 25% reserve)
 * @returns Number of batteries needed
 */
export const estimateBatteryCount = (
  totalTime: number,
  batteryLife: number,
  safetyFactor: number = 0.75
): number => {
  const usableBatteryLife = batteryLife * safetyFactor;
  return Math.ceil(totalTime / usableBatteryLife);
};

/**
 * Calculate area coverage
 * @param lineLength - Average flight line length in meters
 * @param lineSpacing - Spacing between lines in meters
 * @param numLines - Number of flight lines
 * @returns Area in hectares
 */
export const calculateAreaCoverage = (
  lineLength: number,
  lineSpacing: number,
  numLines: number
): number => {
  const areaM2 = lineLength * lineSpacing * numLines;
  return areaM2 / 10000; // Convert to hectares
};

/**
 * Complete flight planning calculation
 * @param camera - Camera specifications
 * @param altitude - Flight altitude in meters AGL
 * @param speed - Flight speed in m/s
 * @param forwardOverlap - Forward overlap percentage
 * @param sideOverlap - Side overlap percentage
 * @param totalDistance - Total mission distance in meters
 * @param numLines - Number of flight lines
 * @returns Complete flight plan calculations
 */
export const calculateFlightPlan = (
  camera: CameraSpec,
  altitude: number,
  speed: number,
  forwardOverlap: number,
  sideOverlap: number,
  totalDistance: number,
  numLines: number
) => {
  const gsd = calculateGSD(camera.sensorWidth, camera.focalLength, altitude, camera.imageWidth);
  const footprint = calculateFootprint(camera, altitude);
  const photoInterval = calculatePhotoInterval(footprint.height, forwardOverlap, speed);
  const lineSpacing = calculateLineSpacing(footprint.width, sideOverlap);
  const blurFactor = calculateBlurFactor(speed, camera.shutterSpeed, gsd);
  const maxSafeSpeed = calculateMaxSpeedForBlur(gsd, camera.shutterSpeed);
  const numTurns = Math.max(0, numLines - 1);
  const timeEstimate = estimateFlightTime(totalDistance, speed, numTurns);
  const photoCount = estimatePhotoCount(totalDistance, photoInterval, speed);
  
  return {
    gsd,
    footprint,
    photoInterval,
    lineSpacing,
    blurFactor,
    maxSafeSpeed,
    timeEstimate,
    photoCount,
    numLines,
    totalDistance,
    hasBlurWarning: blurFactor > 1.0,
    hasSpeedWarning: speed > maxSafeSpeed,
  };
};
