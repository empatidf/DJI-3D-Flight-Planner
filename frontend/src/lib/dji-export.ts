/**
 * DJI Waypoint Export
 * Exports flight missions to DJI Pilot 2 compatible WPML format
 * WPML: Waypoint Mission Language (KML extension used by DJI)
 */

import type { FlightPlan } from './flight-path-generator';
import type { Mission } from '../stores/mission-store';
import JSZip from 'jszip';

interface WPMLOptions {
  droneModel: string;
  takeoffAlt: number;
  finishAction: 'goHome' | 'hover' | 'land';
  gimbalPitch: number; // degrees (-90 = nadir)
  photoInterval: number; // seconds
  speed: number; // m/s
}

/**
 * Generate WPML (Waypoint Mission Language) content
 * DJI's KML-based format for Pilot 2
 */
export const generateWPML = (
  flightPlan: FlightPlan,
  options: WPMLOptions
): string => {
  const { takeoffAlt, finishAction, gimbalPitch, speed } = options;
  
  // Build waypoint placemark elements
  const waypointElements: string[] = [];
  let waypointIndex = 0;
  
  flightPlan.lines.forEach((line, lineIndex) => {
    line.waypoints.forEach((waypoint, wpIndex) => {
      const isPhotoPoint = waypoint.action === 'photo';
      
      waypointElements.push(`
    <Placemark>
      <name>WP${waypointIndex}</name>
      <description>Line ${lineIndex + 1}, Point ${wpIndex + 1}</description>
      <Point>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>${waypoint.lon},${waypoint.lat},${waypoint.alt}</coordinates>
      </Point>
      <wpml:index>${waypointIndex}</wpml:index>
      <wpml:executeHeight>${waypoint.alt.toFixed(2)}</wpml:executeHeight>
      <wpml:waypointSpeed>${speed.toFixed(1)}</wpml:waypointSpeed>
      <wpml:waypointHeadingParam>
        <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
      </wpml:waypointHeadingParam>
      <wpml:gimbalPitchAngle>${gimbalPitch}</wpml:gimbalPitchAngle>
      ${isPhotoPoint ? `
      <wpml:actionGroup>
        <wpml:action>
          <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>
      </wpml:actionGroup>` : ''}
    </Placemark>`);
      
      waypointIndex++;
    });
  });
  
  const wpml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"
     xmlns:wpml="http://www.dji.com/wpmz/1.0.0">
  <Document>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>${finishAction}</wpml:finishAction>
      <wpml:exitOnRCLost>goContinue</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>hover</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>${takeoffAlt}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${speed}</wpml:globalTransitionalSpeed>
    </wpml:missionConfig>
    
    <wpml:folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:autoFlightSpeed>${speed}</wpml:autoFlightSpeed>
      <wpml:gimbalPitchMode>manual</wpml:gimbalPitchMode>
      
      ${waypointElements.join('\n')}
    </wpml:folder>
  </Document>
</kml>`;
  
  return wpml;
};

/**
 * Export mission to DJI KMZ file (standard KML for visualization)
 */
export const exportToKMZ = async (
  mission: Mission,
  flightPlan: FlightPlan
): Promise<Blob> => {
  const wpml = generateWPML(flightPlan, {
    droneModel: mission.drone.id,
    takeoffAlt: mission.parameters.altitude,
    finishAction: 'goHome',
    gimbalPitch: mission.parameters.gimbalPitch,
    photoInterval: 0, // Calculated based on flight plan
    speed: mission.parameters.speed,
  });
  
  // Create KMZ (zipped KML)
  const zip = new JSZip();
  zip.file('wpmz/template.kml', wpml);
  zip.file('wpmz/waylines.wpml', wpml);
  
  // Add metadata
  const metadata = {
    name: mission.name,
    created: mission.createdAt.toISOString(),
    drone: mission.drone.name,
    camera: mission.camera.name,
    parameters: mission.parameters,
    stats: {
      waypoints: flightPlan.numWaypoints,
      photos: flightPlan.numPhotos,
      distance: flightPlan.totalDistance,
    },
  };
  
  zip.file('metadata.json', JSON.stringify(metadata, null, 2));
  
  const blob = await zip.generateAsync({ type: 'blob' });
  return blob;
};

/**
 * Export mission to standard KML (for visualization in other tools)
 */
export const exportToKML = (mission: Mission, flightPlan: FlightPlan): string => {
  const waypointPlacemarks = flightPlan.lines
    .flatMap((line) => line.waypoints)
    .map(
      (wp, index) => `
    <Placemark>
      <name>Waypoint ${index + 1}</name>
      <Point>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>${wp.lon},${wp.lat},${wp.alt}</coordinates>
      </Point>
      <Style>
        <IconStyle>
          <Icon>
            <href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>
          </Icon>
        </IconStyle>
      </Style>
    </Placemark>`
    )
    .join('\n');
  
  const linePlacemarks = flightPlan.lines
    .map(
      (line, index) => `
    <Placemark>
      <name>Flight Line ${index + 1}</name>
      <LineString>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>
          ${line.waypoints.map((wp) => `${wp.lon},${wp.lat},${wp.alt}`).join('\n          ')}
        </coordinates>
      </LineString>
      <Style>
        <LineStyle>
          <color>ff0000ff</color>
          <width>3</width>
        </LineStyle>
      </Style>
    </Placemark>`
    )
    .join('\n');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${mission.name}</name>
    <description>
      Drone: ${mission.drone.name}
      Camera: ${mission.camera.name}
      Altitude: ${mission.parameters.altitude}m
      Speed: ${mission.parameters.speed}m/s
      Overlaps: ${mission.parameters.forwardOverlap}% / ${mission.parameters.sideOverlap}%
    </description>
    
    ${waypointPlacemarks}
    ${linePlacemarks}
  </Document>
</kml>`;
};

/**
 * Download file helper
 */
export const downloadFile = (content: Blob | string, filename: string): void => {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type: 'application/xml' });
  
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Export mission with options
 */
export const exportMission = async (
  mission: Mission,
  flightPlan: FlightPlan,
  format: 'wpml' | 'kml' | 'kmz' = 'kmz'
): Promise<void> => {
  const baseName = mission.name.replace(/[^a-z0-9]/gi, '_');
  
  switch (format) {
    case 'kmz':
    case 'wpml': {
      const blob = await exportToKMZ(mission, flightPlan);
      downloadFile(blob, `${baseName}.kmz`);
      break;
    }
    
    case 'kml': {
      const kml = exportToKML(mission, flightPlan);
      downloadFile(kml, `${baseName}.kml`);
      break;
    }
    
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
};
