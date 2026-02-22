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
 * Calculate photo interval based on forward overlap and speed.
 * Uses the ALONG-TRACK footprint dimension (footprint.height, mapped from sensorHeight).
 *
 * Camera orientation convention: image top always faces the flight direction.
 * Therefore the short axis (sensorHeight) runs top-to-bottom in the image = ALONG-TRACK.
 *
 * @param groundAlongTrack - Photo footprint along-track dimension in meters (footprint.height)
 * @param forwardOverlap - Desired forward overlap percentage (0-100)
 * @param speed - Flight speed in m/s
 * @returns Photo interval in seconds
 */
export const calculatePhotoInterval = (
  groundAlongTrack: number,
  forwardOverlap: number,
  speed: number
): number => {
  const forwardDistance = groundAlongTrack * (1 - forwardOverlap / 100);
  return forwardDistance / speed;
};

/**
 * Calculate flight line spacing based on side overlap.
 * Uses the CROSS-TRACK footprint dimension (footprint.width, mapped from sensorWidth).
 *
 * Camera orientation convention: image top always faces the flight direction.
 * Therefore the wide/long axis (sensorWidth) runs left-to-right in the image = CROSS-TRACK.
 *
 * @param groundCrossTrack - Photo footprint cross-track dimension in meters (footprint.width)
 * @param sideOverlap - Desired side overlap percentage (0-100)
 * @returns Line spacing in meters
 */
export const calculateLineSpacing = (
  groundCrossTrack: number,
  sideOverlap: number
): number => {
  return groundCrossTrack * (1 - sideOverlap / 100);
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
 * Estimate flight time for a mission using a kinematic model calibrated against
 * three DJI Pilot 2 reference measurements covering different speed/spacing regimes.
 *
 * DJI Pilot 2 shows pure wayline execution time (first waypoint → last waypoint),
 * NOT including takeoff or RTH/landing.
 *
 * Model overview:
 *   ① Effective corner speed — the drone slows at every line end to whichever
 *     constraint is tighter:
 *       a) Speed-dependent DJI coord-turn:  v² / (v + 21)
 *       b) Geometric arc limit:             sqrt(a × spacing / 2)
 *          (drone cannot arc faster than this without overshooting the lane)
 *     Floored at 1.0 m/s.
 *
 *   ② Per-line time — trapezoidal (or triangular) velocity profile between
 *     the effective corner speeds at each end.
 *
 *   ③ Per-turn total time — empirically fitted to all three reference points:
 *       t_turn = max(2, 202.7/v + 3.59·v/spacing − 10.98)
 *     This single formula replaces separate "lateral transit + heading penalty"
 *     terms and absorbs arc time, heading stabilisation, and any DJI internal
 *     overhead. The two driver terms have physical meaning:
 *       • 202.7/v   : heading re-alignment time (inversely ∝ speed)
 *       • 3.59·v/s  : centripetal tightness penalty (fast+tight = very slow turn)
 *
 * Calibration results (all within 2.5 % of DJI Pilot 2):
 *   • 15 m/s, 14 lines, 21.1 m spacing → predicted 452 s,  DJI 452 s   (0 %)
 *   • 5 m/s,  14 lines, 25.3 m spacing → predicted 964 s,  DJI 964 s   (0 %)
 *   • 12 m/s, 61 lines,  5.6 m spacing → predicted ~2057 s, DJI 2064 s (−0.3 %)
 *
 * @param totalDistance  - Total waypoint-path distance in metres
 * @param speed          - Cruise speed in m/s
 * @param numLines       - Number of flight lines
 * @param lineSpacing    - Lateral spacing between lines in metres
 * @param acceleration   - Drone acceleration / deceleration in m/s² (default 2.5)
 * @returns Breakdown in minutes: flightTime, turnTime, totalTime
 */
export const estimateFlightTime = (
  totalDistance: number,
  speed: number,
  numLines: number,
  lineSpacing: number,
  acceleration: number = 2.5
): { flightTime: number; turnTime: number; totalTime: number } => {
  if (speed <= 0 || numLines <= 0) {
    return { flightTime: 0, turnTime: 0, totalTime: 0 };
  }

  const numTurns = Math.max(0, numLines - 1);

  // ── ① Effective corner speed ─────────────────────────────────────────────
  // Lower of: DJI coord-turn formula  OR  geometric arc limit for this lane width.
  // The arc limit prevents the drone from arriving at a turn faster than it
  // can physically complete a 180° arc in the available spacing.
  const speedCorner   = (speed * speed) / (speed + 21);          // DJI coord-turn
  const arcLimit      = Math.sqrt(acceleration * lineSpacing / 2); // geometric max
  const cornerSpeed   = Math.max(1.0, Math.min(speedCorner, arcLimit));

  // ── ② Per-line trapezoidal velocity profile ───────────────────────────────
  const turnTotalDist = numTurns * lineSpacing;
  const lineTotalDist = Math.max(totalDistance - turnTotalDist, totalDistance * 0.5);
  const avgLineLength = lineTotalDist / numLines;

  const deltaV    = Math.max(0, speed - cornerSpeed);
  const accelDist = deltaV > 0
    ? (speed * speed - cornerSpeed * cornerSpeed) / (2 * acceleration)
    : 0;
  const tAccel    = acceleration > 0 ? deltaV / acceleration : 0;

  let singleLineTime: number;
  if (avgLineLength >= 2 * accelDist) {
    const cruiseDist = avgLineLength - 2 * accelDist;
    singleLineTime   = 2 * tAccel + cruiseDist / speed;
  } else {
    const vPeak    = Math.min(speed, Math.sqrt(acceleration * avgLineLength + cornerSpeed * cornerSpeed));
    singleLineTime = vPeak > cornerSpeed
      ? 2 * (vPeak - cornerSpeed) / acceleration
      : avgLineLength / Math.max(cornerSpeed, 0.1);
  }

  const lineTimeSeconds = numLines * singleLineTime;

  // ── ③ Per-turn total time (empirical, fitted to 3 DJI reference points) ───
  // Absorbs: arc traversal, extra decel/accel for tight lanes, heading stabilisation.
  //   driver 1: 202.7 / v        → heading alignment cost (dominates at low speed)
  //   driver 2: 3.59 · v / s     → centripetal penalty  (dominates at tight spacing)
  // Clamped to a minimum of 2 s.
  const turnTimePerTurn = Math.max(2.0, 202.7 / speed + 3.59 * speed / lineSpacing - 10.98);
  const turnTimeSeconds = numTurns * turnTimePerTurn;

  // ── ④ Total ───────────────────────────────────────────────────────────────
  const totalSeconds = lineTimeSeconds + turnTimeSeconds;

  return {
    flightTime: lineTimeSeconds / 60,
    turnTime:   turnTimeSeconds / 60,
    totalTime:  totalSeconds / 60,
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
  // footprint.width  = sensorWidth-derived  = CROSS-TRACK  (wide axis, left-right in image)
  // footprint.height = sensorHeight-derived = ALONG-TRACK  (short axis, top-bottom in image)
  const photoInterval = calculatePhotoInterval(footprint.height, forwardOverlap, speed);
  const lineSpacing = calculateLineSpacing(footprint.width, sideOverlap);
  const blurFactor = calculateBlurFactor(speed, camera.shutterSpeed, gsd);
  const maxSafeSpeed = calculateMaxSpeedForBlur(gsd, camera.shutterSpeed);
  const timeEstimate = estimateFlightTime(totalDistance, speed, numLines, lineSpacing);
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
