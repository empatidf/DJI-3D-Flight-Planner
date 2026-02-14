/**
 * DJI WPML Exporter
 * Exports flight plans to DJI Pilot 2 compatible KMZ format
 * Based on DJI WPML 1.0.2 specification
 */

import JSZip from 'jszip';
import type { Mission } from '../stores/mission-store';

interface WaypointData {
  lon: number;
  lat: number;
  alt: number;
}

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
      allWaypoints.push({
        lon: coord[0],
        lat: coord[1],
        alt: coord[2]
      });
    });
  });

  // Create waylines.wpml (executable file) - at root level
  const waylinesContent = generateWaylinesWPML(mission, allWaypoints);
  zip.file('waylines.wpml', waylinesContent);

  // Create template.kml (for editing) - at root level
  const templateContent = generateTemplateKML(mission, allWaypoints);
  zip.file('template.kml', templateContent);

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
  
  // Get drone enum values (default to M30 if not found)
  const droneEnumValue = getDroneEnumValue(drone.name);
  const droneSubEnumValue = getDroneSubEnumValue(drone.name);
  const payloadEnumValue = getPayloadEnumValue(camera.name);

  // Use first waypoint as takeoff reference
  const takeoffPoint = waypoints[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
<Document>
  <wpml:missionConfig>
    <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
    <wpml:finishAction>goHome</wpml:finishAction>
    <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
    <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
    <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>
    <wpml:takeOffRefPoint>${takeoffPoint.lat.toFixed(8)},${takeoffPoint.lon.toFixed(8)},${takeoffPoint.alt.toFixed(2)}</wpml:takeOffRefPoint>
    <wpml:takeOffRefPointAGLHeight>${parameters.altitude}</wpml:takeOffRefPointAGLHeight>
    <wpml:globalTransitionalSpeed>${parameters.speed}</wpml:globalTransitionalSpeed>
    <wpml:globalRTHHeight>100</wpml:globalRTHHeight>
    <wpml:droneInfo>
      <wpml:droneEnumValue>${droneEnumValue}</wpml:droneEnumValue>
      <wpml:droneSubEnumValue>${droneSubEnumValue}</wpml:droneSubEnumValue>
    </wpml:droneInfo>
    <wpml:payloadInfo>
      <wpml:payloadEnumValue>${payloadEnumValue}</wpml:payloadEnumValue>
      <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
    </wpml:payloadInfo>
  </wpml:missionConfig>
  <Folder>
    <wpml:templateId>0</wpml:templateId>
    <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
    <wpml:waylineId>0</wpml:waylineId>
    <wpml:autoFlightSpeed>${parameters.speed}</wpml:autoFlightSpeed>
`;

  // Add waypoints
  waypoints.forEach((wp, index) => {
    xml += generateWaypointXML(wp, index, parameters);
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
  const timestamp = Date.now();
  
  const droneEnumValue = getDroneEnumValue(drone.name);
  const droneSubEnumValue = getDroneSubEnumValue(drone.name);
  const payloadEnumValue = getPayloadEnumValue(camera.name);

  // Use first waypoint as takeoff reference
  const takeoffPoint = waypoints[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
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
    <wpml:takeOffRefPoint>${takeoffPoint.lat.toFixed(8)},${takeoffPoint.lon.toFixed(8)},${takeoffPoint.alt.toFixed(2)}</wpml:takeOffRefPoint>
    <wpml:takeOffRefPointAGLHeight>${parameters.altitude}</wpml:takeOffRefPointAGLHeight>
    <wpml:globalTransitionalSpeed>${parameters.speed}</wpml:globalTransitionalSpeed>
    <wpml:droneInfo>
      <wpml:droneEnumValue>${droneEnumValue}</wpml:droneEnumValue>
      <wpml:droneSubEnumValue>${droneSubEnumValue}</wpml:droneSubEnumValue>
    </wpml:droneInfo>
    <wpml:payloadInfo>
      <wpml:payloadEnumValue>${payloadEnumValue}</wpml:payloadEnumValue>
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
    <wpml:autoFlightSpeed>${parameters.speed}</wpml:autoFlightSpeed>
    <wpml:globalHeight>${parameters.altitude}</wpml:globalHeight>
    <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
    <wpml:globalWaypointHeadingParam>
      <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
    </wpml:globalWaypointHeadingParam>
    <wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>
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
  parameters: any
): string => {
  return `    <Placemark>
      <Point>
        <coordinates>${waypoint.lon.toFixed(8)},${waypoint.lat.toFixed(8)}</coordinates>
      </Point>
      <wpml:index>${index}</wpml:index>
      <wpml:executeHeight>${waypoint.alt.toFixed(2)}</wpml:executeHeight>
      <wpml:waypointSpeed>${parameters.speed}</wpml:waypointSpeed>
      <wpml:waypointHeadingParam>
        <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
      </wpml:waypointHeadingParam>
      <wpml:waypointTurnParam>
        <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>
        <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
      </wpml:waypointTurnParam>
      <wpml:actionGroup>
        <wpml:actionGroupId>${index}</wpml:actionGroupId>
        <wpml:actionGroupStartIndex>${index}</wpml:actionGroupStartIndex>
        <wpml:actionGroupEndIndex>${index}</wpml:actionGroupEndIndex>
        <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
        <wpml:actionTrigger>
          <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
        </wpml:actionTrigger>
        <wpml:action>
          <wpml:actionId>0</wpml:actionId>
          <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:gimbalHeadingYawBase>north</wpml:gimbalHeadingYawBase>
            <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
            <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
            <wpml:gimbalPitchRotateAngle>${parameters.gimbalPitch}</wpml:gimbalPitchRotateAngle>
            <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
            <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
            <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
            <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
            <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
            <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>
        <wpml:action>
          <wpml:actionId>1</wpml:actionId>
          <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:fileSuffix>point${index}</wpml:fileSuffix>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            <wpml:payloadLensIndex>wide</wpml:payloadLensIndex>
            <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>
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
    </Placemark>
`;
};

/**
 * Get DJI drone enum value
 */
const getDroneEnumValue = (droneName: string): number => {
  const droneMap: { [key: string]: number } = {
    'mavic 3 enterprise': 77,
    'mavic 3e': 77,
    'mavic 3t': 77,
    'mavic 3m': 77,
    'matrice 30': 67,
    'matrice 30t': 67,
    'matrice 300 rtk': 60,
    'matrice 350 rtk': 89,
    'matrice 3d': 91,
    'matrice 3td': 91,
  };
  
  const normalizedName = droneName.toLowerCase();
  return droneMap[normalizedName] || 67; // Default to M30
};

/**
 * Get DJI drone sub enum value based on specific model variant
 */
const getDroneSubEnumValue = (droneName: string): number => {
  const normalizedName = droneName.toLowerCase();
  
  // M30/M30T variants (droneEnumValue 67)
  if (normalizedName.includes('m30t') || normalizedName.includes('matrice 30t')) return 1;
  if (normalizedName.includes('m30') || normalizedName.includes('matrice 30')) return 0;
  
  // M3E/M3T/M3M variants (droneEnumValue 77)
  if (normalizedName.includes('m3t') || normalizedName.includes('mavic 3t')) return 1;
  if (normalizedName.includes('m3m') || normalizedName.includes('mavic 3m')) return 2;
  if (normalizedName.includes('m3e') || normalizedName.includes('mavic 3e') || normalizedName.includes('mavic 3 enterprise')) return 0;
  
  // M3D/M3TD variants (droneEnumValue 91)
  if (normalizedName.includes('m3td') || normalizedName.includes('matrice 3td')) return 1;
  if (normalizedName.includes('m3d') || normalizedName.includes('matrice 3d')) return 0;
  
  return 0; // Default to base model
};

/**
 * Get DJI payload enum value
 */
const getPayloadEnumValue = (cameraName: string): number => {
  const cameraMap: { [key: string]: number } = {
    'l2': 50277,
    'h20': 42,
    'h20t': 43,
    'h20n': 61,
    'h30': 82,
    'h30t': 83,
    'm30': 52,
    'm30t': 53,
    'm3e': 66,  // Mavic 3E Camera
    'mavic3e': 66,
    'm3t': 67,  // Mavic 3T Camera
    'mavic3t': 67,
    'm3m': 68,  // Mavic 3M Camera
    'mavic3m': 68,
    'm3d': 80,  // Matrice 3D Camera
    'matrice3d': 80,
    'm3td': 81,  // Matrice 3TD Camera
    'matrice3td': 81,
  };
  
  const normalizedName = cameraName.toLowerCase().replace(/\s+/g, '');
  return cameraMap[normalizedName] || 52; // Default to M30 camera
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
