/**
 * "Barcode position" pop-up of a Barcode Scan mission.
 *
 * Shows one module to scale, seen from above as on the map, with its measured
 * width and length. The serial-number label (10 × 5 cm) can sit in one of six
 * spots. Because a KML is flat, the user also says which compass side the
 * module's top edge faces and from which end rows are counted; with
 * upside-down installation every next module along a row is turned 180°.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BARCODE_GAP_RESET_M,
  BARCODE_LABEL_DEPTH_M,
  BARCODE_LABEL_WIDTH_M,
  BARCODE_SLOTS,
  COMPASS_SIDE_LABELS,
  DEFAULT_LABEL_INSET_M,
  defaultTopEdge,
  labelInsets,
  slotOffset,
  topEdgeOptions,
  type BarcodeLabelSettings,
  type BarcodeSlot,
  type BarcodeSymbol,
  type CompassSide,
  type PanelSize,
  type PanelStructure,
} from '../lib/barcode-panels';
import { BarcodeSymbolShape } from './BarcodeSymbol';
import './BarcodePositionDialog.css';

const MODULE_VIEW_WIDTH = 300;
const MODULE_VIEW_HEIGHT = 410;
const MODULE_DRAW_HEIGHT = 300;
const MODULE_TOP = 52;

const PATTERN_WIDTH = 300;
const PATTERN_HEIGHT = 64;
const PATTERN_MODULE_HEIGHT = 34;
const PATTERN_GAP_PX = 3;
/** The pattern strip shows a break after this many modules, to demonstrate Reset on gap. */
const PATTERN_BREAK_AFTER = 5;
const PATTERN_MODULES = 9;

const formatCm = (meters: number) => String(Math.round(meters * 1000) / 10);

/** Centimetres entered in a field, or null when empty, not a number or out of range. */
const parseCm = (text: string, maxCm: number) => {
  const value = Number(text.replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= maxCm ? value : null;
};

/** A module outline with the edges an inset is measured from drawn in blue. */
const InsetEdgeIcon = ({ edges }: { edges: 'end' | 'side' }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="4.5" y="1.5" width="7" height="13" rx="1" className="bpd-inset-frame" />
    {edges === 'end' ? (
      <path d="M4.5 1.5h7M4.5 14.5h7" className="bpd-inset-edge" />
    ) : (
      <path d="M4.5 1.5v13M11.5 1.5v13" className="bpd-inset-edge" />
    )}
  </svg>
);

interface BarcodePositionDialogProps {
  structure: PanelStructure;
  panelSize: PanelSize;
  latitude: number;
  initial?: BarcodeLabelSettings;
  barcodeColor: string;
  barcodeSymbol: BarcodeSymbol;
  onCancel: () => void;
  onApply: (settings: BarcodeLabelSettings) => void;
}

export const BarcodePositionDialog = ({
  structure,
  panelSize,
  latitude,
  initial,
  barcodeColor,
  barcodeSymbol,
  onCancel,
  onApply,
}: BarcodePositionDialogProps) => {
  const sides = topEdgeOptions(structure);
  const [slot, setSlot] = useState<BarcodeSlot>(initial?.slot ?? 'bottom-right');
  const [topEdge, setTopEdge] = useState<CompassSide>(() =>
    initial && sides.includes(initial.topEdge) ? initial.topEdge : defaultTopEdge(structure, latitude)
  );
  const [countAlong, setCountAlong] = useState<BarcodeLabelSettings['countAlong']>(initial?.countAlong ?? 'forward');
  const [upsideDown, setUpsideDown] = useState(initial?.upsideDown ?? false);
  const [resetOnGap, setResetOnGap] = useState(initial?.resetOnGap ?? false);
  const [insetEndCm, setInsetEndCm] = useState(() => formatCm(labelInsets(initial ?? {}).fromEndM));
  const [insetSideCm, setInsetSideCm] = useState(() => formatCm(labelInsets(initial ?? {}).fromSideM));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  // Each inset may move the label at most to the middle of the module.
  const maxEndCm = Math.floor(((panelSize.length - BARCODE_LABEL_DEPTH_M) / 2) * 100);
  const maxSideCm = Math.floor(((panelSize.width - BARCODE_LABEL_WIDTH_M) / 2) * 100);
  const endCm = parseCm(insetEndCm, maxEndCm);
  const sideCm = parseCm(insetSideCm, maxSideCm);
  const isInsetValid = endCm !== null && sideCm !== null;
  const insets = {
    fromEndM: endCm !== null ? endCm / 100 : DEFAULT_LABEL_INSET_M,
    fromSideM: sideCm !== null ? sideCm / 100 : DEFAULT_LABEL_INSET_M,
  };

  const forwardCourse = structure.installationBearing;
  const reverseCourse = (structure.installationBearing + 180) % 360;

  const apply = () => {
    if (!isInsetValid) return;
    onApply({
      slot,
      topEdge,
      countAlong,
      upsideDown,
      resetOnGap: upsideDown && resetOnGap,
      insetFromEndM: insets.fromEndM,
      insetFromSideM: insets.fromSideM,
    });
  };

  // --- One module, seen from above, top edge up --------------------------------
  const scale = MODULE_DRAW_HEIGHT / panelSize.length;
  const moduleWidthPx = panelSize.width * scale;
  const moduleX = (MODULE_VIEW_WIDTH - moduleWidthPx) / 2 + 14;
  const moduleY = MODULE_TOP;
  const centerX = moduleX + moduleWidthPx / 2;
  const centerY = moduleY + MODULE_DRAW_HEIGHT / 2;
  const labelWidthPx = BARCODE_LABEL_WIDTH_M * scale;
  const labelDepthPx = BARCODE_LABEL_DEPTH_M * scale;
  const cellColumns = 6;
  const cellRows = 10;

  // --- Pattern along one row -------------------------------------------------
  const patternScale = PATTERN_MODULE_HEIGHT / panelSize.length;
  const patternModuleWidth = panelSize.width * patternScale;
  const patternBreak = 16;
  const patternTotal =
    PATTERN_MODULES * patternModuleWidth + (PATTERN_MODULES - 2) * PATTERN_GAP_PX + patternBreak;
  const patternX0 = (PATTERN_WIDTH - patternTotal) / 2;
  const patternY0 = 22;
  const patternModules = Array.from({ length: PATTERN_MODULES }, (_, index) => {
    const afterBreak = index >= PATTERN_BREAK_AFTER;
    // Position in the sequence; Reset on gap starts counting again after the break.
    const sequence = upsideDown && resetOnGap && afterBreak ? index - PATTERN_BREAK_AFTER : index;
    const x =
      patternX0 +
      index * (patternModuleWidth + PATTERN_GAP_PX) +
      (afterBreak ? patternBreak - PATTERN_GAP_PX : 0);
    return { x, flipped: upsideDown && sequence % 2 === 1 };
  });

  return createPortal(
    <div
      className="bpd-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="bpd-dialog" role="dialog" aria-modal="true" aria-labelledby="bpd-title">
        <header className="bpd-head">
          <h2 id="bpd-title">Barcode position</h2>
          <button type="button" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="bpd-body">
          <figure className="bpd-figure">
            <svg
              className="bpd-module"
              viewBox={`0 0 ${MODULE_VIEW_WIDTH} ${MODULE_VIEW_HEIGHT}`}
              role="group"
              aria-label="Module seen from above; choose the barcode spot"
            >
              {/* Top edge marker */}
              <text x={centerX} y={moduleY - 26} className="bpd-top-text" textAnchor="middle">
                TOP · faces {COMPASS_SIDE_LABELS[topEdge]}
              </text>
              <path
                d={`M${centerX - 6} ${moduleY - 12} L${centerX} ${moduleY - 19} L${centerX + 6} ${moduleY - 12}`}
                className="bpd-top-arrow"
              />

              {/* Module: frame and cells */}
              <rect x={moduleX} y={moduleY} width={moduleWidthPx} height={MODULE_DRAW_HEIGHT} rx="3" className="bpd-frame" />
              {Array.from({ length: cellColumns - 1 }, (_, i) => (
                <line
                  key={`c${i}`}
                  x1={moduleX + ((i + 1) * moduleWidthPx) / cellColumns}
                  x2={moduleX + ((i + 1) * moduleWidthPx) / cellColumns}
                  y1={moduleY + 4}
                  y2={moduleY + MODULE_DRAW_HEIGHT - 4}
                  className="bpd-cell"
                />
              ))}
              {Array.from({ length: cellRows - 1 }, (_, i) => (
                <line
                  key={`r${i}`}
                  x1={moduleX + 4}
                  x2={moduleX + moduleWidthPx - 4}
                  y1={moduleY + ((i + 1) * MODULE_DRAW_HEIGHT) / cellRows}
                  y2={moduleY + ((i + 1) * MODULE_DRAW_HEIGHT) / cellRows}
                  className="bpd-cell"
                />
              ))}

              {/* Barcode spots */}
              {BARCODE_SLOTS.map((option) => {
                const offset = slotOffset(option.id, false, panelSize, insets);
                const x = centerX - offset.alongLeftM * scale;
                const y = centerY - offset.alongTopM * scale;
                const selected = option.id === slot;
                return (
                  <g
                    key={option.id}
                    className={`bpd-slot${selected ? ' is-selected' : ''}`}
                    role="radio"
                    aria-checked={selected}
                    aria-label={option.label}
                    tabIndex={0}
                    onClick={() => setSlot(option.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSlot(option.id);
                      }
                    }}
                  >
                    <title>{option.label}</title>
                    <rect x={x - 22} y={y - 16} width="44" height="32" className="bpd-slot-hit" />
                    <rect
                      x={x - labelWidthPx / 2}
                      y={y - labelDepthPx / 2}
                      width={labelWidthPx}
                      height={labelDepthPx}
                      rx="1.5"
                      className="bpd-slot-mark"
                      style={selected ? { fill: barcodeColor } : undefined}
                    />
                  </g>
                );
              })}

              {/* Length guide */}
              <g className="bpd-guide">
                <line x1={moduleX - 24} x2={moduleX - 24} y1={moduleY} y2={moduleY + MODULE_DRAW_HEIGHT} />
                <line x1={moduleX - 30} x2={moduleX - 18} y1={moduleY} y2={moduleY} />
                <line x1={moduleX - 30} x2={moduleX - 18} y1={moduleY + MODULE_DRAW_HEIGHT} y2={moduleY + MODULE_DRAW_HEIGHT} />
                <text
                  x={moduleX - 30}
                  y={centerY}
                  textAnchor="middle"
                  transform={`rotate(-90 ${moduleX - 30} ${centerY})`}
                  className="bpd-guide-text"
                >
                  {panelSize.length.toFixed(2)} m
                </text>
              </g>

              {/* Width guide */}
              <g className="bpd-guide">
                <line x1={moduleX} x2={moduleX + moduleWidthPx} y1={moduleY + MODULE_DRAW_HEIGHT + 22} y2={moduleY + MODULE_DRAW_HEIGHT + 22} />
                <line x1={moduleX} x2={moduleX} y1={moduleY + MODULE_DRAW_HEIGHT + 16} y2={moduleY + MODULE_DRAW_HEIGHT + 28} />
                <line
                  x1={moduleX + moduleWidthPx}
                  x2={moduleX + moduleWidthPx}
                  y1={moduleY + MODULE_DRAW_HEIGHT + 16}
                  y2={moduleY + MODULE_DRAW_HEIGHT + 28}
                />
                <text x={centerX} y={moduleY + MODULE_DRAW_HEIGHT + 42} textAnchor="middle" className="bpd-guide-text">
                  {panelSize.width.toFixed(2)} m
                </text>
              </g>
            </svg>
            <figcaption>
              Seen from above, as on the map · label {BARCODE_LABEL_WIDTH_M * 100} × {BARCODE_LABEL_DEPTH_M * 100} cm
            </figcaption>
          </figure>

          <div className="bpd-controls">
            <fieldset className="bpd-field">
              <legend>Label spot</legend>
              <div className="bpd-slot-grid" role="radiogroup" aria-label="Label spot">
                {BARCODE_SLOTS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={slot === option.id}
                    className={`bpd-seg${slot === option.id ? ' is-selected' : ''}`}
                    onClick={() => setSlot(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="bpd-field">
              <legend>Top edge faces</legend>
              <div className="bpd-segmented" role="radiogroup" aria-label="Top edge faces">
                {sides.map((side) => (
                  <button
                    key={side}
                    type="button"
                    role="radio"
                    aria-checked={topEdge === side}
                    className={`bpd-seg${topEdge === side ? ' is-selected' : ''}`}
                    onClick={() => setTopEdge(side)}
                  >
                    {COMPASS_SIDE_LABELS[side]}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="bpd-field">
              <legend>Count each row along</legend>
              <div className="bpd-segmented" role="radiogroup" aria-label="Count each row along">
                {(
                  [
                    ['forward', forwardCourse],
                    ['reverse', reverseCourse],
                  ] as const
                ).map(([key, course]) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={countAlong === key}
                    className={`bpd-seg${countAlong === key ? ' is-selected' : ''}`}
                    onClick={() => setCountAlong(key)}
                  >
                    <span className="bpd-course-arrow" style={{ transform: `rotate(${course}deg)` }} aria-hidden="true">
                      ↑
                    </span>
                    {course.toFixed(1)}°
                  </button>
                ))}
              </div>
              <p className="bpd-hint">The first module of every row keeps the chosen spot.</p>
            </fieldset>

            <label className="bpd-check">
              <input type="checkbox" checked={upsideDown} onChange={(e) => setUpsideDown(e.target.checked)} />
              <span>
                <strong>Panels upside-down installed</strong>
                <small>Every next module along a row is turned 180°.</small>
              </span>
            </label>

            <label className={`bpd-check${upsideDown ? '' : ' is-disabled'}`}>
              <input
                type="checkbox"
                checked={upsideDown && resetOnGap}
                disabled={!upsideDown}
                onChange={(e) => setResetOnGap(e.target.checked)}
              />
              <span>
                <strong>Reset on gap</strong>
                <small>After a break wider than {BARCODE_GAP_RESET_M * 100} cm the row starts at the chosen spot again.</small>
              </span>
            </label>

            <fieldset className="bpd-field">
              <legend>Inset from edges</legend>
              <div className="bpd-insets">
                <label
                  className="bpd-inset"
                  title={`Distance from the top or bottom (short) edge to the label, 0–${maxEndCm} cm`}
                >
                  <span className="bpd-inset-name">
                    <InsetEdgeIcon edges="end" />
                    Top / bottom
                  </span>
                  <span className={`bpd-number${endCm !== null ? '' : ' is-invalid'}`}>
                    <input
                      type="number"
                      min="0"
                      max={maxEndCm}
                      step="0.5"
                      value={insetEndCm}
                      aria-label="Inset from the top or bottom edge in centimetres"
                      aria-invalid={endCm === null}
                      onChange={(e) => setInsetEndCm(e.target.value)}
                    />
                    <span>cm</span>
                  </span>
                </label>
                <label
                  className="bpd-inset"
                  title={`Distance from the left or right (long) edge to the label, 0–${maxSideCm} cm`}
                >
                  <span className="bpd-inset-name">
                    <InsetEdgeIcon edges="side" />
                    Left / right
                  </span>
                  <span className={`bpd-number${sideCm !== null ? '' : ' is-invalid'}`}>
                    <input
                      type="number"
                      min="0"
                      max={maxSideCm}
                      step="0.5"
                      value={insetSideCm}
                      aria-label="Inset from the left or right edge in centimetres"
                      aria-invalid={sideCm === null}
                      onChange={(e) => setInsetSideCm(e.target.value)}
                    />
                    <span>cm</span>
                  </span>
                </label>
              </div>
              <p className="bpd-hint">
                {isInsetValid
                  ? 'Measured from the module edge to the edge of the label.'
                  : `Enter 0–${maxEndCm} cm from top/bottom and 0–${maxSideCm} cm from left/right.`}
              </p>
            </fieldset>

            <div className="bpd-pattern">
              <span className="bpd-pattern-title">Row pattern</span>
              <svg viewBox={`0 0 ${PATTERN_WIDTH} ${PATTERN_HEIGHT}`} role="img" aria-label="Barcode spots along one row">
                <text x={patternX0} y="12" className="bpd-pattern-dir">
                  → along {(countAlong === 'forward' ? forwardCourse : reverseCourse).toFixed(1)}°
                </text>
                <text x={patternModules[PATTERN_BREAK_AFTER].x - 8} y="12" textAnchor="middle" className="bpd-pattern-gap">
                  gap
                </text>
                {patternModules.map((module, index) => {
                  const offset = slotOffset(slot, module.flipped, panelSize, insets);
                  const cx = module.x + patternModuleWidth / 2 - offset.alongLeftM * patternScale;
                  const cy = patternY0 + PATTERN_MODULE_HEIGHT / 2 - offset.alongTopM * patternScale;
                  return (
                    <g key={index}>
                      <rect
                        x={module.x}
                        y={patternY0}
                        width={patternModuleWidth}
                        height={PATTERN_MODULE_HEIGHT}
                        rx="1.5"
                        className={`bpd-pattern-module${module.flipped ? ' is-flipped' : ''}`}
                      />
                      <BarcodeSymbolShape
                        symbol={barcodeSymbol}
                        cx={cx}
                        cy={cy}
                        size={6}
                        fill={barcodeColor}
                        stroke="#fff"
                        strokeWidth={0.8}
                      />
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        </div>

        <footer className="bpd-foot">
          <button type="button" className="bpd-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="bpd-btn is-primary" onClick={apply} disabled={!isInsetValid}>
            Apply
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
};
