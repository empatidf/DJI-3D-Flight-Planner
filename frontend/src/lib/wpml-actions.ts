/**
 * DJI WPML Action Catalog
 *
 * Complete list of `wpml:actionActuatorFunc` values and their
 * `wpml:actionActuatorFuncParam` children, transcribed from the official
 * DJI Cloud API documentation:
 *   Cloud-API-Doc/docs/en/60.api-reference/00.dji-wpml/40.common-element.md
 *
 * Each action definition carries enough metadata for the UI to render a
 * generic parameter form and for the exporter to emit valid WPML.
 */

export type WpmlActionFunc =
  | 'takePhoto'
  | 'startRecord'
  | 'stopRecord'
  | 'focus'
  | 'zoom'
  | 'customDirName'
  | 'gimbalRotate'
  | 'gimbalEvenlyRotate'
  | 'rotateYaw'
  | 'hover'
  | 'orientedShoot'
  | 'accurateShoot'
  | 'panoShot'
  | 'recordPointCloud'
  // Interval capture is not its own actuator function: it is a `takePhoto`
  // action attached to a timed / distance-based action trigger.
  | 'intervalShotTime'
  | 'intervalShotDistance';

export type WpmlActionTriggerType =
  | 'reachPoint'
  | 'betweenAdjacentPoints'
  | 'multipleTiming'
  | 'multipleDistance';

export type WpmlParamValue = string | number;

export interface WpmlActionParamDef {
  /** WPML element local name, emitted as <wpml:{key}> */
  key: string;
  label: string;
  type: 'number' | 'text' | 'bool' | 'enum' | 'multi-enum';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  default: WpmlParamValue;
  hint?: string;
  /** Emitted with its default but never shown in the form (runtime/system fields). */
  hidden?: boolean;
  /** Only shown and only emitted while another parameter holds the given value. */
  dependsOn?: { key: string; value: WpmlParamValue };
  /** Emitted only when the value is a non-empty string / finite number. */
  optional?: boolean;
  /**
   * Where the value belongs in the WPML tree:
   * - `actuator` (default) → inside `<wpml:actionActuatorFuncParam>`
   * - `trigger`            → `<wpml:actionTriggerParam>` of the action group
   * - `meta`               → planner-only, never written to the KMZ
   */
  role?: 'actuator' | 'trigger' | 'meta';
}

export interface WpmlActionDef {
  func: WpmlActionFunc;
  /** Actual `wpml:actionActuatorFunc` value, when it differs from the catalog id. */
  emitAs?: WpmlActionFunc;
  label: string;
  description: string;
  /** Trigger type the action group must use for this action. */
  trigger: WpmlActionTriggerType;
  /** Models that support the action, as listed by DJI. */
  support: string;
  deprecated?: boolean;
  params: WpmlActionParamDef[];
}

const PAYLOAD_POSITION_PARAM: WpmlActionParamDef = {
  key: 'payloadPositionIndex',
  label: 'Payload Position',
  type: 'enum',
  options: [
    { value: '0', label: '1 — front left' },
    { value: '1', label: '2 — front right' },
    { value: '2', label: '3 — top' },
  ],
  default: 0,
  hint: 'Mount position on M300/M350 RTK. Other aircraft always use the main gimbal.',
};

const LENS_OPTIONS = [
  { value: 'wide', label: 'Wide' },
  { value: 'zoom', label: 'Zoom / Tele' },
  { value: 'ir', label: 'Infrared' },
  { value: 'narrow_band', label: 'Narrow band' },
  { value: 'visable', label: 'Visible' },
];

const USE_GLOBAL_LENS_PARAM: WpmlActionParamDef = {
  key: 'useGlobalPayloadLensIndex',
  label: 'Use Global Storage Type',
  type: 'bool',
  default: 1,
  hint: 'When enabled, the lens list from the mission payload settings is used.',
};

const LENS_INDEX_PARAM: WpmlActionParamDef = {
  key: 'payloadLensIndex',
  label: 'Storage Lens',
  type: 'multi-enum',
  options: LENS_OPTIONS,
  default: 'wide',
  hint: 'Multiple lenses allowed, e.g. "wide,ir".',
  dependsOn: { key: 'useGlobalPayloadLensIndex', value: 0 },
};

/** How far an interval-capture action group reaches. Planner-only, not written to WPML. */
const INTERVAL_SPAN_PARAM: WpmlActionParamDef = {
  key: 'triggerSpan',
  label: 'Applies To',
  type: 'enum',
  options: [
    { value: 'segment', label: 'This segment (to next WP)' },
    { value: 'toEnd', label: 'Rest of the route' },
  ],
  default: 'segment',
  role: 'meta',
};

/** Shared trailing fields of accurateShoot / orientedShoot that DJI fills at runtime. */
const shootRuntimeParams = (prefix: 'accurate' | 'oriented'): WpmlActionParamDef[] => [
  { key: `${prefix}FilePath`, label: 'File Path', type: 'text', default: '', hidden: true },
  { key: `${prefix}FileMD5`, label: 'File MD5', type: 'text', default: '', hidden: true },
  { key: `${prefix}FileSize`, label: 'File Size', type: 'number', default: 0, hidden: true },
  { key: `${prefix}CameraApertue`, label: 'Aperture ×100', type: 'number', default: 280, hidden: true },
  { key: `${prefix}CameraLuminance`, label: 'Luminance', type: 'number', default: 0, hidden: true },
  { key: `${prefix}CameraShutterTime`, label: 'Shutter Time', type: 'number', default: 0, hidden: true },
  { key: `${prefix}CameraISO`, label: 'ISO', type: 'number', default: 0, hidden: true },
];

export const WPML_ACTIONS: WpmlActionDef[] = [
  {
    func: 'takePhoto',
    label: 'Take Photo',
    description: 'Capture a single photo when the aircraft reaches the waypoint.',
    trigger: 'reachPoint',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      PAYLOAD_POSITION_PARAM,
      {
        key: 'fileSuffix',
        label: 'File Suffix',
        type: 'text',
        default: '',
        hint: 'Appended to the generated media file name.',
        optional: true,
      },
      USE_GLOBAL_LENS_PARAM,
      LENS_INDEX_PARAM,
    ],
  },
  {
    func: 'intervalShotTime',
    emitAs: 'takePhoto',
    label: 'Timed Interval Shot',
    description: 'Take a photo every N seconds while flying on from this waypoint.',
    trigger: 'multipleTiming',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      {
        key: 'actionTriggerParam',
        label: 'Interval',
        type: 'number',
        unit: 's',
        min: 0.1,
        max: 10,
        step: 0.1,
        default: 2,
        role: 'trigger',
      },
      INTERVAL_SPAN_PARAM,
      PAYLOAD_POSITION_PARAM,
      { key: 'fileSuffix', label: 'File Suffix', type: 'text', default: '', optional: true },
      USE_GLOBAL_LENS_PARAM,
      LENS_INDEX_PARAM,
    ],
  },
  {
    func: 'intervalShotDistance',
    emitAs: 'takePhoto',
    label: 'Distance Interval Shot',
    description: 'Take a photo every N metres while flying on from this waypoint.',
    trigger: 'multipleDistance',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      {
        key: 'actionTriggerParam',
        label: 'Interval',
        type: 'number',
        unit: 'm',
        min: 0.1,
        max: 10,
        step: 0.1,
        default: 2,
        role: 'trigger',
      },
      INTERVAL_SPAN_PARAM,
      PAYLOAD_POSITION_PARAM,
      { key: 'fileSuffix', label: 'File Suffix', type: 'text', default: '', optional: true },
      USE_GLOBAL_LENS_PARAM,
      LENS_INDEX_PARAM,
    ],
  },
  {
    func: 'startRecord',
    label: 'Start Recording',
    description: 'Start video recording.',
    trigger: 'reachPoint',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      PAYLOAD_POSITION_PARAM,
      {
        key: 'fileSuffix',
        label: 'File Suffix',
        type: 'text',
        default: '',
        optional: true,
      },
      USE_GLOBAL_LENS_PARAM,
      LENS_INDEX_PARAM,
    ],
  },
  {
    func: 'stopRecord',
    label: 'Stop Recording',
    description: 'Stop video recording.',
    trigger: 'reachPoint',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      PAYLOAD_POSITION_PARAM,
      { ...LENS_INDEX_PARAM, dependsOn: undefined, optional: true, default: '' },
    ],
  },
  {
    func: 'focus',
    label: 'Focus',
    description: 'Focus on a point or an area of the camera frame.',
    trigger: 'reachPoint',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      PAYLOAD_POSITION_PARAM,
      {
        key: 'isPointFocus',
        label: 'Point Focus',
        type: 'bool',
        default: 1,
        hint: 'Off = area focus (region width/height required).',
      },
      { key: 'focusX', label: 'Focus X', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: '0 = left edge, 1 = right edge.' },
      { key: 'focusY', label: 'Focus Y', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: '0 = top edge, 1 = bottom edge.' },
      {
        key: 'focusRegionWidth',
        label: 'Region Width Ratio',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.01,
        default: 0.2,
        dependsOn: { key: 'isPointFocus', value: 0 },
      },
      {
        key: 'focusRegionHeight',
        label: 'Region Height Ratio',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.01,
        default: 0.2,
        dependsOn: { key: 'isPointFocus', value: 0 },
      },
      { key: 'isInfiniteFocus', label: 'Infinite Focus', type: 'bool', default: 0, hint: 'M3E/M3T/M3M, M3D/M3TD only.' },
    ],
  },
  {
    func: 'zoom',
    label: 'Zoom',
    description: 'Set the zoom camera focal length.',
    trigger: 'reachPoint',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      PAYLOAD_POSITION_PARAM,
      { key: 'focalLength', label: 'Focal Length', type: 'number', unit: 'mm', min: 1, step: 0.1, default: 24 },
    ],
  },
  {
    func: 'customDirName',
    label: 'Create Folder',
    description: 'Create a new media folder on the aircraft storage.',
    trigger: 'reachPoint',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      PAYLOAD_POSITION_PARAM,
      { key: 'directoryName', label: 'Folder Name', type: 'text', default: 'folder1' },
    ],
  },
  {
    func: 'gimbalRotate',
    label: 'Rotate Gimbal',
    description: 'Rotate the gimbal to an absolute pitch / roll / yaw attitude.',
    trigger: 'reachPoint',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      PAYLOAD_POSITION_PARAM,
      {
        key: 'gimbalHeadingYawBase',
        label: 'Yaw Reference',
        type: 'enum',
        options: [
          { value: 'north', label: 'north — relative to geographic north' },
          { value: 'aircraft', label: 'aircraft — relative to aircraft heading' },
        ],
        default: 'aircraft',
        hint: 'DJI documents "north"; "aircraft" is accepted by Pilot 2 and used by the global gimbal action.',
      },
      {
        key: 'gimbalRotateMode',
        label: 'Rotate Mode',
        type: 'enum',
        options: [{ value: 'absoluteAngle', label: 'absoluteAngle' }],
        default: 'absoluteAngle',
      },
      { key: 'gimbalPitchRotateEnable', label: 'Pitch Enable', type: 'bool', default: 1 },
      {
        key: 'gimbalPitchRotateAngle',
        label: 'Pitch Angle',
        type: 'number',
        unit: '°',
        min: -120,
        max: 45,
        step: 1,
        default: -90,
        dependsOn: { key: 'gimbalPitchRotateEnable', value: 1 },
      },
      { key: 'gimbalRollRotateEnable', label: 'Roll Enable', type: 'bool', default: 0 },
      {
        key: 'gimbalRollRotateAngle',
        label: 'Roll Angle',
        type: 'number',
        unit: '°',
        min: -180,
        max: 180,
        step: 1,
        default: 0,
        dependsOn: { key: 'gimbalRollRotateEnable', value: 1 },
      },
      { key: 'gimbalYawRotateEnable', label: 'Yaw Enable', type: 'bool', default: 0 },
      {
        key: 'gimbalYawRotateAngle',
        label: 'Yaw Angle',
        type: 'number',
        unit: '°',
        min: -180,
        max: 180,
        step: 1,
        default: 0,
        dependsOn: { key: 'gimbalYawRotateEnable', value: 1 },
      },
      { key: 'gimbalRotateTimeEnable', label: 'Timed Rotation', type: 'bool', default: 0 },
      {
        key: 'gimbalRotateTime',
        label: 'Rotation Time',
        type: 'number',
        unit: 's',
        min: 0,
        step: 0.1,
        default: 0,
        dependsOn: { key: 'gimbalRotateTimeEnable', value: 1 },
      },
    ],
  },
  {
    func: 'gimbalEvenlyRotate',
    label: 'Rotate Gimbal Evenly (segment)',
    description:
      'Rotate the gimbal pitch evenly along the segment that starts at this waypoint. Uses the "betweenAdjacentPoints" trigger.',
    trigger: 'betweenAdjacentPoints',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      {
        key: 'gimbalPitchRotateAngle',
        label: 'Target Pitch Angle',
        type: 'number',
        unit: '°',
        min: -120,
        max: 45,
        step: 1,
        default: -90,
      },
      PAYLOAD_POSITION_PARAM,
    ],
  },
  {
    func: 'rotateYaw',
    label: 'Rotate Aircraft (Yaw)',
    description: 'Rotate the aircraft around its yaw axis to an absolute heading.',
    trigger: 'reachPoint',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      {
        key: 'aircraftHeading',
        label: 'Target Heading',
        type: 'number',
        unit: '°',
        min: -180,
        max: 180,
        step: 1,
        default: 0,
        hint: '0 = north, 90 = east, -90 = west, ±180 = south.',
      },
      {
        key: 'aircraftPathMode',
        label: 'Rotation Direction',
        type: 'enum',
        options: [
          { value: 'clockwise', label: 'Clockwise' },
          { value: 'counterClockwise', label: 'Counter-clockwise' },
        ],
        default: 'clockwise',
        hint: 'M300 RTK / M350 RTK only.',
      },
    ],
  },
  {
    func: 'hover',
    label: 'Hover',
    description: 'Hold position at the waypoint for a given time.',
    trigger: 'reachPoint',
    support: 'M300/M350 RTK, M30/M30T, M3E/M3T/M3M, M3D/M3TD',
    params: [
      { key: 'hoverTime', label: 'Hover Time', type: 'number', unit: 's', min: 0.1, step: 0.5, default: 3 },
    ],
  },
  {
    func: 'orientedShoot',
    label: 'Take Photo (Fixed Angle)',
    description: 'Capture with a fixed aircraft heading and gimbal attitude (AI spot-check successor).',
    trigger: 'reachPoint',
    support: 'M30/M30T, M3E/M3T, M3D/M3TD',
    params: [
      {
        key: 'gimbalPitchRotateAngle',
        label: 'Gimbal Pitch',
        type: 'number',
        unit: '°',
        min: -120,
        max: 45,
        step: 1,
        default: -90,
        hint: 'M30/M30T [-120, 45] · M3E/M3T [-90, 35] · M3D/M3TD [-90, 30]',
      },
      {
        key: 'gimbalYawRotateAngle',
        label: 'Gimbal Yaw',
        type: 'number',
        unit: '°',
        min: -180,
        max: 180,
        step: 1,
        default: 0,
        hint: 'On M3E/M3T and M3D/M3TD this must match the aircraft heading.',
      },
      {
        key: 'aircraftHeading',
        label: 'Aircraft Heading',
        type: 'number',
        unit: '°',
        min: -180,
        max: 180,
        step: 1,
        default: 0,
      },
      { key: 'focalLength', label: 'Focal Length', type: 'number', unit: 'mm', min: 1, step: 0.1, default: 24 },
      {
        key: 'orientedPhotoMode',
        label: 'Capture Mode',
        type: 'enum',
        options: [
          { value: 'normalPhoto', label: 'Normal' },
          { value: 'lowLightSmartShooting', label: 'Smart Low-Light' },
        ],
        default: 'normalPhoto',
      },
      { key: 'orientedFileSuffix', label: 'File Suffix', type: 'text', default: '' },
      USE_GLOBAL_LENS_PARAM,
      LENS_INDEX_PARAM,
      { key: 'focusX', label: 'Focus X', type: 'number', default: 480, hidden: true },
      { key: 'focusY', label: 'Focus Y', type: 'number', default: 360, hidden: true },
      { key: 'focusRegionWidth', label: 'Region Width', type: 'number', default: 960, hidden: true },
      { key: 'focusRegionHeight', label: 'Region Height', type: 'number', default: 720, hidden: true },
      { key: 'accurateFrameValid', label: 'Target Selected', type: 'bool', default: 0, hidden: true },
      { key: 'payloadPositionIndex', label: 'Payload Position', type: 'number', default: 0, hidden: true },
      { key: 'targetAngle', label: 'Target Box Angle', type: 'number', default: 0, hidden: true },
      { key: 'imageWidth', label: 'Image Width', type: 'number', default: 960, hidden: true },
      { key: 'imageHeight', label: 'Image Height', type: 'number', default: 720, hidden: true },
      { key: 'AFPos', label: 'AF Motor Position', type: 'number', default: 0, hidden: true },
      { key: 'gimbalPort', label: 'Gimbal Port', type: 'number', default: 0, hidden: true },
      { key: 'orientedCameraType', label: 'Camera Type', type: 'number', default: 67, hidden: true },
      ...shootRuntimeParams('oriented'),
    ],
  },
  {
    func: 'accurateShoot',
    label: 'AI Spot-Check (legacy)',
    description: 'Legacy AI spot-check capture. DJI recommends "Take Photo (Fixed Angle)" instead.',
    trigger: 'reachPoint',
    support: 'M300/M350 RTK, M30/M30T',
    deprecated: true,
    params: [
      {
        key: 'gimbalPitchRotateAngle',
        label: 'Gimbal Pitch',
        type: 'number',
        unit: '°',
        min: -120,
        max: 45,
        step: 1,
        default: -90,
      },
      {
        key: 'gimbalYawRotateAngle',
        label: 'Gimbal Yaw',
        type: 'number',
        unit: '°',
        min: -180,
        max: 180,
        step: 1,
        default: 0,
      },
      {
        key: 'aircraftHeading',
        label: 'Aircraft Heading',
        type: 'number',
        unit: '°',
        min: -180,
        max: 180,
        step: 1,
        default: 0,
      },
      { key: 'focalLength', label: 'Focal Length', type: 'number', unit: 'mm', min: 1, step: 0.1, default: 24 },
      { key: 'accurateFileSuffix', label: 'File Suffix', type: 'text', default: '' },
      USE_GLOBAL_LENS_PARAM,
      LENS_INDEX_PARAM,
      { key: 'focusX', label: 'Focus X', type: 'number', default: 480, hidden: true },
      { key: 'focusY', label: 'Focus Y', type: 'number', default: 360, hidden: true },
      { key: 'focusRegionWidth', label: 'Region Width', type: 'number', default: 960, hidden: true },
      { key: 'focusRegionHeight', label: 'Region Height', type: 'number', default: 720, hidden: true },
      { key: 'accurateFrameValid', label: 'Target Selected', type: 'bool', default: 0, hidden: true },
      { key: 'payloadPositionIndex', label: 'Payload Position', type: 'number', default: 0, hidden: true },
      { key: 'targetAngle', label: 'Target Box Angle', type: 'number', default: 0, hidden: true },
      { key: 'imageWidth', label: 'Image Width', type: 'number', default: 960, hidden: true },
      { key: 'imageHeight', label: 'Image Height', type: 'number', default: 720, hidden: true },
      { key: 'AFPos', label: 'AF Motor Position', type: 'number', default: 0, hidden: true },
      { key: 'gimbalPort', label: 'Gimbal Port', type: 'number', default: 0, hidden: true },
      { key: 'accurateCameraType', label: 'Camera Type', type: 'number', default: 53, hidden: true },
      ...shootRuntimeParams('accurate'),
    ],
  },
  {
    func: 'panoShot',
    label: 'Panorama',
    description: 'Shoot a 360° panorama at the waypoint.',
    trigger: 'reachPoint',
    support: 'M30/M30T, M3D/M3TD (M3E/M3T: global lens flag only)',
    params: [
      PAYLOAD_POSITION_PARAM,
      USE_GLOBAL_LENS_PARAM,
      LENS_INDEX_PARAM,
      {
        key: 'panoShotSubMode',
        label: 'Panorama Mode',
        type: 'enum',
        options: [{ value: 'panoShot_360', label: '360° panorama' }],
        default: 'panoShot_360',
      },
    ],
  },
  {
    func: 'recordPointCloud',
    label: 'Point Cloud Recording',
    description: 'Control LiDAR point-cloud recording (L1/L2 payloads).',
    trigger: 'reachPoint',
    support: 'M300 RTK, M350 RTK',
    params: [
      PAYLOAD_POSITION_PARAM,
      {
        key: 'recordPointCloudOperate',
        label: 'Operation',
        type: 'enum',
        options: [
          { value: 'startRecord', label: 'Start recording' },
          { value: 'pauseRecord', label: 'Pause recording' },
          { value: 'resumeRecord', label: 'Resume recording' },
          { value: 'stopRecord', label: 'Stop recording' },
        ],
        default: 'startRecord',
      },
    ],
  },
];

export const getActionDef = (func: string): WpmlActionDef | undefined =>
  WPML_ACTIONS.find((action) => action.func === func);

/* ------------------------------------------------------------------ */
/* Payload context — tailor the catalog to the selected drone/camera   */
/* ------------------------------------------------------------------ */

export type ModelClass = 'M300' | 'M350' | 'M30' | 'M3E' | 'M3T' | 'M3M' | 'M3D' | 'M3TD' | 'CUSTOM';

export type ActionCategory = 'Camera' | 'Gimbal' | 'Aircraft';

/** Models each action is available on, per the DJI documentation. */
const ALL_MODELS: ModelClass[] = ['M300', 'M350', 'M30', 'M3E', 'M3T', 'M3M', 'M3D', 'M3TD'];

const ACTION_MODELS: Record<WpmlActionFunc, ModelClass[]> = {
  takePhoto: ALL_MODELS,
  intervalShotTime: ALL_MODELS,
  intervalShotDistance: ALL_MODELS,
  startRecord: ALL_MODELS,
  stopRecord: ALL_MODELS,
  focus: ALL_MODELS,
  zoom: ALL_MODELS,
  customDirName: ALL_MODELS,
  gimbalRotate: ALL_MODELS,
  gimbalEvenlyRotate: ALL_MODELS,
  rotateYaw: ALL_MODELS,
  hover: ALL_MODELS,
  orientedShoot: ['M30', 'M3E', 'M3T', 'M3D', 'M3TD'],
  accurateShoot: ['M300', 'M350', 'M30'],
  panoShot: ['M30', 'M3D', 'M3TD'],
  recordPointCloud: ['M300', 'M350'],
};

export const ACTION_CATEGORY: Record<WpmlActionFunc, ActionCategory> = {
  takePhoto: 'Camera',
  intervalShotTime: 'Camera',
  intervalShotDistance: 'Camera',
  startRecord: 'Camera',
  stopRecord: 'Camera',
  focus: 'Camera',
  zoom: 'Camera',
  customDirName: 'Camera',
  orientedShoot: 'Camera',
  accurateShoot: 'Camera',
  panoShot: 'Camera',
  recordPointCloud: 'Camera',
  gimbalRotate: 'Gimbal',
  gimbalEvenlyRotate: 'Gimbal',
  rotateYaw: 'Aircraft',
  hover: 'Aircraft',
};

export interface PayloadContext {
  modelClass: ModelClass;
  droneLabel: string;
  cameraLabel: string;
  /** payloadLensIndex values the mounted payload actually offers. */
  lenses: string[];
  /** Only M300/M350 carry more than one payload position. */
  multiPayload: boolean;
  gimbalPitchRange: [number, number];
  defaultFocalLength: number;
}

/**
 * Derive what the currently selected drone + camera can actually do, so the
 * action forms stop asking for things the setup already determines.
 */
export const resolvePayloadContext = (
  drone: { id?: string; name: string },
  camera: { id?: string; name: string; focalLength?: number }
): PayloadContext => {
  const droneId = (drone.id ?? '').toLowerCase();
  const droneName = drone.name.toLowerCase();
  const cameraId = (camera.id ?? '').toLowerCase();

  const base = {
    droneLabel: drone.name,
    cameraLabel: camera.name,
    defaultFocalLength: camera.focalLength && camera.focalLength > 0 ? camera.focalLength : 24,
  };

  if (droneId === 'mavic3t' || droneName.includes('mavic 3t')) {
    return {
      ...base,
      modelClass: 'M3T',
      lenses: ['wide', 'zoom', 'ir'],
      multiPayload: false,
      gimbalPitchRange: [-90, 35],
    };
  }

  if (droneId === 'mavic3e' || droneId === 'm4e' || droneName.includes('mavic 3e') || droneName.includes('matrice 4e')) {
    return {
      ...base,
      modelClass: 'M3E',
      lenses: ['wide', 'zoom'],
      multiPayload: false,
      gimbalPitchRange: [-90, 35],
    };
  }

  if (droneId === 'm300-rtk' || droneName.includes('matrice 300') || droneName.includes('matrice 350')) {
    // P1 / L2 / PhaseOne are single-lens payloads, so no lens picker is offered.
    const isMultiLens = cameraId.includes('h20') || cameraId.includes('h30');
    return {
      ...base,
      modelClass: droneName.includes('350') ? 'M350' : 'M300',
      lenses: isMultiLens ? ['wide', 'zoom', 'ir'] : [],
      multiPayload: true,
      gimbalPitchRange: [-120, 45],
    };
  }

  return {
    ...base,
    modelClass: 'CUSTOM',
    lenses: [],
    multiPayload: false,
    gimbalPitchRange: [-120, 45],
  };
};

/** Actions the selected aircraft supports. Unknown/custom platforms get the full list. */
export const getActionsForContext = (context: PayloadContext): WpmlActionDef[] =>
  context.modelClass === 'CUSTOM'
    ? WPML_ACTIONS
    : WPML_ACTIONS.filter((action) => ACTION_MODELS[action.func].includes(context.modelClass));

/**
 * Rewrite a catalog entry for the selected payload: hide questions the setup
 * already answers, narrow enum choices, and seed ranges/defaults from the camera.
 */
export const contextualizeAction = (def: WpmlActionDef, context: PayloadContext): WpmlActionDef => {
  const singleLens = context.lenses.length <= 1;

  const params = def.params.map((param): WpmlActionParamDef => {
    if (param.key === 'payloadPositionIndex') {
      // Single-gimbal aircraft always use position 0 — emit it, never ask for it.
      return context.multiPayload ? param : { ...param, hidden: true, default: 0 };
    }

    if (param.key === 'useGlobalPayloadLensIndex') {
      return singleLens ? { ...param, hidden: true, default: 1 } : param;
    }

    if (param.key === 'payloadLensIndex') {
      if (singleLens) return { ...param, hidden: true };
      return {
        ...param,
        options: LENS_OPTIONS.filter((option) => context.lenses.includes(option.value)),
        default: context.lenses[0],
      };
    }

    if (param.key === 'gimbalPitchRotateAngle') {
      const [min, max] = context.gimbalPitchRange;
      return { ...param, min, max, default: Math.max(min, Math.min(max, Number(param.default))) };
    }

    if (param.key === 'focalLength') {
      return { ...param, default: context.defaultFocalLength };
    }

    return param;
  });

  return { ...def, params };
};

/** Stored representation of a single user-configured action. */
export interface WaypointAction {
  id: string;
  func: WpmlActionFunc;
  params: Record<string, WpmlParamValue>;
}

let actionIdCounter = 0;
const nextActionId = () => {
  actionIdCounter += 1;
  return `wpa-${Date.now().toString(36)}-${actionIdCounter.toString(36)}`;
};

/** Build a new action pre-filled with the catalog defaults for this payload. */
export const createWaypointAction = (func: WpmlActionFunc, context?: PayloadContext): WaypointAction => {
  const base = getActionDef(func);
  const def = base && context ? contextualizeAction(base, context) : base;

  const params: Record<string, WpmlParamValue> = {};
  def?.params.forEach((param) => {
    params[param.key] = param.default;
  });

  return { id: nextActionId(), func, params };
};

/** Parameters the form should render for the current values (respects dependsOn). */
export const getVisibleParams = (
  def: WpmlActionDef,
  values: Record<string, WpmlParamValue>
): WpmlActionParamDef[] =>
  def.params.filter((param) => {
    if (param.hidden) return false;
    if (!param.dependsOn) return true;
    return normalizeParamValue(values[param.dependsOn.key], param.dependsOn.value) === param.dependsOn.value;
  });

const normalizeParamValue = (value: WpmlParamValue | undefined, reference: WpmlParamValue): WpmlParamValue => {
  if (value === undefined) return NaN as unknown as WpmlParamValue;
  if (typeof reference === 'number') {
    return Number(value);
  }
  return String(value);
};

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const formatParamValue = (param: WpmlActionParamDef, value: WpmlParamValue): string => {
  if (param.type === 'bool') {
    return Number(value) ? '1' : '0';
  }
  if (param.type === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return String(param.default);
    // Trim trailing zeros while keeping up to 6 decimals.
    return String(Number(parsed.toFixed(6)));
  }
  return escapeXml(String(value));
};

/**
 * Serialize one action into a `<wpml:action>` block.
 * `actionId` must be unique inside its action group.
 */
export const buildActionXml = (
  action: WaypointAction,
  actionId: number,
  indent = '        '
): string => {
  const def = getActionDef(action.func);
  if (!def) return '';

  const inner = indent + '  ';
  const paramLines: string[] = [];

  def.params.forEach((param) => {
    // Trigger interval and planner-only fields live outside actionActuatorFuncParam.
    if ((param.role ?? 'actuator') !== 'actuator') return;

    if (param.dependsOn) {
      const current = normalizeParamValue(action.params[param.dependsOn.key], param.dependsOn.value);
      if (current !== param.dependsOn.value) return;
    }

    const raw = action.params[param.key] ?? param.default;

    if (param.optional) {
      if (raw === undefined || raw === null || String(raw).trim() === '') return;
    }

    // actionUUID is generated per export so repeated actions stay distinguishable.
    paramLines.push(`${inner}  <wpml:${param.key}>${formatParamValue(param, raw)}</wpml:${param.key}>`);
  });

  if (def.func === 'orientedShoot') {
    paramLines.push(`${inner}  <wpml:actionUUID>${crypto.randomUUID?.() ?? `uuid-${actionId}`}</wpml:actionUUID>`);
  }

  return `${indent}<wpml:action>
${inner}<wpml:actionId>${actionId}</wpml:actionId>
${inner}<wpml:actionActuatorFunc>${def.emitAs ?? def.func}</wpml:actionActuatorFunc>
${inner}<wpml:actionActuatorFuncParam>
${paramLines.join('\n')}
${inner}</wpml:actionActuatorFuncParam>
${indent}</wpml:action>`;
};

/** True when the action must sit in its own interval-triggered action group. */
export const isIntervalAction = (action: WaypointAction): boolean => {
  const trigger = getActionDef(action.func)?.trigger;
  return trigger === 'multipleTiming' || trigger === 'multipleDistance';
};

/** Value for `<wpml:actionTriggerParam>`, or null when the trigger takes no parameter. */
export const getTriggerParam = (action: WaypointAction): number | null => {
  const def = getActionDef(action.func);
  const param = def?.params.find((entry) => entry.role === 'trigger');
  if (!param) return null;

  const value = Number(action.params[param.key] ?? param.default);
  return Number.isFinite(value) ? value : Number(param.default);
};

/** How far an interval action group reaches: this segment, or the rest of the route. */
export const getTriggerSpan = (action: WaypointAction): 'segment' | 'toEnd' =>
  action.params.triggerSpan === 'toEnd' ? 'toEnd' : 'segment';

/** One-line summary used in action lists. */
export const describeAction = (action: WaypointAction): string => {
  const def = getActionDef(action.func);
  if (!def) return action.func;

  switch (action.func) {
    case 'intervalShotTime':
      return `${def.label} · every ${action.params.actionTriggerParam ?? 0} s`;
    case 'intervalShotDistance':
      return `${def.label} · every ${action.params.actionTriggerParam ?? 0} m`;
    case 'hover':
      return `${def.label} · ${action.params.hoverTime ?? 0} s`;
    case 'zoom':
      return `${def.label} · ${action.params.focalLength ?? 0} mm`;
    case 'rotateYaw':
      return `${def.label} · ${action.params.aircraftHeading ?? 0}°`;
    case 'gimbalRotate':
      return `${def.label} · pitch ${action.params.gimbalPitchRotateAngle ?? 0}°`;
    case 'gimbalEvenlyRotate':
      return `${def.label} · pitch ${action.params.gimbalPitchRotateAngle ?? 0}°`;
    case 'customDirName':
      return `${def.label} · ${action.params.directoryName ?? ''}`;
    case 'orientedShoot':
    case 'accurateShoot':
      return `${def.label} · pitch ${action.params.gimbalPitchRotateAngle ?? 0}° / yaw ${action.params.aircraftHeading ?? 0}°`;
    case 'recordPointCloud':
      return `${def.label} · ${action.params.recordPointCloudOperate ?? ''}`;
    default:
      return def.label;
  }
};
