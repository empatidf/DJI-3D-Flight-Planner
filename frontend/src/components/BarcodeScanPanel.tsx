/**
 * Flight Planning panel for a Barcode Scan mission.
 *
 * Barcode scanning reads the labels of individual solar modules, so planning
 * starts from the park's panel layout rather than from an area or a route. This
 * first part covers the imported layout, its table structure and how it is
 * drawn on the map; the scan flight settings follow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PANEL_STYLE,
  analysePanelStructure,
  decodePanelCorners,
  describePanelSize,
  describeStructure,
  importPanelLayoutFile,
  structureCode,
  type PanelBounds,
  type PanelSize,
  type PanelStructure,
  type PanelStyle,
} from '../lib/barcode-panels';
import { applyBarcodePanels, flyToBounds, formatArea } from '../lib/mission-import';
import { useMissionStore, type Mission } from '../stores/mission-store';
import './BarcodeScanPanel.css';

/** Colour pickers fire on every drag step; each commit rewrites the mission file. */
const STYLE_COMMIT_DELAY_MS = 200;

const PREVIEW_WIDTH = 200;
const PREVIEW_HEIGHT = 78;
const PREVIEW_PAD = 10;
/** Pixels per metre at most, so a single string still reads as a strip. */
const PREVIEW_MAX_SCALE = 14;
/** Drawn wider than the real few centimetres, or modules would merge. */
const PREVIEW_GAP_M = 0.08;

const boundsAreaM2 = (bounds: PanelBounds) => {
  const midLat = ((bounds.north + bounds.south) / 2) * (Math.PI / 180);
  const width = (bounds.east - bounds.west) * 111320 * Math.cos(midLat);
  const height = (bounds.north - bounds.south) * 110574;
  return Math.max(0, width * height);
};

/** One table of the park as it is really built: rows, orientation, module proportions. */
const TablePreview = ({
  style,
  structure,
  panelSize,
}: {
  style: PanelStyle;
  structure: PanelStructure;
  panelSize: PanelSize;
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
    <>
      <svg
        className="panel-preview"
        viewBox={`0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`}
        role="img"
        aria-label={`One table: ${describeStructure(structure)}`}
      >
        <defs>
          <linearGradient id="panel-preview-fade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0.78" stopColor="#44513f" stopOpacity="0" />
            <stop offset="1" stopColor="#44513f" stopOpacity="1" />
          </linearGradient>
        </defs>
        <rect width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} fill="#44513f" />
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
        {truncated && <rect width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} fill="url(#panel-preview-fade)" />}
      </svg>
      <p className="panel-preview-caption">
        One table: {structure.rows} × {structure.modulesPerRow} modules, {structure.orientation}
        {truncated ? ` (first ${columns} shown)` : ''}
      </p>
    </>
  );
};

export const BarcodeScanPanel = ({ mission }: { mission: Mission }) => {
  const barcode = mission.barcode;
  const hasPanels = !!barcode && barcode.panelCount > 0;

  // The panel is keyed by mission id, so this state starts fresh per mission.
  const [style, setStyle] = useState<PanelStyle>(() => ({ ...DEFAULT_PANEL_STYLE, ...barcode?.style }));
  const [status, setStatus] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const missionIdRef = useRef(mission.id);
  const pendingStyleRef = useRef<PanelStyle | null>(null);
  const commitTimerRef = useRef<number | null>(null);

  // Layouts imported before table detection carry no structure: work it out once.
  const structure = useMemo(() => {
    if (!barcode) return null;
    if (barcode.structure !== undefined) return barcode.structure;
    return analysePanelStructure(decodePanelCorners(barcode.corners));
  }, [barcode]);

  useEffect(() => {
    if (!barcode || barcode.structure !== undefined) return;
    const { missions, updateMission } = useMissionStore.getState();
    const current = missions.find((item) => item.id === missionIdRef.current);
    if (current?.barcode && current.barcode.structure === undefined) {
      updateMission(current.id, { barcode: { ...current.barcode, structure } });
    }
  }, [barcode, structure]);

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

  return (
    <>
      <div className="planner-mission-head">
        <span className="mission-type-chip is-barcode">Barcode scan</span>
        <span className="planner-mission-name" title={mission.name}>
          {mission.name}
        </span>
      </div>

      {status && <div className={`status-message ${status.tone}`}>{status.text}</div>}

      {hasPanels && barcode ? (
        <>
          <div className="barcode-counter">
            <span className="barcode-counter-value">{barcode.panelCount.toLocaleString()}</span>
            <span className="barcode-counter-label">panels imported</span>
          </div>

          <div className="mission-stats cols-3">
            <div className="mission-stat">
              <span className="mission-stat-label">Site extent</span>
              <span className="mission-stat-value">{formatArea(boundsAreaM2(barcode.bounds))}</span>
            </div>
            <div className="mission-stat">
              <span className="mission-stat-label">Module size</span>
              <span className="mission-stat-value">{describePanelSize(barcode.panelSize)}</span>
            </div>
            <div className="mission-stat">
              <span className="mission-stat-label">Layout file</span>
              <span className="mission-stat-value" title={barcode.sourceFileName}>
                {barcode.sourceFileName}
              </span>
            </div>
          </div>

          {structure && (
            <div className="mission-stats cols-3 barcode-structure-stats">
              <div className="mission-stat">
                <span className="mission-stat-label">Table layout</span>
                <span className="mission-stat-value" title={describeStructure(structure)}>
                  {structureCode(structure)} · {structure.rows} {structure.rows === 1 ? 'row' : 'rows'}
                </span>
              </div>
              <div className="mission-stat">
                <span className="mission-stat-label">Tables</span>
                <span className="mission-stat-value">{structure.tableCount.toLocaleString()}</span>
              </div>
              <div className="mission-stat">
                <span className="mission-stat-label">Modules per row</span>
                <span className="mission-stat-value">
                  {structure.minModulesPerRow === structure.maxModulesPerRow
                    ? structure.modulesPerRow
                    : `${structure.minModulesPerRow}–${structure.maxModulesPerRow}`}
                </span>
              </div>
            </div>
          )}

          {variantEntries.length > 0 && (
            <p className="barcode-variants">
              {Math.round((1 - (structure?.consistency ?? 1)) * 100)}% of panels are on other tables:{' '}
              {variantEntries.map(([code, tables]) => `${code} × ${tables}`).join(', ')}
            </p>
          )}

          <div className="barcode-actions">
            <button type="button" className="btn-secondary" onClick={() => flyToBounds(barcode.bounds)}>
              🎯 Zoom to panels
            </button>
            <button type="button" className="btn-secondary" onClick={handleImport} disabled={isImporting}>
              {isImporting ? '⏳ Reading…' : '📂 Replace layout'}
            </button>
          </div>
        </>
      ) : (
        <section className="planner-section">
          <div className="next-step">
            <strong>Next: import the panel layout</strong>
            <span>A KML or KMZ with one rectangle per solar panel.</span>
            <div className="next-step-actions">
              <button type="button" className="btn-primary" onClick={handleImport} disabled={isImporting}>
                {isImporting ? '⏳ Reading…' : '📂 Import panel KML'}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="planner-section">
        <h3>Aircraft</h3>
        <div className="barcode-aircraft">
          <span aria-hidden="true">🔒</span>
          <div>
            <strong>{mission.drone.name}</strong> · {mission.camera.name}
            <small>Barcode scanning is planned for this aircraft and camera only.</small>
          </div>
        </div>
      </section>

      {hasPanels && barcode && (
        <section className="planner-section">
          <h3>Panel Display</h3>
          {structure && <TablePreview style={style} structure={structure} panelSize={barcode.panelSize} />}

          <div className="panel-style-row">
            <label className="inline-toggle">
              <input
                type="checkbox"
                checked={style.outlineEnabled}
                onChange={(e) => updateStyle({ outlineEnabled: e.target.checked })}
              />
              Outline
            </label>
            <input
              type="color"
              className="panel-color-input"
              value={style.outlineColor}
              onChange={(e) => updateStyle({ outlineColor: e.target.value })}
              disabled={!style.outlineEnabled}
              aria-label="Outline colour"
            />
          </div>
          <label>
            Outline thickness: {style.outlineWidth} px
            <input
              type="range"
              className="panel-range"
              min="1"
              max="8"
              step="1"
              value={style.outlineWidth}
              onChange={(e) => updateStyle({ outlineWidth: Number(e.target.value) })}
              disabled={!style.outlineEnabled}
            />
          </label>

          <div className="panel-style-divider" />

          <div className="panel-style-row">
            <label className="inline-toggle">
              <input
                type="checkbox"
                checked={style.fillEnabled}
                onChange={(e) => updateStyle({ fillEnabled: e.target.checked })}
              />
              Fill
            </label>
            <input
              type="color"
              className="panel-color-input"
              value={style.fillColor}
              onChange={(e) => updateStyle({ fillColor: e.target.value })}
              disabled={!style.fillEnabled}
              aria-label="Fill colour"
            />
          </div>
          <label>
            Fill opacity: {Math.round(style.fillOpacity * 100)}%
            <input
              type="range"
              className="panel-range"
              min="5"
              max="100"
              step="5"
              value={Math.round(style.fillOpacity * 100)}
              onChange={(e) => updateStyle({ fillOpacity: Number(e.target.value) / 100 })}
              disabled={!style.fillEnabled}
            />
          </label>

          {!style.outlineEnabled && !style.fillEnabled && (
            <div className="status-message warning">Outline and fill are both off — the panels are hidden on the map.</div>
          )}

          <button type="button" className="btn-link" onClick={() => updateStyle({ ...DEFAULT_PANEL_STYLE })}>
            Reset to default
          </button>
        </section>
      )}

      <section className="planner-section">
        <h3>Scan Flight</h3>
        <div className="next-step">
          <strong>Coming next</strong>
          <span>The barcode scan flight settings will be added here.</span>
        </div>
      </section>
    </>
  );
};
