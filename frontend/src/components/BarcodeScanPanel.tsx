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
  MAX_TABLE_GAP_M,
  analysePanelStructure,
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
  type PanelBounds,
  type PanelSize,
  type PanelStructure,
  type PanelStyle,
} from '../lib/barcode-panels';
import { applyBarcodePanels, flyToBounds, formatArea } from '../lib/mission-import';
import { useMissionStore, type Mission } from '../stores/mission-store';
import { BarcodePositionDialog } from './BarcodePositionDialog';
import { BarcodeSymbolIcon, BarcodeSymbolShape } from './BarcodeSymbol';
import './BarcodeScanPanel.css';

/** Colour pickers fire on every drag step; each commit rewrites the mission file. */
const STYLE_COMMIT_DELAY_MS = 200;

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

  // The line belongs to this mission; leaving the mission hides it.
  useEffect(() => {
    const missionId = missionIdRef.current;
    return () => {
      const store = useMissionStore.getState();
      if (store.installationLineMissionId === missionId) store.setInstallationLineMissionId(null);
    };
  }, []);

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
        if (current?.barcode) updateMission(current.id, { barcode: { ...current.barcode, structure: next } });
        setTableGapInput((next?.tableGapM ?? parsedTableGap).toFixed(2));
        setStatus(
          next
            ? {
                tone: 'success',
                text: `Recalculated with a ${next.tableGapM.toFixed(2)} m gap: ${next.tableCount.toLocaleString()} tables, ${describeStructure(next)}.`,
              }
            : { tone: 'warning', text: 'No tables could be detected.' }
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

          <div className="bs-rows">
            <div className={`bs-row${style.outlineEnabled ? '' : ' is-off'}`}>
              <label className="bs-row-label bs-check">
                <input
                  type="checkbox"
                  checked={style.outlineEnabled}
                  onChange={(e) => updateStyle({ outlineEnabled: e.target.checked })}
                />
                Outline
              </label>
              <div className="bs-row-controls">
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
            </div>

            <div className={`bs-row${style.fillEnabled ? '' : ' is-off'}`}>
              <label className="bs-row-label bs-check">
                <input
                  type="checkbox"
                  checked={style.fillEnabled}
                  onChange={(e) => updateStyle({ fillEnabled: e.target.checked })}
                />
                Fill
              </label>
              <div className="bs-row-controls">
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
            </div>

            <div className={`bs-row${barcode.label && !style.barcodeEnabled ? ' is-off' : ''}`}>
              <label className="bs-row-label bs-check" title={barcode.label ? describeBarcodeLabel(barcode.label) : undefined}>
                <input
                  type="checkbox"
                  checked={!!barcode.label && style.barcodeEnabled}
                  disabled={!barcode.label}
                  onChange={(e) => updateStyle({ barcodeEnabled: e.target.checked })}
                />
                Barcode
              </label>
              {barcode.label ? (
                <div className="bs-row-controls">
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
                </div>
              ) : (
                <div className="bs-row-controls">
                  <span className="bs-muted">Position not set</span>
                  <button type="button" className="bs-text-btn bs-push" onClick={() => setIsBarcodeDialogOpen(true)}>
                    Set position
                  </button>
                </div>
              )}
            </div>
          </div>

          {!style.outlineEnabled && !style.fillEnabled && !(style.barcodeEnabled && barcode.label) && (
            <p className="bs-note is-warning">Outline, fill and barcode points are off — nothing is drawn on the map.</p>
          )}
        </section>
      )}

      <section className="bs-group">
        <h3 className="bs-group-title">Scan flight</h3>
        <p className="bs-placeholder">Scan flight settings will be added here.</p>
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
