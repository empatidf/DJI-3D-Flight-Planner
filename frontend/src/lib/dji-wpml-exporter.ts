/**
 * DJI WPML Exporter
 * Exports flight plans to DJI Pilot 2 compatible KMZ format
 * Based on DJI WPML 1.0.2 specification
 */

import JSZip from 'jszip';
import type { FlightParameters, Mission, WaypointKind, WaypointOverride } from '../stores/mission-store';
import { waypointKey } from '../stores/mission-store';
import { DEFAULT_SCAN_HOVER_SECONDS, DEFAULT_SCAN_SPEED_MPS } from './barcode-panels';
import {
  buildActionXml,
  getActionDef,
  getTriggerParam,
  getTriggerSpan,
  isIntervalAction,
} from './wpml-actions';

// DJI Pilot 2 (M3E/M3T firmware 2024+) writes 1.0.6; matching it keeps the
// route editable with the same UI options the app configured.
const WPML_NAMESPACE = 'http://www.dji.com/wpmz/1.0.6';

/** Placeholder POI written by DJI Pilot 2 whenever heading mode is not "towardPOI". */
const EMPTY_POI = '0.000000,0.000000,0.000000';

interface WaypointData {
  lon: number;
  lat: number;
  alt: number;
  /** Per-waypoint settings that win over the mission-wide FlightParameters. */
  override?: WaypointOverride;
  /** Barcode Scan routes only: what the point is for. */
  kind?: WaypointKind;
  /** Lens a photo must be taken with, for payloads that have more than one. */
  photoLens?: string;
}

/**
 * What the point is for, as plain KML so DJI Pilot 2 keeps it and ignores it,
 * while our own tools can tell a barcode from a point that is only flown.
 */
const buildPointTypeXml = (kind: WaypointKind | undefined): string =>
  kind
    ? `
      <ExtendedData>
        <Data name="pointType">
          <value>${kind}</value>
        </Data>
      </ExtendedData>`
    : '';

/** Mutable counter so every action group in the KMZ gets a unique id. */
interface GroupIdCounter {
  next: number;
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
 * Wrap a yaw/heading angle into DJI Pilot 2's accepted range of [-180, 180].
 * DJI treats 0 as center, so e.g. 270 must be sent as -90. Values outside this
 * range are rejected by DJI Pilot 2 and will not upload to the aircraft.
 */
export const normalizeYaw = (value: unknown, fallback = 0): number => {
  const parsed = parseWpmlFloat(value, fallback);
  // Rounded to 0.01°: the modulo leaves float noise such as 96.79999999999995.
  const wrapped = Math.round((((parsed + 180) % 360 + 360) % 360 - 180) * 100) / 100;
  // Map the -180 boundary to +180 to match DJI's convention and avoid -0.
  return wrapped === -180 ? 180 : wrapped;
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
    line.coordinates.forEach((coord, pointIndex) => {
      const lon = Number(coord[0]);
      const lat = Number(coord[1]);
      const rawAlt = Number(coord[2]);
      const alt = Number.isFinite(rawAlt) ? rawAlt : mission.parameters.altitude;

      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return;
      }

      allWaypoints.push({
        lon,
        lat,
        alt,
        override: line.waypointOverrides?.[waypointKey(lon, lat)],
        kind: line.pointKinds?.[pointIndex],
      });
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

  // Barcode Scan routes hold absolute altitudes; their heights are measured
  // from the ground altitude stored with the takeoff point.
  const isBarcode = mission.missionType === 'barcode';
  const takeoffGround = isBarcode ? Number(mission.takeoffPoint?.[2]) : Number.NaN;
  if (isBarcode && !Number.isFinite(takeoffGround)) {
    throw new Error('Set the takeoff point first: route heights are measured from it.');
  }

  // A barcode is read from the wide camera, but only a payload that has
  // several lenses (M4E, M3E, M3T) understands a lens index at all; a
  // single-lens payload such as the Zenmuse P1 must keep the global setting.
  const photoLens =
    isBarcode && /\b(wide|zoom|tele|thermal)\b/.test(mission.camera.name.toLowerCase()) ? 'wide' : undefined;

  const normalizedWaypoints = allWaypoints.map((waypoint) => ({
    ...waypoint,
    alt: Number.isFinite(takeoffGround)
      ? waypoint.alt - takeoffGround
      : normalizedFirstAltitude + (waypoint.alt - firstWaypointAltitude),
    photoLens,
  }));

  // A barcode scan flies at its own speed, with Aircraft Yaw on Manual at the
  // heading of the panel rows, and takes its waypoint actions from the scan
  // settings. Those actions run on the barcode points only (see kind).
  const scan = mission.barcode?.scan;
  const exportMission: Mission = isBarcode
    ? {
        ...mission,
        parameters: {
          ...mission.parameters,
          speed: scan?.flightSpeedMps ?? DEFAULT_SCAN_SPEED_MPS,
          globalHeadingMode: 'manually',
          droneYaw: scan?.droneYawDeg ?? mission.barcode?.structure?.installationBearing ?? mission.parameters.droneYaw,
          waypointHoverEnabled: scan?.hoverEnabled === true,
          waypointHoverTime: scan?.hoverSeconds ?? DEFAULT_SCAN_HOVER_SECONDS,
          waypointTakePhoto: scan?.takePhotoEnabled === true,
          waypointRecordVideo: false,
        },
      }
    : mission;

  // DJI Pilot 2 expects files inside the wpmz folder in KMZ
  const waylinesContent = generateWaylinesWPML(exportMission, normalizedWaypoints);
  zip.file('wpmz/waylines.wpml', waylinesContent);

  // Create template.kml (for editing)
  const templateContent = generateTemplateKML(exportMission, normalizedWaypoints);
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
  const finishAction = parameters.finishAction ?? 'goHome';
  const takeOffSecurityHeight = formatWpmlFloat(
    Math.min(1500, Math.max(1.2, parseWpmlFloat(parameters.safeTakeoffAltitude, 20))),
    20,
    1
  );
  const speedValue = formatWpmlFloat(parameters.speed, 8, 2);
  // globalTransitionalSpeed: speed flying TO first waypoint. DJI valid range [1, 15] m/s.
  const transitionalSpeed = formatWpmlFloat(Math.min(15, Math.max(1, parseWpmlFloat(parameters.speed, 8))), 8, 2);
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
    <wpml:finishAction>${finishAction}</wpml:finishAction>
    <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
    <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
    <wpml:takeOffSecurityHeight>${takeOffSecurityHeight}</wpml:takeOffSecurityHeight>
    <wpml:globalTransitionalSpeed>${transitionalSpeed}</wpml:globalTransitionalSpeed>
    <wpml:droneInfo>
      <wpml:droneEnumValue>${droneInfo.droneEnumValue}</wpml:droneEnumValue>${droneSubEnumTag}
    </wpml:droneInfo>
    <wpml:waylineAvoidLimitAreaMode>0</wpml:waylineAvoidLimitAreaMode>
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

  // Add waypoints. Action group ids must be unique across the whole file.
  const groupIds: GroupIdCounter = { next: 0 };
  waypoints.forEach((wp, index) => {
    xml += generateWaypointXML(wp, index, parameters, waypoints.length, groupIds);
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
  const finishAction = parameters.finishAction ?? 'goHome';
  const takeOffSecurityHeight = formatWpmlFloat(
    Math.min(1500, Math.max(1.2, parseWpmlFloat(parameters.safeTakeoffAltitude, 20))),
    20,
    1
  );
  const speedValue = formatWpmlFloat(parameters.speed, 8, 2);
  // globalTransitionalSpeed: speed flying TO first waypoint. DJI valid range [1, 15] m/s.
  const transitionalSpeed = formatWpmlFloat(Math.min(15, Math.max(1, parseWpmlFloat(parameters.speed, 8))), 8, 2);
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

  // "Aircraft Yaw" in DJI Pilot 2. A per-waypoint yaw cannot be honoured while the
  // route follows the wayline, so any override forces the route to Manual.
  const hasManualYawOverride = waypoints.some((waypoint) => waypoint.override?.droneYaw !== undefined);
  const configuredHeadingMode = resolveGlobalHeadingMode(parameters);
  const headingMode =
    hasManualYawOverride && configuredHeadingMode === 'followWayline' ? 'manually' : configuredHeadingMode;
  const headingAngle = headingMode === 'smoothTransition' ? normalizeYaw(parameters.droneYaw) : 0;
  const gimbalPitchMode = resolveGimbalPitchMode(parameters);

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${WPML_NAMESPACE}">
<Document>
  <wpml:createTime>${timestamp}</wpml:createTime>
  <wpml:updateTime>${timestamp}</wpml:updateTime>
  <wpml:missionConfig>
    <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
    <wpml:finishAction>${finishAction}</wpml:finishAction>
    <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
    <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
    <wpml:takeOffSecurityHeight>${takeOffSecurityHeight}</wpml:takeOffSecurityHeight>
    <wpml:globalTransitionalSpeed>${transitionalSpeed}</wpml:globalTransitionalSpeed>
    <wpml:droneInfo>
      <wpml:droneEnumValue>${droneInfo.droneEnumValue}</wpml:droneEnumValue>${droneSubEnumTag}
    </wpml:droneInfo>
    <wpml:waylineAvoidLimitAreaMode>0</wpml:waylineAvoidLimitAreaMode>
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
      <wpml:positioningType>GPS</wpml:positioningType>
    </wpml:waylineCoordinateSysParam>
    <wpml:autoFlightSpeed>${speedValue}</wpml:autoFlightSpeed>
    <wpml:globalHeight>${altitudeValue}</wpml:globalHeight>
    <wpml:caliFlightEnable>0</wpml:caliFlightEnable>
    <wpml:gimbalPitchMode>${gimbalPitchMode}</wpml:gimbalPitchMode>
    <wpml:globalWaypointHeadingParam>
      <wpml:waypointHeadingMode>${headingMode}</wpml:waypointHeadingMode>
      <wpml:waypointHeadingAngle>${headingAngle}</wpml:waypointHeadingAngle>
      <wpml:waypointPoiPoint>${EMPTY_POI}</wpml:waypointPoiPoint>
      <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
      <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
    </wpml:globalWaypointHeadingParam>
    <wpml:globalWaypointTurnMode>coordinateTurn</wpml:globalWaypointTurnMode>
    <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>
`;

  // Add waypoints with their action groups
  const groupIds: GroupIdCounter = { next: 0 };
  waypoints.forEach((wp, index) => {
    xml += generateTemplateWaypointXML(wp, index, parameters, waypoints.length, groupIds);
  });

  // Pilot 2 writes payloadParam after the placemarks.
  xml += `    <wpml:payloadParam>
      <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
      <wpml:imageFormat>wide</wpml:imageFormat>
    </wpml:payloadParam>
`;

  xml += `  </Folder>
</Document>
</kml>`;

  return xml;
};

/**
 * Route-level "Aircraft Yaw" setting shown by DJI Pilot 2.
 * Falls back to the legacy boolean for missions saved before the mode existed.
 */
export const resolveGlobalHeadingMode = (
  parameters: FlightParameters
): 'followWayline' | 'manually' | 'smoothTransition' =>
  parameters.globalHeadingMode ?? (parameters.waypointAutoDroneHeading ? 'followWayline' : 'manually');

/** Route-level "Gimbal Control" setting shown by DJI Pilot 2. */
export const resolveGimbalPitchMode = (parameters: FlightParameters): 'manual' | 'usePointSetting' =>
  parameters.gimbalPitchMode ?? 'manual';

/**
 * Resolve the aircraft heading for one waypoint.
 *
 * A per-waypoint droneYaw always wins. Otherwise only "Along the Route" is
 * carried down verbatim — for Manual/Custom routes DJI still expects each point
 * to declare `smoothTransition` plus its target angle, which is exactly what
 * Pilot 2 itself writes.
 */
const resolveWaypointHeading = (
  parameters: FlightParameters,
  override?: WaypointOverride
): { headingMode: string; headingAngle: number } => {
  if (override?.droneYaw !== undefined) {
    return { headingMode: 'smoothTransition', headingAngle: normalizeYaw(override.droneYaw) };
  }

  return resolveGlobalHeadingMode(parameters) === 'followWayline'
    ? { headingMode: 'followWayline', headingAngle: 0 }
    : { headingMode: 'smoothTransition', headingAngle: normalizeYaw(parameters.droneYaw) };
};

/**
 * Effective gimbal attitude at one waypoint, per-point value winning over the mission value.
 *
 * `controlled` says whether the route should command the gimbal at all. With
 * Gimbal Control = Manual the operator flies the gimbal, so the route must stay
 * out of the way — no gimbalRotate action, no commanded angles — unless this
 * particular waypoint carries an explicit gimbal override.
 */
const resolveWaypointGimbal = (
  parameters: FlightParameters,
  override?: WaypointOverride
): { controlled: boolean; pitch: number; yaw: number; yawEnabled: boolean } => {
  const hasPointOverride = override?.gimbalPitch !== undefined || override?.gimbalYaw !== undefined;
  const controlled = resolveGimbalPitchMode(parameters) === 'usePointSetting' || hasPointOverride;

  if (!controlled) {
    return { controlled: false, pitch: 0, yaw: 0, yawEnabled: false };
  }

  const pitch = override?.gimbalPitch ?? parameters.gimbalPitch;
  const explicitYaw = override?.gimbalYaw;
  const yawEnabled = explicitYaw !== undefined || !(parameters.waypointAutoGimbalYaw ?? false);

  return {
    controlled: true,
    pitch: parseWpmlFloat(pitch, -90),
    yaw: yawEnabled ? normalizeYaw(explicitYaw ?? parameters.gimbalYaw) : 0,
    yawEnabled,
  };
};

/**
 * Mission-wide actions (gimbal / hover / record / photo) for one waypoint,
 * with any per-waypoint gimbal override applied.
 */
const buildGlobalActionXml = (
  waypoint: WaypointData,
  index: number,
  parameters: FlightParameters,
  totalWaypoints: number,
  startActionId: number
): { xml: string[]; nextActionId: number } => {
  const override = waypoint.override;
  const gimbal = resolveWaypointGimbal(parameters, override);

  const xml: string[] = [];
  let actionId = startActionId;

  // Only command the gimbal when the route is meant to (Gimbal Control =
  // "For Each Waypoint", or this waypoint has its own angle). Under Manual the
  // aircraft keeps whatever attitude the operator sets.
  if (gimbal.controlled) {
    xml.push(`        <wpml:action>
          <wpml:actionId>${actionId++}</wpml:actionId>
          <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>
            <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
            <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
            <wpml:gimbalPitchRotateAngle>${formatWpmlFloat(gimbal.pitch, -90, 2)}</wpml:gimbalPitchRotateAngle>
            <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
            <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
            <wpml:gimbalYawRotateEnable>${gimbal.yawEnabled ? 1 : 0}</wpml:gimbalYawRotateEnable>
            <wpml:gimbalYawRotateAngle>${formatWpmlFloat(gimbal.yaw, 0, 2)}</wpml:gimbalYawRotateAngle>
            <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
            <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  if (parameters.waypointHoverEnabled) {
    xml.push(`        <wpml:action>
          <wpml:actionId>${actionId++}</wpml:actionId>
          <wpml:actionActuatorFunc>hover</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:hoverTime>${formatWpmlFloat(Math.max(0.1, Number(parameters.waypointHoverTime) || 1), 1, 1)}</wpml:hoverTime>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  if (parameters.waypointRecordVideo && index === 0) {
    xml.push(`        <wpml:action>
          <wpml:actionId>${actionId++}</wpml:actionId>
          <wpml:actionActuatorFunc>startRecord</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:fileSuffix>wp-video-start</wpml:fileSuffix>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  if (parameters.waypointTakePhoto === true) {
    // With a multi-lens payload the barcode photo must not follow the route's
    // global lens setting.
    const lensTags =
      waypoint.kind === 'barcode' && waypoint.photoLens
        ? `
            <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>
            <wpml:payloadLensIndex>${waypoint.photoLens}</wpml:payloadLensIndex>`
        : '';
    xml.push(`        <wpml:action>
          <wpml:actionId>${actionId++}</wpml:actionId>
          <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:fileSuffix>point${index}</wpml:fileSuffix>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>${lensTags}
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  if (parameters.waypointRecordVideo && index === totalWaypoints - 1) {
    xml.push(`        <wpml:action>
          <wpml:actionId>${actionId++}</wpml:actionId>
          <wpml:actionActuatorFunc>stopRecord</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  return { xml, nextActionId: actionId };
};

/**
 * Build every `<wpml:actionGroup>` block for one waypoint.
 *
 * Actions whose trigger is "betweenAdjacentPoints" (gimbalEvenlyRotate) must live
 * in their own group spanning this waypoint and the next one, so they are split
 * out of the regular "reachPoint" group.
 */
const buildActionGroupsXml = (
  waypoint: WaypointData,
  index: number,
  parameters: FlightParameters,
  totalWaypoints: number,
  groupIds: GroupIdCounter
): string => {
  const override = waypoint.override;
  // On a Barcode Scan route the mission-wide actions belong to the barcode
  // points; the aircraft only passes the transit points.
  const isActionPoint = waypoint.kind === undefined || waypoint.kind === 'barcode';
  const useGlobalActions = override?.useGlobalActions !== false && isActionPoint;
  const customActions = override?.actions ?? [];

  const reachPointXml: string[] = [];
  let actionId = 0;

  if (useGlobalActions) {
    const global = buildGlobalActionXml(waypoint, index, parameters, totalWaypoints, actionId);
    reachPointXml.push(...global.xml);
    actionId = global.nextActionId;
  }

  const segmentActions = customActions.filter(
    (action) => getActionDef(action.func)?.trigger === 'betweenAdjacentPoints'
  );
  const intervalActions = customActions.filter(isIntervalAction);

  customActions
    .filter(
      (action) => getActionDef(action.func)?.trigger !== 'betweenAdjacentPoints' && !isIntervalAction(action)
    )
    .forEach((action) => {
      reachPointXml.push(buildActionXml(action, actionId++));
    });

  const groups: string[] = [];

  if (reachPointXml.length > 0) {
    groups.push(`      <wpml:actionGroup>
        <wpml:actionGroupId>${groupIds.next++}</wpml:actionGroupId>
        <wpml:actionGroupStartIndex>${index}</wpml:actionGroupStartIndex>
        <wpml:actionGroupEndIndex>${index}</wpml:actionGroupEndIndex>
        <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
        <wpml:actionTrigger>
          <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
        </wpml:actionTrigger>
${reachPointXml.join('\n')}
      </wpml:actionGroup>`);
  }

  // A segment action needs a following waypoint to span; drop it on the last point.
  if (segmentActions.length > 0 && index < totalWaypoints - 1) {
    const segmentXml = segmentActions.map((action, segmentIndex) => buildActionXml(action, segmentIndex));

    groups.push(`      <wpml:actionGroup>
        <wpml:actionGroupId>${groupIds.next++}</wpml:actionGroupId>
        <wpml:actionGroupStartIndex>${index}</wpml:actionGroupStartIndex>
        <wpml:actionGroupEndIndex>${index + 1}</wpml:actionGroupEndIndex>
        <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
        <wpml:actionTrigger>
          <wpml:actionTriggerType>betweenAdjacentPoints</wpml:actionTriggerType>
        </wpml:actionTrigger>
${segmentXml.join('\n')}
      </wpml:actionGroup>`);
  }

  // Interval capture: one group per action, carrying its own trigger + interval.
  intervalActions.forEach((action) => {
    const def = getActionDef(action.func);
    if (!def || index >= totalWaypoints - 1) return;

    const endIndex = getTriggerSpan(action) === 'toEnd' ? totalWaypoints - 1 : index + 1;
    const triggerParam = getTriggerParam(action);
    const triggerParamTag =
      triggerParam === null
        ? ''
        : `\n          <wpml:actionTriggerParam>${formatWpmlFloat(triggerParam, 2, 2)}</wpml:actionTriggerParam>`;

    groups.push(`      <wpml:actionGroup>
        <wpml:actionGroupId>${groupIds.next++}</wpml:actionGroupId>
        <wpml:actionGroupStartIndex>${index}</wpml:actionGroupStartIndex>
        <wpml:actionGroupEndIndex>${endIndex}</wpml:actionGroupEndIndex>
        <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
        <wpml:actionTrigger>
          <wpml:actionTriggerType>${def.trigger}</wpml:actionTriggerType>${triggerParamTag}
        </wpml:actionTrigger>
${buildActionXml(action, 0)}
      </wpml:actionGroup>`);
  });

  return groups.length ? `\n${groups.join('\n')}` : '';
};

/**
 * Generate XML for a single waypoint (waylines.wpml)
 */
const generateWaypointXML = (
  waypoint: WaypointData,
  index: number,
  parameters: FlightParameters,
  totalWaypoints: number,
  groupIds: GroupIdCounter
): string => {
  const override = waypoint.override;
  const { headingMode, headingAngle } = resolveWaypointHeading(parameters, override);
  const gimbal = resolveWaypointGimbal(parameters, override);
  const speedValue = formatWpmlFloat(override?.speed ?? parameters.speed, 8, 2);

  /*
   * The aircraft has no leg to cut the corner against at the very start and end of
   * the route, so DJI rejects a coordinated turn there:
   *   "Unable to set coordinated turn for start or end waypoint" (error 1546)
   * DJI Pilot 2 converts those two points to a straight-in stop when it generates
   * waylines.wpml, even though template.kml keeps coordinateTurn everywhere.
   */
  const isRouteEndpoint = index === 0 || index === totalWaypoints - 1;
  const turnMode = isRouteEndpoint ? 'toPointAndStopWithDiscontinuityCurvature' : 'coordinateTurn';
  const dampingDist = isRouteEndpoint
    ? '0'
    : formatWpmlFloat(override?.turnDistance ?? parameters.waypointTurnDistance ?? 0.2, 0.2, 2);

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
        <wpml:waypointPoiPoint>${EMPTY_POI}</wpml:waypointPoiPoint>
        <wpml:waypointHeadingAngleEnable>${headingMode === 'followWayline' ? 0 : 1}</wpml:waypointHeadingAngleEnable>
        <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
        <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
      </wpml:waypointHeadingParam>
      <wpml:waypointTurnParam>
        <wpml:waypointTurnMode>${turnMode}</wpml:waypointTurnMode>
        <wpml:waypointTurnDampingDist>${dampingDist}</wpml:waypointTurnDampingDist>
      </wpml:waypointTurnParam>
      <wpml:useStraightLine>1</wpml:useStraightLine>
      <wpml:waypointGimbalHeadingParam>
        <wpml:waypointGimbalPitchAngle>${formatWpmlFloat(gimbal.pitch, -90, 2)}</wpml:waypointGimbalPitchAngle>
        <wpml:waypointGimbalYawAngle>${formatWpmlFloat(gimbal.yaw, 0, 2)}</wpml:waypointGimbalYawAngle>
      </wpml:waypointGimbalHeadingParam>
      <wpml:isRisky>0</wpml:isRisky>
      <wpml:waypointWorkType>0</wpml:waypointWorkType>${buildActionGroupsXml(
        waypoint,
        index,
        parameters,
        totalWaypoints,
        groupIds
      )}${buildPointTypeXml(waypoint.kind)}
    </Placemark>
`;
};

/**
 * Generate XML for a single waypoint (template.kml)
 */
const generateTemplateWaypointXML = (
  waypoint: WaypointData,
  index: number,
  parameters: FlightParameters,
  totalWaypoints: number,
  groupIds: GroupIdCounter
): string => {
  const override = waypoint.override;
  const { headingMode, headingAngle } = resolveWaypointHeading(parameters, override);
  const gimbal = resolveWaypointGimbal(parameters, override);
  const speedValue = formatWpmlFloat(override?.speed ?? parameters.speed, 8, 2);
  const turnMode = 'coordinateTurn';
  const dampingDist = formatWpmlFloat(override?.turnDistance ?? parameters.waypointTurnDistance ?? 0.2, 0.2, 2);

  // DJI requires a per-point pitch only when the route uses "For Each Waypoint".
  const gimbalPitchAngleTag =
    resolveGimbalPitchMode(parameters) === 'usePointSetting'
      ? `\n      <wpml:gimbalPitchAngle>${formatWpmlFloat(gimbal.pitch, -90, 2)}</wpml:gimbalPitchAngle>`
      : '';

  return `    <Placemark>
      <Point>
        <coordinates>${waypoint.lon.toFixed(8)},${waypoint.lat.toFixed(8)}</coordinates>
      </Point>
      <wpml:index>${index}</wpml:index>
      <wpml:ellipsoidHeight>${waypoint.alt.toFixed(2)}</wpml:ellipsoidHeight>
      <wpml:height>${waypoint.alt.toFixed(2)}</wpml:height>
      <wpml:waypointSpeed>${speedValue}</wpml:waypointSpeed>
      <wpml:waypointHeadingParam>
        <wpml:waypointHeadingMode>${headingMode}</wpml:waypointHeadingMode>
        <wpml:waypointHeadingAngle>${headingAngle}</wpml:waypointHeadingAngle>
        <wpml:waypointPoiPoint>${EMPTY_POI}</wpml:waypointPoiPoint>
        <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
        <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
      </wpml:waypointHeadingParam>
      <wpml:waypointTurnParam>
        <wpml:waypointTurnMode>${turnMode}</wpml:waypointTurnMode>
        <wpml:waypointTurnDampingDist>${dampingDist}</wpml:waypointTurnDampingDist>
      </wpml:waypointTurnParam>
      <wpml:useStraightLine>1</wpml:useStraightLine>${gimbalPitchAngleTag}
      <wpml:isRisky>0</wpml:isRisky>${buildActionGroupsXml(
        waypoint,
        index,
        parameters,
        totalWaypoints,
        groupIds
      )}${buildPointTypeXml(waypoint.kind)}
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
  // Matrice 4 series has its own aircraft code; with the Mavic 3E code (77)
  // DJI Pilot 2 shows the route as a Mavic 3E mission and refuses to fly it.
  if (normalized.includes('matrice 4td') || /\bm4td\b/.test(normalized)) {
    return { droneEnumValue: 100, droneSubEnumValue: 1 };
  }
  if (normalized.includes('matrice 4d') || /\bm4d\b/.test(normalized)) {
    return { droneEnumValue: 100, droneSubEnumValue: 0 };
  }
  if (normalized.includes('matrice 4t') || /\bm4t\b/.test(normalized)) {
    return { droneEnumValue: 99, droneSubEnumValue: 1 };
  }
  if (normalized.includes('matrice 4e') || /\bm4e\b/.test(normalized)) {
    return { droneEnumValue: 99, droneSubEnumValue: 0 };
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

  // Matrice 4 series cameras, before the generic wide/zoom rule below.
  if (normalizedId.startsWith('m4td') || normalizedName.includes('matrice 4td')) {
    return { payloadEnumValue: 99, payloadSubEnumValue: 0 };
  }
  if (normalizedId.startsWith('m4d') || normalizedName.includes('matrice 4d')) {
    return { payloadEnumValue: 98, payloadSubEnumValue: 0 };
  }
  if (normalizedId.startsWith('m4t') || normalizedName.includes('matrice 4t')) {
    return { payloadEnumValue: 89, payloadSubEnumValue: 0 };
  }
  if (normalizedId.startsWith('m4e') || normalizedName.includes('matrice 4e')) {
    return { payloadEnumValue: 88, payloadSubEnumValue: 0 };
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

  if (droneEnumValue === 99) {
    return { payloadEnumValue: 88, payloadSubEnumValue: 0 };
  }

  if (droneEnumValue === 100) {
    return { payloadEnumValue: 98, payloadSubEnumValue: 0 };
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
