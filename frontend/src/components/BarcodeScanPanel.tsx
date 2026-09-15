/**
 * Flight Planning panel for a Barcode Scan mission.
 *
 * Barcode scanning reads the labels of individual solar modules, so planning
 * starts from the park's panel layout rather than from an area or a route. This
 * part covers the imported layout, its table structure and how it is drawn on
 * the map; the scan flight settings follow.
 *
 * Kept dense on purpose: one overview card for the file, then one row per
 * setting with a shared label column, so later scan settings fit below.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BARCODE_SYMBOLS,
  DEFAULT_PANEL_STYLE,
  DEFAULT_SAFE_JUMP_M,
  DEFAULT_SCAN_ALTITUDE_M,
  DEFAULT_SCAN_SPEED_MPS,
  DEFAULT_SCAN_START_CORNER,
  MAX_TABLE_GAP_M,
  SCAN_START_CORNERS,
  analysePanelStructure,
  numberTablesCached,
  decodePanelCorners,
  describeStructure,
  formatInstallationDirection,
  describeBarcodeLabel,
  importPanelLayoutFile,
  labelInsets,
  slotOffset,
  structureCode,
  type BarcodeLabelSettings,
  type BarcodeScanData,
  type BarcodeScanSettings,
  type PanelBounds,
  type PanelSize,
  type PanelStructure,
  type PanelStyle,
  type ScanStartCorner,
} from '../lib/barcode-panels';
import {
  SAFE_TAKEOFF_DEFAULT_M,
  barcodeRouteKey,
  generateBarcodeScanRoute,
  getBarcodeRoute,
  missingForBarcodeRoute,
  summarizeBarcodeRoute,
} from '../lib/barcode-scan-route';
import { downloadKMZ, exportToDJI } from '../lib/dji-wpml-exporter';
import { applyBarcodePanels, flyToBounds, formatArea } from '../lib/mission-import';
import { useMissionStore, type Mission } from '../stores/mission-store';
import { BarcodePositionDialog } from './BarcodePositionDialog';
import { BarcodeSymbolIcon, BarcodeSymbolShape } from './BarcodeSymbol';
import './BarcodeScanPanel.css';

/** Colour pickers fire on every drag step; each commit rewrites the mission file. */
const STYLE_COMMIT_DELAY_MS = 200;

/** DJI accepts a takeoff security height between 1.2 and 1500 m. */
const SAFE_TAKEOFF_MIN_M = 1.2;
const SAFE_TAKEOFF_MAX_M = 1500;
const SAFE_JUMP_MIN_M = 0;
const SAFE_JUMP_MAX_M = 500;
const SCAN_ALTITUDE_MIN_M = 0;
const SCAN_ALTITUDE_MAX_M = 500;
/** Scan altitude and flight speed are fine decimal values, so they step in tenths. */
const SCAN_ALTITUDE_STEPS = [-1, -0.1, 0.1, 1];
const SCAN_SPEED_MIN_MPS = 0.1;
const SCAN_SPEED_MAX_MPS = 5;
const DRONE_YAW_MIN_DEG = 0;
const DRONE_YAW_MAX_DEG = 360;
const STEPS_DOWN = [-10, -1];
const STEPS_UP = [1, 10];

const formatMeters = (meters: number) => (Number.isInteger(meters) ? String(meters) : meters.toFixed(1));

const formatDistance = (meters: number) =>
  meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;

const NO_TABLES: number[] = [];

const CornerIcon = ({ corner }: { corner: ScanStartCorner }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
    <circle cx={corner.endsWith('left') ? 5 : 11} cy={corner.startsWith('top') ? 5 : 11} r="2.4" fill="currentColor" />
  </svg>
);

const TakeoffIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 14.5s-4.5-4.4-4.5-8a4.5 4.5 0 0 1 9 0c0 3.6-4.5 8-4.5 8Z" fill="currentColor" />
    <circle cx="8" cy="6.5" r="1.7" fill="#fff" />
  </svg>
);
/**
 * One setting row with DJI-style step buttons, −10 −1 [value] +1 +10 by
 * default. The value can also be typed: Enter or leaving the field saves it,
 * Esc discards the edit. Values are clamped to [min, max] and rounded before
 * `onChange` — to 0.1 m by default, or to `fractionDigits` decimals, which also
 * always shows the value as a decimal number (0.8, 1.0, 1.25).
 */
const StepperRow = ({
  id,
  label,
  title,
  value,
  min,
  max,
  onChange,
  steps = [...STEPS_DOWN, ...STEPS_UP],
  fractionDigits,
  highlight = false,
  unit = 'm',
}: {
  id: string;
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  onChange: (meters: number) => void;
  steps?: number[];
  fractionDigits?: number;
  /** Tinted background for the section's key setting. */
  highlight?: boolean;
  unit?: string;
}) => {
  const precision = 10 ** (fractionDigits ?? 1);
  const format = (meters: number) => {
    if (fractionDigits === undefined) return formatMeters(meters);
    // Trailing zeros go, but one decimal stays: 0.80 → 0.8, 1.00 → 1.0, 1.25 → 1.25.
    const trimmed = meters.toFixed(fractionDigits).replace(/0+$/, '');
    return trimmed.endsWith('.') ? `${trimmed}0` : trimmed;
  };
  // Text being typed; null while the field shows the stored value.
  const [draft, setDraft] = useState<string | null>(null);
  const discardOnBlurRef = useRef(false);

  const save = (meters: number) => {
    if (!Number.isFinite(meters)) return;
    const next = Math.min(max, Math.max(min, Math.round(meters * precision) / precision));
    if (next !== value) onChange(next);
  };

  const commitDraft = () => {
    if (discardOnBlurRef.current) {
      discardOnBlurRef.current = false;
    } else if (draft !== null) {
      save(Number(draft.replace(',', '.')));
    }
    setDraft(null);
  };

  const stepButton = (step: number) => (
    <button
      key={step}
      type="button"
      className="bs-step"
      onClick={() => save(value + step)}
      disabled={step < 0 ? value <= min : value >= max}
      aria-label={`${step < 0 ? 'Lower' : 'Raise'} ${label.toLowerCase()} by ${Math.abs(step)} ${unit}`}
    >
      {step > 0 ? `+${step}` : step}
    </button>
  );

  return (
    <div className={`bs-cell${highlight ? ' is-highlight' : ''}`}>
      <label className="bs-cell-label" htmlFor={id} title={title}>
        {label}
      </label>
      <div className="bs-stepper" role="group" aria-label={label}>
        {steps.filter((step) => step < 0).map(stepButton)}
        <span className="bs-step-value">
          <input
            id={id}
            type="text"
            inputMode="decimal"
            value={draft ?? format(value)}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                discardOnBlurRef.current = true;
                e.currentTarget.blur();
              }
            }}
            aria-label={`${label} in ${unit}`}
          />
          <span className="bs-step-unit">{unit}</span>
        </span>
        {steps.filter((step) => step > 0).map(stepButton)}
      </div>
    </div>
  );
};

const PREVIEW_WIDTH = 400;
const PREVIEW_HEIGHT = 52;
const PREVIEW_PAD = 6;
/** Pixels per metre at most, so a single string still reads as a strip. */
const PREVIEW_MAX_SCALE = 14;
/** Drawn wider than the real few centimetres, or modules would merge. */
const PREVIEW_GAP_M = 0.08;

/**
 * Stored structure is usable as is, or null when none could be found. Layouts
 * analysed by an older version — no structure, no stored row endpoints or no
 * string gap tolerance — are analysed again with the defaults.
 */
const isStructureCurrent = (data: BarcodeScanData) =>
  data.structure === null ||
  (data.structure !== undefined &&
    data.structure.installationRow?.start !== undefined &&
    data.structure.tableGapM !== undefined);

const boundsAreaM2 = (bounds: PanelBounds) => {
  const midLat = ((bounds.north + bounds.south) / 2) * (Math.PI / 180);
  const width = (bounds.east - bounds.west) * 111320 * Math.cos(midLat);
  const height = (bounds.north - bounds.south) * 110574;
  return Math.max(0, width * height);
};

const isSameStyle = (a: PanelStyle, b: PanelStyle) => JSON.stringify(a) === JSON.stringify(b);

const TargetIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    <path d="M8 .8v2.6M8 12.6v2.6M.8 8h2.6M12.6 8h2.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const ReplaceIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M9.2 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.3Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
    <path d="M8 12V7.4M5.9 9.4 8 7.3l2.1 2.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const LockIcon = () => (
  <svg className="bs-lock" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="3.5" y="7" width="9" height="7" rx="1.5" fill="currentColor" />
    <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

const IconButton = ({
  label,
  onClick,
  disabled,
  busy,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: ReactNode;
}) => (
  <button
    type="button"
    className={`bs-icon-btn${busy ? ' is-busy' : ''}`}
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={label}
  >
    {children}
  </button>
);

/** One table of the park as it is really built: rows, orientation, module proportions. */
const TablePreview = ({
  style,
  structure,
  panelSize,
  label,
}: {
  style: PanelStyle;
  structure: PanelStructure;
  panelSize: PanelSize;
  label?: BarcodeLabelSettings;
}) => {
  const portrait = structure.orientation === 'portrait';
  const moduleAlongM = portrait ? panelSize.width : panelSize.length;
  const moduleAcrossM = portrait ? panelSize.length : panelSize.width;
  const tableAcrossM = structure.rows * moduleAcrossM + (structure.rows - 1) * PREVIEW_GAP_M;

  const scale = Math.min(PREVIEW_MAX_SCALE, (PREVIEW_HEIGHT - PREVIEW_PAD * 2) / tableAcrossM);
  const alongPx = moduleAlongM * scale;
  const acrossPx = moduleAcrossM * scale;
  const gapPx = Math.max(1, PREVIEW_GAP_M * scale);

  const fits = Math.max(1, Math.floor((PREVIEW_WIDTH - PREVIEW_PAD * 2 + gapPx) / (alongPx + gapPx)));
  const columns = Math.min(structure.modulesPerRow, fits);
  const truncated = columns < structure.modulesPerRow;
  const drawnWidth = columns * alongPx + (columns - 1) * gapPx;
  const drawnHeight = structure.rows * acrossPx + (structure.rows - 1) * gapPx;
  const x0 = truncated ? PREVIEW_PAD : (PREVIEW_WIDTH - drawnWidth) / 2;
  const y0 = (PREVIEW_HEIGHT - drawnHeight) / 2;
  const strokeWidth = Math.min(Math.max(0.6, style.outlineWidth * 0.5), alongPx / 3);

  return (
    <svg
      className="bs-preview"
      viewBox={`0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`}
      role="img"
      aria-label={`One table: ${describeStructure(structure)}, ${structure.modulesPerRow} modules per row`}
    >
      <defs>
        <linearGradient id="bs-preview-fade" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0.86" stopColor="#3f4b3b" stopOpacity="0" />
          <stop offset="1" stopColor="#3f4b3b" stopOpacity="1" />
        </linearGradient>
      </defs>
      <rect width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} fill="#3f4b3b" />
      {Array.from({ length: structure.rows }, (_, row) =>
        Array.from({ length: columns }, (_, column) => (
          <rect
            key={`${row}-${column}`}
            x={x0 + column * (alongPx + gapPx)}
            y={y0 + row * (acrossPx + gapPx)}
            width={alongPx}
            height={acrossPx}
            fill={style.fillEnabled ? style.fillColor : 'none'}
            fillOpacity={style.fillOpacity}
            stroke={style.outlineEnabled ? style.outlineColor : 'none'}
            strokeWidth={strokeWidth}
          />
        ))
      )}
      {label &&
        style.barcodeEnabled &&
        Array.from({ length: structure.rows }, (_, row) =>
          Array.from({ length: columns }, (_, column) => {
            const offset = slotOffset(label.slot, label.upsideDown && column % 2 === 1, panelSize, labelInsets(label));
            // Schematic: the module top points up (portrait) or left (landscape);
            // left is a quarter turn counter-clockwise from top.
            const topX = portrait ? 0 : -1;
            const topY = portrait ? -1 : 0;
            const leftX = topY;
            const leftY = -topX;
            const centreX = x0 + column * (alongPx + gapPx) + alongPx / 2;
            const centreY = y0 + row * (acrossPx + gapPx) + acrossPx / 2;
            return (
              <BarcodeSymbolShape
                key={`barcode-${row}-${column}`}
                symbol={style.barcodeSymbol}
                cx={centreX + (topX * offset.alongTopM + leftX * offset.alongLeftM) * scale}
                cy={centreY + (topY * offset.alongTopM + leftY * offset.alongLeftM) * scale}
                size={Math.max(2.5, Math.min(style.barcodeSize * 0.6, alongPx * 0.7))}
                // The sticker lies along the module's short side: horizontal in portrait, vertical in landscape.
                angle={portrait ? 0 : 90}
                fill={style.barcodeColor}
                stroke="rgba(0, 0, 0, 0.5)"
                strokeWidth={0.6}
              />
            );
          })
        )}
      {truncated && <rect width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} fill="url(#bs-preview-fade)" />}
    </svg>
  );
};

export const BarcodeScanPanel = ({ mission }: { mission: Mission }) => {
  const barcode = mission.barcode;
  const hasPanels = !!barcode && barcode.panelCount > 0;
  const tableGapInputId = useId();

  // The panel is keyed by mission id, so this state starts fresh per mission.
  const [style, setStyle] = useState<PanelStyle>(() => ({ ...DEFAULT_PANEL_STYLE, ...barcode?.style }));
  const [status, setStatus] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [isBarcodeDialogOpen, setIsBarcodeDialogOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [routeMessage, setRouteMessage] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const isSelectingTables = useMissionStore((state) => state.tableSelectMissionId === mission.id);
  const isPickingTakeoff = useMissionStore((state) => state.addTakeoffPointMode);
  const pickedTables = barcode?.scan?.tables ?? NO_TABLES;
  const startCorner = barcode?.scan?.startCorner ?? DEFAULT_SCAN_START_CORNER;
  const safeTakeoffAltitude = mission.parameters.safeTakeoffAltitude ?? SAFE_TAKEOFF_DEFAULT_M;
  const safeJump = barcode?.scan?.safeJumpM ?? DEFAULT_SAFE_JUMP_M;
  const scanAltitude = barcode?.scan?.scanAltitudeM ?? DEFAULT_SCAN_ALTITUDE_M;
  const flightSpeed = barcode?.scan?.flightSpeedMps ?? DEFAULT_SCAN_SPEED_MPS;
  const defaultDroneYaw = barcode?.structure?.installationBearing ?? 0;
  const droneYaw = barcode?.scan?.droneYawDeg ?? defaultDroneYaw;
  const [tableGapInput, setTableGapInput] = useState(() =>
    (barcode?.structure?.tableGapM ?? barcode?.panelSize.width ?? 1).toFixed(2)
  );

  const missionIdRef = useRef(mission.id);
  const pendingStyleRef = useRef<PanelStyle | null>(null);
  const commitTimerRef = useRef<number | null>(null);

  // Older layouts lack parts of the structure: work it out once and store it.
  const structure = useMemo(() => {
    if (!barcode) return null;
    if (isStructureCurrent(barcode)) return barcode.structure ?? null;
    return analysePanelStructure(decodePanelCorners(barcode.corners));
  }, [barcode]);

  useEffect(() => {
    if (!barcode || isStructureCurrent(barcode)) return;
    const { missions, updateMission } = useMissionStore.getState();
    const current = missions.find((item) => item.id === missionIdRef.current);
    if (current?.barcode && !isStructureCurrent(current.barcode)) {
      updateMission(current.id, { barcode: { ...current.barcode, structure } });
    }
  }, [barcode, structure]);

  const isLineShown = useMissionStore((state) => state.installationLineMissionId === mission.id);
  const setInstallationLineMissionId = useMissionStore((state) => state.setInstallationLineMissionId);

  // The line and table picking belong to this mission; leaving the mission ends them.
  useEffect(() => {
    const missionId = missionIdRef.current;
    return () => {
      const store = useMissionStore.getState();
      if (store.installationLineMissionId === missionId) store.setInstallationLineMissionId(null);
      if (store.tableSelectMissionId === missionId) store.setTableSelectMissionId(null);
    };
  }, []);

  // Table numbers only matter once tables are picked; shared with the map through the cache.
  const barcodeCorners = barcode?.corners;
  const hasPickedTables = pickedTables.length > 0;
  const numbering = useMemo(
    () =>
      barcodeCorners && structure && hasPickedTables
        ? numberTablesCached(barcodeCorners, {
            tableGapM: structure.tableGapM,
            installationBearing: structure.installationBearing,
          })
        : null,
    [barcodeCorners, structure, hasPickedTables]
  );
  const tableAt = (number: number) => {
    const table = numbering?.tables[number - 1];
    return table?.number === number ? table : null;
  };
  const pickedBarcodes = pickedTables.reduce((sum, number) => sum + (tableAt(number)?.panels ?? 0), 0);

  const route = getBarcodeRoute(mission);
  const takeoffPoint = mission.takeoffPoint;
  const routeSummary = useMemo(
    () => (route && takeoffPoint ? summarizeBarcodeRoute(route.coordinates, takeoffPoint[2]) : null),
    [route, takeoffPoint]
  );
  const isRouteStale = !!route && barcode?.scan?.routeKey !== barcodeRouteKey(mission);

  const defaultTableGap = (barcode?.panelSize.width ?? 1).toFixed(2);
  const parsedTableGap = Number(tableGapInput.replace(',', '.'));
  const isTableGapValid =
    tableGapInput.trim() !== '' && Number.isFinite(parsedTableGap) && parsedTableGap >= 0 && parsedTableGap <= MAX_TABLE_GAP_M;
  const isTableGapChanged =
    isTableGapValid && !!structure && Math.abs(parsedTableGap - structure.tableGapM) > 0.001;

  /** Detect tables, rows and the installation direction again with the entered tolerance. */
  const handleRecalculate = () => {
    if (!barcode || !isTableGapValid || isRecalculating) return;
    setIsRecalculating(true);
    setStatus(null);

    // Let the button show its busy state before the analysis occupies the main thread.
    window.setTimeout(() => {
      try {
        const next = analysePanelStructure(decodePanelCorners(barcode.corners), { tableGapM: parsedTableGap });
        const { missions, updateMission } = useMissionStore.getState();
        const current = missions.find((item) => item.id === missionIdRef.current);
        const previous = current?.barcode?.structure;
        // Other detection settings can renumber the tables, so a picked table would point elsewhere.
        const clearsPicked =
          !!current?.barcode?.scan?.tables?.length &&
          (previous?.tableGapM !== next?.tableGapM || previous?.installationBearing !== next?.installationBearing);
        if (current?.barcode) {
          updateMission(current.id, {
            barcode: {
              ...current.barcode,
              structure: next,
              ...(clearsPicked ? { scan: { ...current.barcode.scan, tables: [] } } : {}),
            },
          });
        }
        setTableGapInput((next?.tableGapM ?? parsedTableGap).toFixed(2));
        const clearedNote = clearsPicked ? ' Table numbers may have changed, so the picked tables were cleared.' : '';
        setStatus(
          next
            ? {
                tone: 'success',
                text: `Recalculated with a ${next.tableGapM.toFixed(2)} m gap: ${next.tableCount.toLocaleString()} tables, ${describeStructure(next)}.${clearedNote}`,
              }
            : { tone: 'warning', text: `No tables could be detected.${clearedNote}` }
        );
      } catch (error) {
        setStatus({ tone: 'warning', text: `Recalculation failed: ${(error as Error)?.message ?? error}` });
      } finally {
        setIsRecalculating(false);
      }
    }, 30);
  };

  const toggleInstallationLine = () => {
    if (!structure) return;
    if (isLineShown) {
      setInstallationLineMissionId(null);
      return;
    }
    setInstallationLineMissionId(mission.id);
    const { start, end } = structure.installationRow;
    flyToBounds({
      west: Math.min(start[0], end[0]),
      east: Math.max(start[0], end[0]),
      south: Math.min(start[1], end[1]),
      north: Math.max(start[1], end[1]),
    });
  };

  const commitStyle = useCallback(() => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    const next = pendingStyleRef.current;
    pendingStyleRef.current = null;
    if (!next) return;

    const { missions, updateMission } = useMissionStore.getState();
    const current = missions.find((item) => item.id === missionIdRef.current);
    if (!current?.barcode) return;
    updateMission(current.id, { barcode: { ...current.barcode, style: next } });
  }, []);

  // Switching missions or closing the panel must not lose the last change.
  useEffect(() => () => commitStyle(), [commitStyle]);

  const updateStyle = (patch: Partial<PanelStyle>) => {
    const next = { ...style, ...patch };
    setStyle(next);
    pendingStyleRef.current = next;
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = window.setTimeout(commitStyle, STYLE_COMMIT_DELAY_MS);
  };

  /** Stored as the mission's safe takeoff altitude, which the DJI export writes as takeOffSecurityHeight. */
  const saveSafeTakeoffAltitude = (meters: number) => {
    const { missions, updateMission } = useMissionStore.getState();
    const current = missions.find((item) => item.id === missionIdRef.current);
    if (!current || current.parameters.safeTakeoffAltitude === meters) return;
    updateMission(current.id, { parameters: { ...current.parameters, safeTakeoffAltitude: meters } });
  };

  /** Stored with the barcode scan settings of the mission. */
  const updateScan = (patch: Partial<BarcodeScanSettings>) => {
    const { missions, updateMission } = useMissionStore.getState();
    const current = missions.find((item) => item.id === missionIdRef.current);
    if (!current?.barcode) return;
    updateMission(current.id, {
      barcode: { ...current.barcode, scan: { ...current.barcode.scan, ...patch } },
    });
  };

  const saveScanSetting = (key: 'safeJumpM' | 'scanAltitudeM' | 'flightSpeedMps' | 'droneYawDeg', value: number) => {
    if (barcode?.scan?.[key] !== value) updateScan({ [key]: value });
  };

  const toggleTableSelection = () => {
    const store = useMissionStore.getState();
    if (store.tableSelectMissionId === mission.id) {
      store.setTableSelectMissionId(null);
      return;
    }
    store.setAddTakeoffPointMode(false);
    store.setTableSelectMissionId(mission.id);
  };

  const toggleTakeoffPicking = () => {
    const store = useMissionStore.getState();
    store.setTableSelectMissionId(null);
    store.setAddTakeoffPointMode(!store.addTakeoffPointMode);
  };

  const moveTable = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= pickedTables.length) return;
    const next = [...pickedTables];
    [next[index], next[target]] = [next[target], next[index]];
    updateScan({ tables: next });
  };

  const handleGenerateRoute = async () => {
    if (isGenerating) return;
    const store = useMissionStore.getState();
    const current = store.missions.find((item) => item.id === missionIdRef.current);
    if (!current) return;

    const missing = missingForBarcodeRoute(current);
    if (missing.length > 0) {
      setRouteMessage({ tone: 'warning', text: missing.join(' ') });
      // The takeoff point is mandatory: go straight to placing it.
      if (!current.takeoffPoint) {
        store.setTableSelectMissionId(null);
        store.setAddTakeoffPointMode(true);
      }
      return;
    }

    store.setTableSelectMissionId(null);
    setIsGenerating(true);
    setRouteMessage(null);
    try {
      setRouteMessage({ tone: 'success', text: await generateBarcodeScanRoute(current.id) });
    } catch (error) {
      setRouteMessage({ tone: 'warning', text: (error as Error)?.message || 'The route could not be generated.' });
    } finally {
      setIsGenerating(false);
    }
  };

  /** Save the generated route as a DJI Pilot 2 KMZ, flown with the scan flight settings. */
  const handleExportDji = async () => {
    if (isExporting) return;
    const current = useMissionStore.getState().missions.find((item) => item.id === missionIdRef.current);
    if (!current) return;
    const currentRoute = getBarcodeRoute(current);
    if (!currentRoute) {
      setRouteMessage({ tone: 'warning', text: 'Generate the route first.' });
      return;
    }
    if (current.barcode?.scan?.routeKey !== barcodeRouteKey(current)) {
      setRouteMessage({
        tone: 'warning',
        text: 'Settings changed since the route was generated. Generate it again before exporting.',
      });
      return;
    }

    setIsExporting(true);
    try {
      const fileName = current.name || 'barcode-scan';
      downloadKMZ(await exportToDJI(current), fileName);
      setRouteMessage({
        tone: 'success',
        text: `Saved ${fileName}.kmz for DJI Pilot 2: ${currentRoute.coordinates.length.toLocaleString()} waypoints.`,
      });
    } catch (error) {
      setRouteMessage({ tone: 'warning', text: `Export failed: ${(error as Error)?.message || 'unknown error'}` });
    } finally {
      setIsExporting(false);
    }
  };

  const clearRoute = () => {
    const { missions, updateMission } = useMissionStore.getState();
    const current = missions.find((item) => item.id === missionIdRef.current);
    if (!current) return;
    updateMission(current.id, { flightLines: current.flightLines.filter((line) => line !== getBarcodeRoute(current)) });
    setRouteMessage(null);
  };

  const handleApplyBarcodeLabel = (label: BarcodeLabelSettings) => {
    commitStyle();
    const { missions, updateMission } = useMissionStore.getState();
    const current = missions.find((item) => item.id === missionIdRef.current);
    if (current?.barcode) updateMission(current.id, { barcode: { ...current.barcode, label } });
    // Points appear right away; the style commit reads the mission after the label is stored.
    if (!style.barcodeEnabled) updateStyle({ barcodeEnabled: true });
    setIsBarcodeDialogOpen(false);
    setStatus({ tone: 'success', text: `Barcode position set: ${describeBarcodeLabel(label)}.` });
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.kml,.kmz';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      setIsImporting(true);
      setStatus(null);
      try {
        const layout = await importPanelLayoutFile(file);
        commitStyle(); // a re-import keeps the style, including an uncommitted edit
        setStatus({ tone: 'success', text: applyBarcodePanels(mission.id, file.name, layout) });
      } catch (error) {
        setStatus({ tone: 'warning', text: (error as Error)?.message || 'The file could not be read.' });
      } finally {
        setIsImporting(false);
      }
    };
    input.click();
  };

  const variantEntries = structure ? Object.entries(structure.variants) : [];

  const facts: { label: string; value: string; title?: string }[] = barcode
    ? [
        { label: 'Area', value: formatArea(boundsAreaM2(barcode.bounds)), title: 'Site extent' },
        {
          label: 'Module',
          value: `${barcode.panelSize.width.toFixed(2)}×${barcode.panelSize.length.toFixed(2)} m`,
          title: 'Module size (short × long side)',
        },
        ...(structure
          ? [
              {
                label: 'Layout',
                value: `${structureCode(structure)} · ${structure.rows} ${structure.rows === 1 ? 'row' : 'rows'}`,
                title: describeStructure(structure),
              },
              { label: 'Tables', value: structure.tableCount.toLocaleString() },
              {
                label: 'Per row',
                value:
                  structure.minModulesPerRow === structure.maxModulesPerRow
                    ? String(structure.modulesPerRow)
                    : `${structure.minModulesPerRow}–${structure.maxModulesPerRow}`,
                title: 'Modules per row',
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className="bs-panel">
      <div className="planner-mission-head">
        <span className="mission-type-chip is-barcode">Barcode scan</span>
        <span className="planner-mission-name" title={mission.name}>
          {mission.name}
        </span>
      </div>

      {status && <div className={`status-message ${status.tone} bs-status`}>{status.text}</div>}

      {hasPanels && barcode ? (
        <section className="bs-overview" aria-label="Panel layout">
          <div className="bs-overview-head">
            <p className="bs-count">
              <span className="bs-count-value">{barcode.panelCount.toLocaleString()}</span>
              <span className="bs-count-label">panels</span>
            </p>
            <span className="bs-file" title={`Layout file: ${barcode.sourceFileName}`}>
              {barcode.sourceFileName}
            </span>
            <div className="bs-tools">
              <IconButton label="Zoom to panels" onClick={() => flyToBounds(barcode.bounds)}>
                <TargetIcon />
              </IconButton>
              <IconButton
                label={isImporting ? 'Reading the layout…' : 'Replace layout'}
                onClick={handleImport}
                disabled={isImporting}
                busy={isImporting}
              >
                <ReplaceIcon />
              </IconButton>
            </div>
          </div>

          <dl className="bs-facts">
            {facts.map((fact) => (
              <div key={fact.label} className="bs-fact" title={fact.title}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>

          {structure && (
            <div
              className="bs-card-row"
              title="Tables are numbered line by line from the top left of the map, following the installation direction."
            >
              <svg className="barcode-direction-icon" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.5" y="3" width="5.5" height="4" rx="0.8" fill="currentColor" />
                <rect x="9" y="3" width="5.5" height="4" rx="0.8" fill="currentColor" />
                <rect x="1.5" y="9" width="5.5" height="4" rx="0.8" fill="currentColor" />
                <rect x="9" y="9" width="5.5" height="4" rx="0.8" fill="currentColor" />
              </svg>
              <span className="barcode-direction-label">Tables</span>
              <span className="barcode-direction-value">1–{structure.tableCount.toLocaleString()}</span>
              <span className="barcode-direction-note bs-card-row-note">numbered from top left</span>
              <button
                type="button"
                role="switch"
                aria-checked={style.tableNamesEnabled}
                className={`bs-switch${style.tableNamesEnabled ? ' is-on' : ''}`}
                onClick={() => updateStyle({ tableNamesEnabled: !style.tableNamesEnabled })}
                title="Write the table numbers at the table centres on the map"
              >
                <span>Show names</span>
                <span className="bs-switch-track" aria-hidden="true">
                  <span className="bs-switch-knob" />
                </span>
              </button>
            </div>
          )}

          {structure && (
            <button
              type="button"
              className={`barcode-direction${isLineShown ? ' is-active' : ''}`}
              onClick={toggleInstallationLine}
              aria-pressed={isLineShown}
              aria-label={`Installation direction ${formatInstallationDirection(structure.installationBearing)}, measured on ${structure.installationRow.modules} modules over ${structure.installationRow.lengthM.toFixed(1)} m. ${isLineShown ? 'Hide' : 'Show'} the line on the map.`}
              title={
                `Installation direction, measured between the centres of the first and last module of the longest row ` +
                `(${structure.installationRow.modules} modules, ${structure.installationRow.lengthM.toFixed(1)} m). ` +
                `Both courses describe the same line. Click to ${isLineShown ? 'hide' : 'show'} it on the map.`
              }
            >
              <svg className="barcode-direction-icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 12.5 13 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="3" cy="12.5" r="2" fill="currentColor" />
                <circle cx="13" cy="3.5" r="2" fill="currentColor" />
              </svg>
              <span className="barcode-direction-label">Direction</span>
              <span className="barcode-direction-value">
                {formatInstallationDirection(structure.installationBearing)}
              </span>
              <span className="barcode-direction-note">
                {structure.installationRow.modules} mod · {structure.installationRow.lengthM.toFixed(1)} m
              </span>
              <span className="barcode-direction-switch" aria-hidden="true">
                <span className="barcode-direction-knob" />
              </span>
            </button>
          )}
        </section>
      ) : (
        <div className="next-step bs-empty">
          <strong>Next: import the panel layout</strong>
          <span>A KML or KMZ with one rectangle per solar panel.</span>
          <div className="next-step-actions">
            <button type="button" className="btn-primary" onClick={handleImport} disabled={isImporting}>
              {isImporting ? 'Reading…' : 'Import panel KML'}
            </button>
          </div>
        </div>
      )}

      {variantEntries.length > 0 && (
        <p className="bs-note is-warning">
          {Math.round((1 - (structure?.consistency ?? 1)) * 100)}% of panels are on other tables:{' '}
          {variantEntries.map(([code, tables]) => `${code} × ${tables}`).join(', ')}
        </p>
      )}

      <section className="bs-group" aria-labelledby={`${tableGapInputId}-setup`}>
        <h3 className="bs-group-title" id={`${tableGapInputId}-setup`}>
          Setup
        </h3>
        <div className="bs-rows">
          <div className="bs-row">
            <span className="bs-row-label">Aircraft</span>
            <span className="bs-aircraft" title="Barcode scanning is planned for this aircraft and camera only.">
              <LockIcon />
              <strong>{mission.drone.name}</strong>
              <span className="bs-aircraft-camera">· {mission.camera.name}</span>
            </span>
          </div>

          {hasPanels && barcode && (
            <div className="bs-row">
              <label
                className="bs-row-label"
                htmlFor={tableGapInputId}
                title="Modules in one line with a gap up to this size stay one table."
              >
                String gap
              </label>
              <div className="bs-row-controls">
                <span className={`bs-number${isTableGapValid ? '' : ' is-invalid'}`}>
                  <input
                    id={tableGapInputId}
                    type="number"
                    min="0"
                    max={MAX_TABLE_GAP_M}
                    step="0.05"
                    value={tableGapInput}
                    aria-invalid={!isTableGapValid}
                    title={isTableGapValid ? 'String gap tolerance in metres' : `Enter a gap between 0 and ${MAX_TABLE_GAP_M} m`}
                    onChange={(e) => setTableGapInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRecalculate();
                    }}
                  />
                  <span className="bs-unit">m</span>
                </span>
                <button
                  type="button"
                  className="bs-text-btn"
                  onClick={() => setTableGapInput(defaultTableGap)}
                  disabled={tableGapInput === defaultTableGap}
                  title={`Use one module width (${defaultTableGap} m)`}
                >
                  Default
                </button>
                <button
                  type="button"
                  className={`bs-action${isTableGapChanged ? ' is-pending' : ''}`}
                  onClick={handleRecalculate}
                  disabled={!isTableGapValid || isRecalculating}
                  title={
                    isTableGapChanged
                      ? 'The gap changed: detect tables, rows and the direction again'
                      : 'Detect tables, rows and the direction again'
                  }
                >
                  {isRecalculating ? 'Working…' : 'Recalculate'}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {hasPanels && barcode && (
        <section className="bs-group" aria-labelledby={`${tableGapInputId}-display`}>
          <div className="bs-group-head">
            <h3 className="bs-group-title" id={`${tableGapInputId}-display`}>
              Panel display
            </h3>
            {structure && (
              <span className="bs-group-meta">
                One table · {structure.rows} × {structure.modulesPerRow} modules
              </span>
            )}
            <button
              type="button"
              className="bs-text-btn"
              onClick={() => updateStyle({ ...DEFAULT_PANEL_STYLE })}
              disabled={isSameStyle(style, DEFAULT_PANEL_STYLE)}
            >
              Reset
            </button>
          </div>

          {structure && (
            <div className="bs-preview-wrap">
              <TablePreview style={style} structure={structure} panelSize={barcode.panelSize} label={barcode.label} />
              <button
                type="button"
                className="bs-preview-action"
                onClick={() => setIsBarcodeDialogOpen(true)}
                title="Choose where the barcode label sits on each module"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2 3v10M4.5 3v10M6 3v10M8.5 3v10M11 3v10M12.5 3v10M14 3v10" stroke="currentColor" strokeWidth="1.1" />
                </svg>
                Barcode position
              </button>
            </div>
          )}

          <div className="bs-grid">
            <div className={`bs-style${style.outlineEnabled ? '' : ' is-off'}`}>
              <label className="bs-style-check">
                <input
                  type="checkbox"
                  checked={style.outlineEnabled}
                  onChange={(e) => updateStyle({ outlineEnabled: e.target.checked })}
                />
                Outline
              </label>
              <input
                type="color"
                className="bs-swatch"
                value={style.outlineColor}
                onChange={(e) => updateStyle({ outlineColor: e.target.value })}
                disabled={!style.outlineEnabled}
                aria-label="Outline colour"
              />
              <input
                type="range"
                className="bs-range"
                min="1"
                max="8"
                step="1"
                value={style.outlineWidth}
                onChange={(e) => updateStyle({ outlineWidth: Number(e.target.value) })}
                disabled={!style.outlineEnabled}
                aria-label="Outline thickness"
              />
              <output className="bs-value">{style.outlineWidth} px</output>
            </div>

            <div className={`bs-style${style.fillEnabled ? '' : ' is-off'}`}>
              <label className="bs-style-check">
                <input
                  type="checkbox"
                  checked={style.fillEnabled}
                  onChange={(e) => updateStyle({ fillEnabled: e.target.checked })}
                />
                Fill
              </label>
              <input
                type="color"
                className="bs-swatch"
                value={style.fillColor}
                onChange={(e) => updateStyle({ fillColor: e.target.value })}
                disabled={!style.fillEnabled}
                aria-label="Fill colour"
              />
              <input
                type="range"
                className="bs-range"
                min="5"
                max="100"
                step="5"
                value={Math.round(style.fillOpacity * 100)}
                onChange={(e) => updateStyle({ fillOpacity: Number(e.target.value) / 100 })}
                disabled={!style.fillEnabled}
                aria-label="Fill opacity"
              />
              <output className="bs-value">{Math.round(style.fillOpacity * 100)} %</output>
            </div>

            <div className={`bs-style is-wide${barcode.label && !style.barcodeEnabled ? ' is-off' : ''}`}>
              <label className="bs-style-check" title={barcode.label ? describeBarcodeLabel(barcode.label) : undefined}>
                <input
                  type="checkbox"
                  checked={!!barcode.label && style.barcodeEnabled}
                  disabled={!barcode.label}
                  onChange={(e) => updateStyle({ barcodeEnabled: e.target.checked })}
                />
                Barcode
              </label>
              {barcode.label ? (
                <>
                  <div className="bs-symbols" role="radiogroup" aria-label="Barcode symbol">
                    {BARCODE_SYMBOLS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={style.barcodeSymbol === option.id}
                        aria-label={option.label}
                        title={option.label}
                        className={`bs-symbol${style.barcodeSymbol === option.id ? ' is-selected' : ''}`}
                        onClick={() => updateStyle({ barcodeSymbol: option.id })}
                        disabled={!style.barcodeEnabled}
                      >
                        <BarcodeSymbolIcon symbol={option.id} />
                      </button>
                    ))}
                  </div>
                  <input
                    type="color"
                    className="bs-swatch"
                    value={style.barcodeColor}
                    onChange={(e) => updateStyle({ barcodeColor: e.target.value })}
                    disabled={!style.barcodeEnabled}
                    aria-label="Barcode point colour"
                  />
                  <input
                    type="range"
                    className="bs-range"
                    min="2"
                    max="12"
                    step="1"
                    value={style.barcodeSize}
                    onChange={(e) => updateStyle({ barcodeSize: Number(e.target.value) })}
                    disabled={!style.barcodeEnabled}
                    aria-label="Barcode point size"
                  />
                  <output className="bs-value">{style.barcodeSize} px</output>
                </>
              ) : (
                <>
                  <span className="bs-muted">Position not set</span>
                  <button type="button" className="bs-text-btn bs-push" onClick={() => setIsBarcodeDialogOpen(true)}>
                    Set position
                  </button>
                </>
              )}
            </div>
          </div>

          {!style.outlineEnabled && !style.fillEnabled && !(style.barcodeEnabled && barcode.label) && (
            <p className="bs-note is-warning">Outline, fill and barcode points are off — nothing is drawn on the map.</p>
          )}
        </section>
      )}

      <section className="bs-group" aria-labelledby={`${tableGapInputId}-flight`}>
        <h3 className="bs-group-title" id={`${tableGapInputId}-flight`}>
          Scan flight
        </h3>
        <div className="bs-grid">
          {barcode && (
            <>
              <StepperRow
                id={`${tableGapInputId}-scan-altitude`}
                label="Scan altitude"
                title={`Altitude of the barcode scan flight (${SCAN_ALTITUDE_MIN_M}–${SCAN_ALTITUDE_MAX_M} m, default ${DEFAULT_SCAN_ALTITUDE_M} m).`}
                value={scanAltitude}
                min={SCAN_ALTITUDE_MIN_M}
                max={SCAN_ALTITUDE_MAX_M}
                steps={SCAN_ALTITUDE_STEPS}
                fractionDigits={2}
                highlight
                onChange={(meters) => saveScanSetting('scanAltitudeM', meters)}
              />
              <StepperRow
                id={`${tableGapInputId}-jump`}
                label="Safe jump"
                title={`Safe jump height for the barcode scan flight (${SAFE_JUMP_MIN_M}–${SAFE_JUMP_MAX_M} m, default ${DEFAULT_SAFE_JUMP_M} m).`}
                value={safeJump}
                min={SAFE_JUMP_MIN_M}
                max={SAFE_JUMP_MAX_M}
                onChange={(meters) => saveScanSetting('safeJumpM', meters)}
              />
            </>
          )}

          <StepperRow
            id={`${tableGapInputId}-takeoff`}
            label="Safe takeoff"
            title={`After takeoff the aircraft climbs to this height before flying to the first waypoint. Exported to DJI as the takeoff security height (${SAFE_TAKEOFF_MIN_M}–${SAFE_TAKEOFF_MAX_M} m).`}
            value={safeTakeoffAltitude}
            min={SAFE_TAKEOFF_MIN_M}
            max={SAFE_TAKEOFF_MAX_M}
            onChange={saveSafeTakeoffAltitude}
          />

          {barcode && (
            <StepperRow
              id={`${tableGapInputId}-speed`}
              label="Flight speed"
              title={`Speed of the barcode scan flight (${SCAN_SPEED_MIN_MPS}–${SCAN_SPEED_MAX_MPS} m/s, default ${DEFAULT_SCAN_SPEED_MPS} m/s).`}
              value={flightSpeed}
              min={SCAN_SPEED_MIN_MPS}
              max={SCAN_SPEED_MAX_MPS}
              steps={SCAN_ALTITUDE_STEPS}
              fractionDigits={2}
              unit="m/s"
              onChange={(speed) => saveScanSetting('flightSpeedMps', speed)}
            />
          )}

          {barcode && (
            <StepperRow
              id={`${tableGapInputId}-yaw`}
              label="Drone yaw"
              title={`Aircraft heading during the whole scan, degrees clockwise from north (0–360). Default: the installation direction of the panels, ${defaultDroneYaw.toFixed(1)}°.`}
              value={droneYaw}
              min={DRONE_YAW_MIN_DEG}
              max={DRONE_YAW_MAX_DEG}
              fractionDigits={1}
              unit="°"
              onChange={(degrees) => saveScanSetting('droneYawDeg', degrees)}
            />
          )}

          <div className={`bs-cell${takeoffPoint ? '' : ' is-warning'}`}>
            <span
              className="bs-cell-label"
              title="Required. All route heights are measured from the ground altitude at the takeoff point."
            >
              Takeoff point
            </span>
            <div className="bs-cell-line">
              {takeoffPoint ? (
                <span className="bs-takeoff is-set" title="Set. Route heights are measured from this ground altitude.">
                  <TakeoffIcon />
                  Ground {takeoffPoint[2].toFixed(1)} m
                </span>
              ) : (
                <span className="bs-takeoff is-missing">
                  <TakeoffIcon />
                  Required
                </span>
              )}
              <button
                type="button"
                className={`bs-action${isPickingTakeoff ? ' is-pending' : ''}`}
                onClick={toggleTakeoffPicking}
                aria-pressed={isPickingTakeoff}
              >
                {isPickingTakeoff ? 'Click map…' : takeoffPoint ? 'Change' : 'Set on map'}
              </button>
            </div>
          </div>
        </div>

        {hasPanels && barcode && structure && (
          <div className="bs-rows">
            <div className="bs-row bs-tables-head">
              <span className="bs-row-label">Tables</span>
              <span className="bs-grow bs-muted">
                {hasPickedTables
                  ? `${pickedTables.length} · ${pickedBarcodes.toLocaleString()} barcodes`
                  : 'None picked'}
              </span>
              <div
                className="bs-symbols bs-corners"
                role="radiogroup"
                aria-label="Start corner of the first table"
              >
                {SCAN_START_CORNERS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={startCorner === option.id}
                    aria-label={`Start at ${option.label.toLowerCase()}`}
                    title={`Start corner of the first table: ${option.label.toLowerCase()} (north-up map)`}
                    className={`bs-symbol${startCorner === option.id ? ' is-selected' : ''}`}
                    onClick={() => updateScan({ startCorner: option.id })}
                  >
                    <CornerIcon corner={option.id} />
                  </button>
                ))}
              </div>
              {hasPickedTables && (
                <button type="button" className="bs-text-btn" onClick={() => updateScan({ tables: [] })}>
                  Clear
                </button>
              )}
              <button
                type="button"
                className={`bs-action${isSelectingTables ? ' is-picking' : ''}`}
                onClick={toggleTableSelection}
                aria-pressed={isSelectingTables}
              >
                {isSelectingTables ? 'Done' : '+ Add tables'}
              </button>
            </div>

            {isSelectingTables && (
              <p className="bs-pick-hint">
                Click tables on the map in flight order; click a picked table again to remove it. Esc or Done
                finishes.{style.tableNamesEnabled ? '' : ' Switch on Show names to see the numbers.'}
              </p>
            )}

            {hasPickedTables && (
              <ol className="bs-chips" aria-label="Picked tables in flight order">
                {pickedTables.map((number, index) => {
                  const table = tableAt(number);
                  return (
                    <li
                      key={number}
                      className={`bs-chip${table ? '' : ' is-missing'}`}
                      title={
                        table
                          ? `Table ${number}: ${table.panels} barcodes, no. ${index + 1} in flight order`
                          : `Table ${number} was not found`
                      }
                    >
                      <span className="bs-chip-order">{index + 1}</span>
                      <span className="bs-chip-name">{number}</span>
                      <button
                        type="button"
                        className="bs-chip-btn"
                        onClick={() => moveTable(index, -1)}
                        disabled={index === 0}
                        aria-label={`Fly table ${number} earlier`}
                      >
                        ‹
                      </button>
                      <button
                        type="button"
                        className="bs-chip-btn"
                        onClick={() => moveTable(index, 1)}
                        disabled={index === pickedTables.length - 1}
                        aria-label={`Fly table ${number} later`}
                      >
                        ›
                      </button>
                      <button
                        type="button"
                        className="bs-chip-btn is-remove"
                        onClick={() => updateScan({ tables: pickedTables.filter((item) => item !== number) })}
                        aria-label={`Remove table ${number}`}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}

        {hasPanels && barcode && (
          <div className="bs-route">
            <div className="bs-route-actions">
              <button type="button" className="bs-generate" onClick={handleGenerateRoute} disabled={isGenerating}>
                {isGenerating ? 'Sampling terrain…' : route ? 'Generate route again' : 'Generate route'}
              </button>
              <button
                type="button"
                className="bs-export"
                onClick={handleExportDji}
                disabled={!route || isRouteStale || isGenerating || isExporting}
                title={
                  !route
                    ? 'Generate the route first'
                    : isRouteStale
                      ? 'Settings changed: generate the route again first'
                      : 'Save the route as a KMZ file for DJI Pilot 2'
                }
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M8 2v8M4.8 7 8 10.2 11.2 7M2.5 12.5v1h11v-1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {isExporting ? 'Exporting…' : 'Export DJI Pilot 2'}
              </button>
            </div>

            {route && routeSummary && (
              <div className={`bs-route-summary${isRouteStale ? ' is-stale' : ''}`}>
                <span>
                  <strong>{routeSummary.waypoints.toLocaleString()}</strong> waypoints
                </span>
                <span>
                  <strong>{formatDistance(routeSummary.distanceM)}</strong>
                </span>
                <span title="Lowest and highest waypoint above the takeoff point's ground">
                  <strong>
                    {routeSummary.minHeightM.toFixed(1)}–{routeSummary.maxHeightM.toFixed(1)} m
                  </strong>{' '}
                  above takeoff
                </span>
                <button type="button" className="bs-text-btn bs-push" onClick={clearRoute}>
                  Clear
                </button>
              </div>
            )}

            {isRouteStale && (
              <p className="bs-note is-warning">Settings changed since the route was generated. Generate it again.</p>
            )}
            {routeMessage && (
              <p className={`bs-note${routeMessage.tone === 'warning' ? ' is-warning' : ''}`}>{routeMessage.text}</p>
            )}
          </div>
        )}
      </section>

      {isBarcodeDialogOpen && barcode && structure && (
        <BarcodePositionDialog
          structure={structure}
          panelSize={barcode.panelSize}
          latitude={(barcode.bounds.north + barcode.bounds.south) / 2}
          initial={barcode.label}
          barcodeColor={style.barcodeColor}
          barcodeSymbol={style.barcodeSymbol}
          onCancel={() => setIsBarcodeDialogOpen(false)}
          onApply={handleApplyBarcodeLabel}
        />
      )}
    </div>
  );
};
