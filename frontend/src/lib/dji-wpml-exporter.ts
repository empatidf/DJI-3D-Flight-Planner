/**
 * DJI WPML Exporter
 * Exports flight plans to DJI Pilot 2 compatible KMZ format
 * Based on DJI WPML 1.0.2 specification
 */

import JSZip from 'jszip';
import type { Mission } from '../stores/mission-store';

const WPML_NAMESPACE = 'http://www.dji.com/wpmz/1.0.0';

interface WaypointData {
  lon: number;
  lat: number;
  alt: number;
}

const parseWpmlFloat = (value: unknown, fallback: number): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
};

const formatWpmlFloat = (value: unknown, fallback: number, maxDecimals = 2): string => {
  const parsed = parseWpmlFloat(value, fallback);
  const fixed = parsed.toFixed(maxDecimals);
  return fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
};

/**
 * Export mission to DJI WPML KMZ format
 */
export const exportToDJI = async (mission: Mission): Promise<Blob> => {
  if (!mission.flightLines || mission.flightLines.length === 0) {
    throw new Error('No flight lines to export');
  }

  const zip = new JSZip();
  
  // Get all waypoints from all flight lines
  const allWaypoints: WaypointData[] = [];
  mission.flightLines.forEach(line => {
    line.coordinates.forEach(coord => {
      const lon = Number(coord[0]);
      const lat = Number(coord[1]);
      const rawAlt = Number(coord[2]);
      const alt = Number.isFinite(rawAlt) ? rawAlt : mission.parameters.altitude;

      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return;
      }

      allWaypoints.push({ lon, lat, alt });
    });
  });

  if (allWaypoints.length === 0) {
    throw new Error('No valid waypoint coordinates to export');
  }

  const firstWaypointAltitude = allWaypoints[0].alt;
  const targetFirstAltitude = Number(mission.parameters.altitude);
  const normalizedFirstAltitude = Number.isFinite(targetFirstAltitude)
    ? targetFirstAltitude
    : firstWaypointAltitude;

  const normalizedWaypoints = allWaypoints.map((waypoint) => ({
    ...waypoint,
    alt: normalizedFirstAltitude + (waypoint.alt - firstWaypointAltitude),
  }));

  // DJI Pilot 2 expects files inside the wpmz folder in KMZ
  const waylinesContent = generateWaylinesWPML(mission, normalizedWaypoints);
  zip.file('wpmz/waylines.wpml', waylinesContent);

  // Create template.kml (for editing)
  const templateContent = generateTemplateKML(mission, normalizedWaypoints);
  zip.file('wpmz/template.kml', templateContent);

  // Generate KMZ file
  const kmzBlob = await zip.generateAsync({ 
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });
  return kmzBlob;
};

/**
 * Generate waylines.wpml content (executable waypoint file)
 */
const generateWaylinesWPML = (mission: Mission, waypoints: WaypointData[]): string => {
  const { parameters, drone, camera } = mission;
  const speedValue = formatWpmlFloat(parameters.speed, 8, 2);
  const droneInfo = resolveDroneInfo(drone.name);
  const payloadInfo = resolvePayloadInfo(camera.name, camera.id, droneInfo.droneEnumValue);

  const droneSubEnumTag =
    droneInfo.droneSubEnumValue !== undefined
      ? `\n      <wpml:droneSubEnumValue>${droneInfo.droneSubEnumValue}</wpml:droneSubEnumValue>`
      : '';
  const payloadSubEnumTag =
    payloadInfo.payloadSubEnumValue !== undefined
      ? `\n      <wpml:payloadSubEnumValue>${payloadInfo.payloadSubEnumValue}</wpml:payloadSubEnumValue>`
      : '';

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${WPML_NAMESPACE}">
<Document>
  <wpml:missionConfig>
    <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
    <wpml:finishAction>goHome</wpml:finishAction>
    <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
    <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
    <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>
    <wpml:globalTransitionalSpeed>${speedValue}</wpml:globalTransitionalSpeed>
    <wpml:droneInfo>
      <wpml:droneEnumValue>${droneInfo.droneEnumValue}</wpml:droneEnumValue>${droneSubEnumTag}
    </wpml:droneInfo>
    <wpml:payloadInfo>
      <wpml:payloadEnumValue>${payloadInfo.payloadEnumValue}</wpml:payloadEnumValue>${payloadSubEnumTag}
      <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
    </wpml:payloadInfo>
  </wpml:missionConfig>
  <Folder>
    <wpml:templateId>0</wpml:templateId>
    <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
    <wpml:waylineId>0</wpml:waylineId>
    <wpml:autoFlightSpeed>${speedValue}</wpml:autoFlightSpeed>
`;

  // Add waypoints
  waypoints.forEach((wp, index) => {
    xml += generateWaypointXML(wp, index, parameters, waypoints.length);
  });

  xml += `  </Folder>
</Document>
</kml>`;

  return xml;
};

/**
 * Generate template.kml content (for user editing)
 */
const generateTemplateKML = (mission: Mission, waypoints: WaypointData[]): string => {
  const { parameters, drone, camera } = mission;
  const speedValue = formatWpmlFloat(parameters.speed, 8, 2);
  const altitudeValue = formatWpmlFloat(parameters.altitude, 100, 2);
  const timestamp = Date.now();

  const droneInfo = resolveDroneInfo(drone.name);
  const payloadInfo = resolvePayloadInfo(camera.name, camera.id, droneInfo.droneEnumValue);

  const droneSubEnumTag =
    droneInfo.droneSubEnumValue !== undefined
      ? `\n      <wpml:droneSubEnumValue>${droneInfo.droneSubEnumValue}</wpml:droneSubEnumValue>`
      : '';
  const payloadSubEnumTag =
    payloadInfo.payloadSubEnumValue !== undefined
      ? `\n      <wpml:payloadSubEnumValue>${payloadInfo.payloadSubEnumValue}</wpml:payloadSubEnumValue>`
      : '';

  const headingMode = parameters.waypointAutoDroneHeading ? 'followWayline' : 'smoothTransition';
  const headingAngle = parameters.waypointAutoDroneHeading ? 0 : (parameters.droneYaw ?? 0);

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${WPML_NAMESPACE}">
<Document>
  <wpml:author>3D Flight Planner</wpml:author>
  <wpml:createTime>${timestamp}</wpml:createTime>
  <wpml:updateTime>${timestamp}</wpml:updateTime>
  <wpml:missionConfig>
    <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
    <wpml:finishAction>goHome</wpml:finishAction>
    <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
    <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
    <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>
    <wpml:globalTransitionalSpeed>${speedValue}</wpml:globalTransitionalSpeed>
    <wpml:droneInfo>
      <wpml:droneEnumValue>${droneInfo.droneEnumValue}</wpml:droneEnumValue>${droneSubEnumTag}
    </wpml:droneInfo>
    <wpml:payloadInfo>
      <wpml:payloadEnumValue>${payloadInfo.payloadEnumValue}</wpml:payloadEnumValue>${payloadSubEnumTag}
      <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
    </wpml:payloadInfo>
  </wpml:missionConfig>

  <Folder>
    <wpml:templateType>waypoint</wpml:templateType>
    <wpml:templateId>0</wpml:templateId>
    <wpml:waylineCoordinateSysParam>
      <wpml:coordinateMode>WGS84</wpml:coordinateMode>
      <wpml:heightMode>relativeToStartPoint</wpml:heightMode>
    </wpml:waylineCoordinateSysParam>
    <wpml:autoFlightSpeed>${speedValue}</wpml:autoFlightSpeed>
    <wpml:globalHeight>${altitudeValue}</wpml:globalHeight>
    <wpml:caliFlightEnable>0</wpml:caliFlightEnable>
    <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
    <wpml:globalWaypointHeadingParam>
      <wpml:waypointHeadingMode>${headingMode}</wpml:waypointHeadingMode>
      <wpml:waypointHeadingAngle>${headingAngle}</wpml:waypointHeadingAngle>
      <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
    </wpml:globalWaypointHeadingParam>
    <wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>
    <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>
    <wpml:payloadParam>
      <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
      <wpml:imageFormat>wide</wpml:imageFormat>
    </wpml:payloadParam>
`;

  // Add waypoints with photo action at each point
  waypoints.forEach((wp, index) => {
    xml += generateTemplateWaypointXML(wp, index, parameters);
  });

  xml += `  </Folder>
</Document>
</kml>`;

  return xml;
};

/**
 * Generate XML for a single waypoint (waylines.wpml)
 */
const generateWaypointXML = (
  waypoint: WaypointData,
  index: number,
  parameters: any,
  totalWaypoints: number
): string => {
  const headingMode = parameters.waypointAutoDroneHeading ? 'followWayline' : 'smoothTransition';
  const headingAngle = parameters.waypointAutoDroneHeading ? 0 : (parameters.droneYaw ?? 0);
  const useAutoGimbalYaw = parameters.waypointAutoGimbalYaw ?? true;
  const speedValue = formatWpmlFloat(parameters.speed, 8, 2);

  const actions: string[] = [];
  let actionId = 0;

  actions.push(`        <wpml:action>
          <wpml:actionId>${actionId++}</wpml:actionId>
          <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>
            <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
            <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
            <wpml:gimbalPitchRotateAngle>${parameters.gimbalPitch}</wpml:gimbalPitchRotateAngle>
            <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
            <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
            <wpml:gimbalYawRotateEnable>${useAutoGimbalYaw ? 0 : 1}</wpml:gimbalYawRotateEnable>
            <wpml:gimbalYawRotateAngle>${useAutoGimbalYaw ? 0 : (parameters.gimbalYaw ?? 0)}</wpml:gimbalYawRotateAngle>
            <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
            <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);

  if (parameters.waypointHoverEnabled) {
    actions.push(`        <wpml:action>
          <wpml:actionId>${actionId++}</wpml:actionId>
          <wpml:actionActuatorFunc>hover</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:hoverTime>${Math.max(1, Number(parameters.waypointHoverTime) || 1)}</wpml:hoverTime>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  if (parameters.waypointRecordVideo && index === 0) {
    actions.push(`        <wpml:action>
          <wpml:actionId>${actionId++}</wpml:actionId>
          <wpml:actionActuatorFunc>startRecord</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:fileSuffix>wp-video-start</wpml:fileSuffix>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  if (parameters.waypointTakePhoto !== false) {
    actions.push(`        <wpml:action>
          <wpml:actionId>${actionId++}</wpml:actionId>
          <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:fileSuffix>point${index}</wpml:fileSuffix>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  if (parameters.waypointRecordVideo && index === totalWaypoints - 1) {
    actions.push(`        <wpml:action>
          <wpml:actionId>${actionId++}</wpml:actionId>
          <wpml:actionActuatorFunc>stopRecord</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  return `    <Placemark>
      <Point>
        <coordinates>${waypoint.lon.toFixed(8)},${waypoint.lat.toFixed(8)}</coordinates>
      </Point>
      <wpml:index>${index}</wpml:index>
      <wpml:executeHeight>${waypoint.alt.toFixed(2)}</wpml:executeHeight>
      <wpml:waypointSpeed>${speedValue}</wpml:waypointSpeed>
      <wpml:waypointHeadingParam>
        <wpml:waypointHeadingMode>${headingMode}</wpml:waypointHeadingMode>
        <wpml:waypointHeadingAngle>${headingAngle}</wpml:waypointHeadingAngle>
        <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
      </wpml:waypointHeadingParam>
      <wpml:waypointTurnParam>
        <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>
        <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
      </wpml:waypointTurnParam>
        <wpml:useGlobalHeight>0</wpml:useGlobalHeight>
      <wpml:useStraightLine>1</wpml:useStraightLine>
      <wpml:actionGroup>
        <wpml:actionGroupId>${index}</wpml:actionGroupId>
        <wpml:actionGroupStartIndex>${index}</wpml:actionGroupStartIndex>
        <wpml:actionGroupEndIndex>${index}</wpml:actionGroupEndIndex>
        <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
        <wpml:actionTrigger>
          <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
        </wpml:actionTrigger>
${actions.join('\n')}
      </wpml:actionGroup>
    </Placemark>
`;
};

/**
 * Generate XML for a single waypoint (template.kml)
 */
const generateTemplateWaypointXML = (
  waypoint: WaypointData,
  index: number,
  parameters: any
): string => {
  return `    <Placemark>
      <Point>
        <coordinates>${waypoint.lon.toFixed(8)},${waypoint.lat.toFixed(8)}</coordinates>
      </Point>
      <wpml:index>${index}</wpml:index>
      <wpml:ellipsoidHeight>${waypoint.alt.toFixed(2)}</wpml:ellipsoidHeight>
      <wpml:height>${waypoint.alt.toFixed(2)}</wpml:height>
      <wpml:useGlobalHeight>0</wpml:useGlobalHeight>
      <wpml:useGlobalSpeed>1</wpml:useGlobalSpeed>
      <wpml:useGlobalHeadingParam>1</wpml:useGlobalHeadingParam>
      <wpml:useGlobalTurnParam>1</wpml:useGlobalTurnParam>
      <wpml:gimbalPitchAngle>${parameters.gimbalPitch}</wpml:gimbalPitchAngle>
      <wpml:gimbalYawAngle>${(parameters.waypointAutoGimbalYaw ?? true) ? 0 : (parameters.gimbalYaw ?? 0)}</wpml:gimbalYawAngle>
    </Placemark>
`;
};

/**
 * Resolve DJI drone enum/sub-enum values from display name
 */
const resolveDroneInfo = (droneName: string): { droneEnumValue: number; droneSubEnumValue?: number } => {
  const normalized = droneName.toLowerCase().replace(/dji\s+/g, '').trim();

  if (normalized.includes('matrice 350')) return { droneEnumValue: 89 };
  if (normalized.includes('matrice 300')) return { droneEnumValue: 60 };

  if (normalized.includes('matrice 30t') || /\bm30t\b/.test(normalized)) {
    return { droneEnumValue: 67, droneSubEnumValue: 1 };
  }
  if (normalized.includes('matrice 30') || /\bm30\b/.test(normalized)) {
    return { droneEnumValue: 67, droneSubEnumValue: 0 };
  }

  if (normalized.includes('matrice 3td') || /\bm3td\b/.test(normalized)) {
    return { droneEnumValue: 91, droneSubEnumValue: 1 };
  }
  if (normalized.includes('matrice 3d') || /\bm3d\b/.test(normalized)) {
    return { droneEnumValue: 91, droneSubEnumValue: 0 };
  }

  if (normalized.includes('mavic 3t') || /\bm3t\b/.test(normalized)) {
    return { droneEnumValue: 77, droneSubEnumValue: 1 };
  }
  if (normalized.includes('mavic 3m') || /\bm3m\b/.test(normalized)) {
    return { droneEnumValue: 77, droneSubEnumValue: 2 };
  }
  if (
    normalized.includes('matrice 4e') ||
    /\bm4e\b/.test(normalized)
  ) {
    return { droneEnumValue: 77, droneSubEnumValue: 0 };
  }

  if (
    normalized.includes('mavic 3e') ||
    normalized.includes('mavic 3 enterprise') ||
    /\bm3e\b/.test(normalized)
  ) {
    return { droneEnumValue: 77, droneSubEnumValue: 0 };
  }

  return { droneEnumValue: 77, droneSubEnumValue: 0 };
};

/**
 * Resolve DJI payload enum/sub-enum values from camera id/name
 */
const resolvePayloadInfo = (
  cameraName: string,
  cameraId?: string,
  droneEnumValue?: number
): { payloadEnumValue: number; payloadSubEnumValue?: number } => {
  const normalizedName = cameraName.toLowerCase().replace(/dji\s+/g, '').trim();
  const normalizedId = (cameraId || '').toLowerCase();

  if (normalizedId.includes('p1') || normalizedName.includes('p1')) {
    return { payloadEnumValue: 50, payloadSubEnumValue: 2 };
  }

  if (normalizedId.includes('sony-ilx-lr1') || normalizedName.includes('sony ilx-lr1')) {
    return { payloadEnumValue: 65534 };
  }

  if (normalizedId.includes('l2') || normalizedName.includes('l2')) {
    return { payloadEnumValue: 50, payloadSubEnumValue: 2 };
  }

  if (normalizedName.includes('h30t')) return { payloadEnumValue: 83 };
  if (normalizedName.includes('h30')) return { payloadEnumValue: 82 };
  if (normalizedName.includes('h20n')) return { payloadEnumValue: 61 };
  if (normalizedName.includes('h20t')) return { payloadEnumValue: 43 };
  if (normalizedName.includes('h20')) return { payloadEnumValue: 42 };

  if (normalizedName.includes('m30t')) return { payloadEnumValue: 53 };
  if (normalizedName.includes('m30')) return { payloadEnumValue: 52 };

  if (normalizedName.includes('m3td') || normalizedName.includes('matrice 3td')) {
    return { payloadEnumValue: 81, payloadSubEnumValue: 0 };
  }
  if (normalizedName.includes('m3d') || normalizedName.includes('matrice 3d')) {
    return { payloadEnumValue: 80, payloadSubEnumValue: 0 };
  }

  if (normalizedName.includes('m3m') || normalizedName.includes('mavic 3m')) {
    return { payloadEnumValue: 68, payloadSubEnumValue: 0 };
  }
  if (normalizedName.includes('m3t') || normalizedName.includes('mavic 3t')) {
    return { payloadEnumValue: 67, payloadSubEnumValue: 0 };
  }
  if (
    normalizedName.includes('m3e') ||
    normalizedName.includes('mavic 3e') ||
    normalizedName.includes('mavic 3 enterprise') ||
    normalizedName.includes('wide camera') ||
    normalizedName.includes('zoom camera')
  ) {
    return { payloadEnumValue: 66, payloadSubEnumValue: 0 };
  }

  if (droneEnumValue === 60 || droneEnumValue === 89) {
    return { payloadEnumValue: 50, payloadSubEnumValue: 2 };
  }

  if (droneEnumValue === 67) {
    return { payloadEnumValue: 52 };
  }

  if (droneEnumValue === 77) {
    return { payloadEnumValue: 66, payloadSubEnumValue: 0 };
  }

  if (droneEnumValue === 91) {
    return { payloadEnumValue: 80, payloadSubEnumValue: 0 };
  }

  return { payloadEnumValue: 66, payloadSubEnumValue: 0 };
};

/**
 * Download KMZ file
 */
export const downloadKMZ = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.kmz`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
