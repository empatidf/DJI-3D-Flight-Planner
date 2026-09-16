/**
 * New Mission wizard.
 *
 * Modelled on DJI FlightHub 2's "Create Route" dialog: the mission type is the
 * first decision, not a side effect of whichever import or draw button gets
 * pressed later. Steps: type → where the geometry comes from → aircraft → name.
 * The type chosen here is fixed for the life of the mission.
 *
 * Barcode Scan is our own method: it always starts from a solar park's panel
 * layout and always flies the Matrice 4E wide camera, so it has no source
 * choice and no aircraft step.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DRONES, barcodeCameras, barcodeDrones, defaultBarcodeAircraft } from '../lib/drone-specs';
import {
  importKMLFile,
  importWaypointKMLFile,
  type KMLPolygon,
  type KMLWaypointSet,
} from '../lib/kml-parser';
import { describePanelLayout, importPanelLayoutFile, type ParsedPanelLayout } from '../lib/barcode-panels';
import { applyAreaPolygon, applyBarcodePanels, applyWaypointRoute, describePolygon } from '../lib/mission-import';
import { buildNewMissionParameters, useMissionStore, type Mission } from '../stores/mission-store';
import './NewMissionWizard.css';

type MissionType = Mission['missionType'];
type Source = 'import' | 'map';
type StepKey = 'type' | 'source' | 'aircraft' | 'name';
type ParsedFile =
  | { kind: 'area'; fileName: string; polygon: KMLPolygon; polygonCount: number }
  | { kind: 'waypoint'; fileName: string; route: KMLWaypointSet }
  | { kind: 'barcode'; fileName: string; layout: ParsedPanelLayout };

const NAME_MAX = 60;

const STEP_LABELS: Record<StepKey, string> = {
  type: 'Type',
  source: 'Source',
  aircraft: 'Aircraft',
  name: 'Name',
};

const TYPE_LABELS: Record<MissionType, string> = {
  area: 'Area route',
  waypoint: 'Waypoint route',
  barcode: 'Barcode scan',
};

const DEFAULT_NAMES: Record<MissionType, string> = {
  area: 'Area mission',
  waypoint: 'Waypoint mission',
  barcode: 'Barcode scan',
};

/** Every mission type walks the same steps; only the step's content differs. */
const STEPS: StepKey[] = ['type', 'source', 'aircraft', 'name'];

const AreaIcon = () => (
  <svg className="nmw-card-icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M6 12 20 5l14 9-3 19-22 2Z" strokeLinejoin="round" />
    <path d="M9 17h24M8 23h24M8 29h23" strokeWidth="1.4" strokeDasharray="2.5 2" />
  </svg>
);

const WaypointIcon = () => (
  <svg className="nmw-card-icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M7 32 15 14l10 12 8-18" strokeLinejoin="round" />
    <circle cx="7" cy="32" r="3" fill="currentColor" />
    <circle cx="15" cy="14" r="3" fill="currentColor" />
    <circle cx="25" cy="26" r="3" fill="currentColor" />
    <circle cx="33" cy="8" r="3" fill="currentColor" />
  </svg>
);

const BarcodeIcon = () => (
  <svg className="nmw-card-icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    {[0, 1, 2].map((row) =>
      [0, 1, 2, 3].map((col) => (
        <rect key={`${row}-${col}`} x={3.5 + col * 8.5} y={6 + row * 10} width="7" height="8" />
      ))
    )}
    <path d="M1 21h38" strokeWidth="2.4" strokeDasharray="4 2" />
  </svg>
);

export const NewMissionWizard = ({ onClose }: { onClose: () => void }) => {
  const missions = useMissionStore((state) => state.missions);
  const layers = useMissionStore((state) => state.layers);
  const missionDefaults = useMissionStore((state) => state.missionDefaults);
  const addMission = useMissionStore((state) => state.addMission);
  const setMissionDefaults = useMissionStore((state) => state.setMissionDefaults);
  const setDrawAoiMode = useMissionStore((state) => state.setDrawAoiMode);
  const setDrawWaypointMode = useMissionStore((state) => state.setDrawWaypointMode);
  const setKmlEditMode = useMissionStore((state) => state.setKmlEditMode);

  // Same aircraft as the last mission, so a series of missions needs no re-picking.
  const [droneId, setDroneId] = useState(
    () => (DRONES.find((drone) => drone.id === missionDefaults.droneId) ?? DRONES[0]).id
  );
  const [cameraId, setCameraId] = useState(() => missionDefaults.cameraId ?? '');
  const [step, setStep] = useState(0);
  const [type, setType] = useState<MissionType | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const isArea = type === 'area';
  const isBarcode = type === 'barcode';
  const steps = STEPS;
  const stepIndex = Math.min(step, steps.length - 1);
  const currentStep = steps[stepIndex];
  const isLastStep = stepIndex === steps.length - 1;

  // Barcode scanning is only set up for some aircraft, so its list is shorter.
  const droneOptions = isBarcode ? barcodeDrones() : DRONES;
  const drone = droneOptions.find((item) => item.id === droneId) ?? droneOptions[0];
  const cameraOptions = isBarcode ? barcodeCameras(drone.id) : drone.cameras;
  const camera = cameraOptions.find((item) => item.id === cameraId) ?? cameraOptions[0];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isCreating) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isCreating, onClose]);

  const stepLabel = (key: StepKey) => (key === 'source' && isBarcode ? 'Panels' : STEP_LABELS[key]);

  const chooseType = (next: MissionType) => {
    if (next === type) return;
    // A file parsed for one type is no use to another.
    setType(next);
    // An aircraft that cannot scan barcodes must not stay selected.
    if (next === 'barcode' && !barcodeDrones().some((item) => item.id === droneId)) {
      const fallback = defaultBarcodeAircraft();
      setDroneId(fallback.drone.id);
      setCameraId(fallback.camera.id);
    }
    setSource(next === 'barcode' ? 'import' : null);
    setParsed(null);
    setParseError(null);
    if (!nameTouched) setName('');
  };

  const chooseSource = (next: Source) => {
    setSource(next);
    setParseError(null);
    if (next === 'map') {
      setParsed(null);
      if (!nameTouched) setName('');
    }
  };

  const pickFile = () => {
    if (!type) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.kml,.kmz';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      setIsParsing(true);
      setParseError(null);
      try {
        if (type === 'area') {
          const polygons = await importKMLFile(file);
          if (polygons.length === 0) {
            throw new Error('No polygon found. An area mission needs a closed polygon with at least 3 corners.');
          }
          setParsed({ kind: 'area', fileName: file.name, polygon: polygons[0], polygonCount: polygons.length });
          if (!nameTouched) setName(polygons[0].name.slice(0, NAME_MAX));
        } else if (type === 'waypoint') {
          const route = await importWaypointKMLFile(file);
          if (!route || route.coordinates.length < 2) {
            throw new Error('No route found. A waypoint mission needs at least 2 points.');
          }
          setParsed({ kind: 'waypoint', fileName: file.name, route });
          if (!nameTouched) setName(route.name.slice(0, NAME_MAX));
        } else {
          const layout = await importPanelLayoutFile(file);
          setParsed({ kind: 'barcode', fileName: file.name, layout });
          if (!nameTouched) {
            setName((layout.documentName ?? file.name.replace(/\.(kml|kmz)$/i, '')).slice(0, NAME_MAX));
          }
        }
      } catch (error) {
        setParsed(null);
        setParseError((error as Error)?.message || 'The file could not be read.');
      } finally {
        setIsParsing(false);
      }
    };
    input.click();
  };

  const canContinue =
    currentStep === 'type'
      ? type !== null
      : currentStep === 'source'
        ? source === 'map' || (source === 'import' && parsed !== null)
        : true;
  const trimmedName = name.trim();
  const canCreate =
    type !== null &&
    source !== null &&
    (source === 'map' || parsed !== null) &&
    trimmedName.length > 0 &&
    !isCreating;

  const goNext = () => {
    if (!canContinue || !type) return;
    const next = stepIndex + 1;
    if (steps[next] === 'name' && !trimmedName) {
      const sameType = missions.filter((mission) => mission.missionType === type).length;
      setName(`${DEFAULT_NAMES[type]} ${sameType + 1}`);
    }
    setStep(next);
  };

  const handleCreate = async () => {
    if (!canCreate || !type || !source) return;
    setIsCreating(true);

    const parameters = buildNewMissionParameters(missionDefaults, drone);
    const missionId = addMission({
      name: trimmedName.slice(0, NAME_MAX),
      missionType: type,
      drone,
      camera,
      aoi: null,
      takeoffPoint: null,
      parameters,
      flightLines: [],
      layerSnapshot: layers.map((layer) => ({ ...layer })),
      visible: true,
    });
    // The fixed barcode aircraft must not replace the one picked for other missions.
    if (!isBarcode) setMissionDefaults({ droneId: drone.id, cameraId: camera.id });
    setKmlEditMode(false);

    try {
      if (source === 'map') {
        // Straight into drawing: the panel shows how to finish.
        setDrawAoiMode(type === 'area');
        setDrawWaypointMode(type === 'waypoint');
      } else if (parsed?.kind === 'area') {
        applyAreaPolygon(missionId, parsed.polygon);
      } else if (parsed?.kind === 'waypoint') {
        await applyWaypointRoute(missionId, parsed.route, parameters);
      } else if (parsed?.kind === 'barcode') {
        applyBarcodePanels(missionId, parsed.fileName, parsed.layout);
      }
      onClose();
    } catch (error) {
      console.error('[NewMission] Could not apply the file:', error);
      onClose();
      alert(`The mission was created, but the file could not be applied: ${(error as Error)?.message ?? error}`);
    }
  };

  const fileSummary =
    parsed?.kind === 'area'
      ? `${describePolygon(parsed.polygon)}${parsed.polygonCount > 1 ? ` · first of ${parsed.polygonCount} polygons` : ''}`
      : parsed?.kind === 'waypoint'
        ? `${parsed.route.coordinates.length} waypoints`
        : parsed?.kind === 'barcode'
          ? describePanelLayout(parsed.layout)
          : '';

  const filePicker = (label: string) => (
    <div className="nmw-file">
      <button type="button" className="nmw-btn" onClick={pickFile} disabled={isParsing}>
        {isParsing ? 'Reading…' : parsed ? 'Choose another file…' : label}
      </button>
      {parsed && (
        <div className="nmw-file-ok">
          <strong>✓ {parsed.fileName}</strong>
          <span>{fileSummary}</span>
        </div>
      )}
      {parseError && <div className="nmw-file-error">{parseError}</div>}
    </div>
  );

  return createPortal(
    <div
      className="nmw-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isCreating) onClose();
      }}
    >
      <div className="nmw-dialog" role="dialog" aria-modal="true" aria-labelledby="nmw-title">
        <header className="nmw-head">
          <h2 id="nmw-title">New mission</h2>
          <button type="button" onClick={onClose} disabled={isCreating} aria-label="Close">
            ✕
          </button>
        </header>

        <ol className="nmw-steps">
          {steps.map((key, index) => (
            <li key={key} className={index === stepIndex ? 'is-current' : index < stepIndex ? 'is-done' : ''}>
              <span>{index < stepIndex ? '✓' : index + 1}</span>
              {stepLabel(key)}
            </li>
          ))}
        </ol>

        <div className="nmw-body">
          {currentStep === 'type' && (
            <>
              <p className="nmw-lead">What kind of mission are you planning?</p>
              <div className="nmw-cards cols-3">
                {(
                  [
                    [
                      'area',
                      <AreaIcon key="icon" />,
                      'Grid flight over a polygon for orthophotos and 3D models. Lines and photo points come from overlap and GSD.',
                    ],
                    [
                      'waypoint',
                      <WaypointIcon key="icon" />,
                      'Point-to-point flight for inspections. You place every waypoint and set heading, gimbal and actions per point.',
                    ],
                    [
                      'barcode',
                      <BarcodeIcon key="icon" />,
                      'Scan the barcodes of a solar park’s panels, planned from the park’s panel layout KML.',
                    ],
                  ] as const
                ).map(([key, icon, text]) => (
                  <button
                    key={key}
                    type="button"
                    className={`nmw-card${type === key ? ' is-selected' : ''}`}
                    onClick={() => chooseType(key)}
                    onDoubleClick={() => {
                      chooseType(key);
                      setStep(1);
                    }}
                  >
                    {icon}
                    <strong>{TYPE_LABELS[key]}</strong>
                    <span className="nmw-card-text">{text}</span>
                  </button>
                ))}
              </div>
              <p className="nmw-hint">The type cannot be changed after the mission is created.</p>
            </>
          )}

          {currentStep === 'source' && isBarcode && (
            <>
              <p className="nmw-lead">Import the solar panel layout</p>
              <p className="nmw-hint">
                A KML or KMZ from the park’s digital drawing with one rectangle per panel. Every rectangle is counted
                as a panel; other shapes are skipped.
              </p>
              {filePicker('Choose panel KML…')}
            </>
          )}

          {currentStep === 'source' && !isBarcode && (
            <>
              <p className="nmw-lead">{isArea ? 'Where does the area come from?' : 'Where does the route come from?'}</p>
              <div className="nmw-cards">
                <button
                  type="button"
                  className={`nmw-card${source === 'import' ? ' is-selected' : ''}`}
                  onClick={() => chooseSource('import')}
                >
                  <strong>📂 Import KML / KMZ</strong>
                  <span className="nmw-card-text">
                    {isArea
                      ? 'Use the first polygon in the file as the mapping area.'
                      : 'Use the points and lines in the file, in their order.'}
                  </span>
                </button>
                <button
                  type="button"
                  className={`nmw-card${source === 'map' ? ' is-selected' : ''}`}
                  onClick={() => chooseSource('map')}
                  onDoubleClick={() => {
                    chooseSource('map');
                    setStep(2);
                  }}
                >
                  <strong>✏️ Create on map</strong>
                  <span className="nmw-card-text">
                    {isArea
                      ? 'Draw the polygon after creating: left-click corners, right-click to finish.'
                      : 'Click the waypoints after creating: left-click in flight order, right-click to finish.'}
                  </span>
                </button>
              </div>

              {source === 'import' && filePicker('Choose file…')}
            </>
          )}

          {currentStep === 'aircraft' && (
            <>
              <p className="nmw-lead">Which aircraft will fly it?</p>
              <label className="nmw-field">
                Aircraft
                <select
                  value={drone.id}
                  onChange={(event) => {
                    setDroneId(event.target.value);
                    setCameraId('');
                  }}
                >
                  {droneOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="nmw-field">
                Camera / payload
                <select value={camera.id} onChange={(event) => setCameraId(event.target.value)}>
                  {cameraOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="nmw-hint">
                Sensor {camera.sensorWidth}×{camera.sensorHeight} mm · {camera.imageWidth}×{camera.imageHeight} px ·
                focal {camera.focalLength} mm
              </p>
              <p className="nmw-hint">
                {isArea
                  ? 'The camera sets the GSD, line spacing and photo interval of the grid.'
                  : isBarcode
                    ? 'Only the aircraft set up for barcode scanning are listed. They are written into the DJI export.'
                    : 'The aircraft and payload are written into the DJI export.'}{' '}
                You can still change them later in the Flight Planning panel.
              </p>
            </>
          )}

          {currentStep === 'name' && type && (
            <>
              <label className="nmw-field">
                Mission name
                <input
                  autoFocus
                  value={name}
                  maxLength={NAME_MAX}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameTouched(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleCreate();
                  }}
                />
                <span className="nmw-count">
                  {name.length}/{NAME_MAX}
                </span>
              </label>
              <dl className="nmw-summary">
                <dt>Type</dt>
                <dd>{TYPE_LABELS[type]}</dd>
                <dt>{isBarcode ? 'Panels' : 'Source'}</dt>
                <dd>
                  {source === 'import'
                    ? `${parsed?.fileName ?? ''} · ${fileSummary}`
                    : isArea
                      ? 'Draw the area on the map next'
                      : 'Click the waypoints on the map next'}
                </dd>
                <dt>Aircraft</dt>
                <dd>
                  {drone.name} · {camera.name}
                </dd>
              </dl>
            </>
          )}
        </div>

        <footer className="nmw-foot">
          {stepIndex > 0 ? (
            <button type="button" className="nmw-btn" onClick={() => setStep(stepIndex - 1)} disabled={isCreating}>
              Back
            </button>
          ) : (
            <span />
          )}
          <div className="nmw-foot-right">
            <button type="button" className="nmw-btn" onClick={onClose} disabled={isCreating}>
              Cancel
            </button>
            {!isLastStep ? (
              <button type="button" className="nmw-btn is-primary" onClick={goNext} disabled={!canContinue}>
                Next
              </button>
            ) : (
              <button type="button" className="nmw-btn is-primary" onClick={() => void handleCreate()} disabled={!canCreate}>
                {isCreating ? 'Creating…' : source === 'map' ? 'Create & start drawing' : 'Create mission'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>,
    document.body
  );
};
