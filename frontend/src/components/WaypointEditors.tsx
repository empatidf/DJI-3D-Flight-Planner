/**
 * Compact editors for single-waypoint settings and DJI WPML actions.
 *
 * Shared between the map (edit mode, right-click menu) and the "Selected
 * Waypoint Parameters" area of the Flight Planning panel, so a value changed in
 * one place is immediately visible in the other.
 *
 * Altitudes are edited as DJI **relative** height (metres above the take-off
 * point), which is what waypoint missions are flown with. The absolute/MSL value
 * stored in the coordinates is derived from it.
 */

import { useEffect, useState } from 'react';
import { useMissionStore, waypointKey } from '../stores/mission-store';
import type { Mission } from '../stores/mission-store';
import { getTerrainHeightAtDegrees } from '../lib/terrain-sampler';
import {
  ACTION_CATEGORY,
  contextualizeAction,
  createWaypointAction,
  describeAction,
  getActionDef,
  getActionsForContext,
  getVisibleParams,
  resolvePayloadContext,
  type ActionCategory,
  type PayloadContext,
  type WaypointAction,
  type WpmlActionParamDef,
  type WpmlActionFunc,
  type WpmlParamValue,
} from '../lib/wpml-actions';
import './WaypointEditors.css';

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const parseOptional = (raw: string): number | undefined => {
  if (raw.trim() === '') return undefined;
  const parsed = Number(raw.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const absoluteAltitude = (coordinates: number[][], index: number, missionAltitude: number): number => {
  const value = coordinates[index]?.[2];
  return Number.isFinite(value) ? value : missionAltitude;
};

/** DJI relative height: metres above the take-off point. */
const relativeHeight = (coordinates: number[][], index: number, missionAltitude: number): number =>
  missionAltitude +
  (absoluteAltitude(coordinates, index, missionAltitude) - absoluteAltitude(coordinates, 0, missionAltitude));

const payloadContextOf = (mission: Mission | undefined): PayloadContext | null =>
  mission ? resolvePayloadContext(mission.drone, mission.camera) : null;

/**
 * Write a relative height back to the mission.
 *
 * Waypoint 1 *is* the height reference, so its relative height is the mission
 * altitude — editing it shifts the whole route instead of a single point.
 */
const useRelativeHeightWriter = (missionId: string) => {
  const setWaypointAltitude = useMissionStore((state) => state.setWaypointAltitude);
  const updateMission = useMissionStore((state) => state.updateMission);

  return (mission: Mission, index: number, relative: number) => {
    const coordinates = mission.flightLines?.[0]?.coordinates ?? [];
    const missionAltitude = mission.parameters.altitude;

    if (index === 0) {
      updateMission(missionId, { parameters: { ...mission.parameters, altitude: relative } });
      return;
    }

    const first = absoluteAltitude(coordinates, 0, missionAltitude);
    setWaypointAltitude(missionId, index, first + (relative - missionAltitude));
  };
};

/* ------------------------------------------------------------------ */
/* Generic parameter field                                             */
/* ------------------------------------------------------------------ */

const ParamField = ({
  param,
  value,
  onChange,
}: {
  param: WpmlActionParamDef;
  value: WpmlParamValue;
  onChange: (next: WpmlParamValue) => void;
}) => {
  const label = param.unit ? `${param.label} (${param.unit})` : param.label;

  if (param.type === 'bool') {
    return (
      <label className="wpa-field wpa-field-check" title={param.hint}>
        <input type="checkbox" checked={Number(value) === 1} onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
        <span>{param.label}</span>
      </label>
    );
  }

  if (param.type === 'enum') {
    return (
      <label className="wpa-field" title={param.hint}>
        <span className="wpa-field-label">{label}</span>
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {param.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (param.type === 'multi-enum') {
    const selected = String(value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    const toggle = (lens: string) => {
      const next = selected.includes(lens) ? selected.filter((entry) => entry !== lens) : [...selected, lens];
      onChange(next.join(','));
    };

    return (
      <div className="wpa-field wpa-field-wide" title={param.hint}>
        <span className="wpa-field-label">{label}</span>
        <div className="wpa-chips">
          {param.options?.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`wpa-chip${selected.includes(option.value) ? ' is-on' : ''}`}
              onClick={() => toggle(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (param.type === 'number') {
    return (
      <label className="wpa-field" title={param.hint}>
        <span className="wpa-field-label">{label}</span>
        <input
          type="number"
          value={String(value ?? '')}
          min={param.min}
          max={param.max}
          step={param.step ?? 1}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      </label>
    );
  }

  return (
    <label className="wpa-field" title={param.hint}>
      <span className="wpa-field-label">{label}</span>
      <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
};

/* ------------------------------------------------------------------ */
/* Action dialog — compact, payload-aware                              */
/* ------------------------------------------------------------------ */

interface WaypointActionDialogProps {
  missionId: string;
  pointIndex: number;
  /** null → create a new action, otherwise edit the given one. */
  action: WaypointAction | null;
  onClose: () => void;
}

export const WaypointActionDialog = ({ missionId, pointIndex, action, onClose }: WaypointActionDialogProps) => {
  const mission = useMissionStore((state) => state.missions.find((m) => m.id === missionId));
  const addWaypointAction = useMissionStore((state) => state.addWaypointAction);
  const updateWaypointAction = useMissionStore((state) => state.updateWaypointAction);
  const context = payloadContextOf(mission);

  const isEdit = action !== null;
  const available = context ? getActionsForContext(context) : [];
  const [draft, setDraft] = useState<WaypointAction | null>(
    action ?? (context && available.length ? createWaypointAction(available[0].func, context) : null)
  );

  // The catalog is 14 entries — deriving these per render is cheaper than memoizing.
  const baseDef = draft ? getActionDef(draft.func) : undefined;
  const def = baseDef && context ? contextualizeAction(baseDef, context) : baseDef;
  const visibleParams = def && draft ? getVisibleParams(def, draft.params) : [];

  const grouped: Record<ActionCategory, typeof available> = { Camera: [], Gimbal: [], Aircraft: [] };
  available.forEach((entry) => grouped[ACTION_CATEGORY[entry.func]].push(entry));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSave = () => {
    if (!draft) return;
    if (isEdit) {
      updateWaypointAction(missionId, pointIndex, draft);
    } else {
      addWaypointAction(missionId, pointIndex, draft);
    }
    onClose();
  };

  return (
    <div className="wpa-backdrop" onClick={onClose}>
      <div className="wpa-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="wpa-dialog-head">
          <span>
            {isEdit ? 'Edit action' : 'Add action'} · WP #{pointIndex + 1}
          </span>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {context && (
          <div className="wpa-context">
            {context.droneLabel} · {context.cameraLabel}
          </div>
        )}

        <div className="wpa-dialog-body">
          <label className="wpa-field wpa-field-wide">
            <span className="wpa-field-label">Action</span>
            <select
              value={draft?.func ?? ''}
              disabled={isEdit}
              onChange={(e) => context && setDraft(createWaypointAction(e.target.value as WpmlActionFunc, context))}
            >
              {(Object.keys(grouped) as ActionCategory[])
                .filter((category) => grouped[category].length > 0)
                .map((category) => (
                  <optgroup key={category} label={category}>
                    {grouped[category].map((entry) => (
                      <option key={entry.func} value={entry.func}>
                        {entry.label}
                        {entry.deprecated ? ' (legacy)' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </select>
          </label>

          {def && (
            <p className="wpa-desc">
              <code>{def.func}</code> · {def.description}
            </p>
          )}

          {draft && def && (
            <div className="wpa-grid">
              {visibleParams.length === 0 ? (
                <p className="wpa-desc wpa-span">No parameters — this action runs as-is.</p>
              ) : (
                visibleParams.map((param) => (
                  <ParamField
                    key={param.key}
                    param={param}
                    value={draft.params[param.key] ?? param.default}
                    onChange={(next) => setDraft({ ...draft, params: { ...draft.params, [param.key]: next } })}
                  />
                ))
              )}
            </div>
          )}

          {def?.trigger === 'betweenAdjacentPoints' && (
            <p className="wpa-note">Runs along the segment from this waypoint to the next one.</p>
          )}
        </div>

        <footer className="wpa-dialog-foot">
          <button type="button" className="wpa-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="wpa-btn is-primary" disabled={!draft} onClick={handleSave}>
            OK
          </button>
        </footer>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Docked panel — "Selected Waypoint Parameters"                       */
/* ------------------------------------------------------------------ */

type OverrideField = 'speed' | 'droneYaw' | 'gimbalPitch' | 'gimbalYaw' | 'turnDistance';

const EMPTY_DRAFTS: Record<OverrideField | 'height', string> = {
  height: '',
  speed: '',
  droneYaw: '',
  gimbalPitch: '',
  gimbalYaw: '',
  turnDistance: '',
};

export const SelectedWaypointPanel = ({ missionId }: { missionId: string }) => {
  const mission = useMissionStore((state) => state.missions.find((m) => m.id === missionId));
  const selectedWaypointIndex = useMissionStore((state) => state.selectedWaypointIndex);
  const setSelectedWaypointIndex = useMissionStore((state) => state.setSelectedWaypointIndex);
  const setWaypointOverride = useMissionStore((state) => state.setWaypointOverride);
  const clearWaypointOverride = useMissionStore((state) => state.clearWaypointOverride);
  const deleteWaypointAction = useMissionStore((state) => state.deleteWaypointAction);
  const moveWaypointAction = useMissionStore((state) => state.moveWaypointAction);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);
  const updateMission = useMissionStore((state) => state.updateMission);
  const writeRelativeHeight = useRelativeHeightWriter(missionId);

  const [dialog, setDialog] = useState<{ action: WaypointAction | null } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copied, setCopied] = useState(false);

  const line = mission?.flightLines?.[0];
  const coordinates = line?.coordinates ?? [];
  const total = coordinates.length;
  const index =
    selectedWaypointIndex !== null && selectedWaypointIndex >= 0 && selectedWaypointIndex < total
      ? selectedWaypointIndex
      : null;
  const coord = index === null ? null : coordinates[index];
  const override = coord ? line?.waypointOverrides?.[waypointKey(coord[0], coord[1])] : undefined;
  const overrideCount = Object.keys(line?.waypointOverrides ?? {}).length;

  // Inputs are held as text so partial entries ("-", "1.") survive keystrokes;
  // they are re-seeded from the store whenever the selected waypoint changes.
  const [drafts, setDrafts] = useState<Record<OverrideField | 'height', string>>(EMPTY_DRAFTS);

  useEffect(() => {
    if (index === null || !mission) return;
    setDrafts({
      height: relativeHeight(coordinates, index, mission.parameters.altitude).toFixed(1),
      speed: override?.speed !== undefined ? String(override.speed) : '',
      droneYaw: override?.droneYaw !== undefined ? String(override.droneYaw) : '',
      gimbalPitch: override?.gimbalPitch !== undefined ? String(override.gimbalPitch) : '',
      gimbalYaw: override?.gimbalYaw !== undefined ? String(override.gimbalYaw) : '',
      turnDistance: override?.turnDistance !== undefined ? String(override.turnDistance) : '',
    });
    setShowAdvanced(
      override?.droneYaw !== undefined ||
        override?.gimbalPitch !== undefined ||
        override?.gimbalYaw !== undefined ||
        override?.turnDistance !== undefined
    );
    // Re-seeding on every override change would fight the user while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, missionId]);

  if (!mission || total === 0) {
    return <div className="selwp selwp-hint">No waypoints in this mission yet.</div>;
  }

  if (index === null || !coord) {
    return (
      <div className="selwp selwp-hint">
        Nothing selected. Turn on <strong>Edit</strong> mode and click a point, or{' '}
        <button type="button" className="selwp-link" onClick={() => setSelectedWaypointIndex(0)}>
          select waypoint 1
        </button>
        .
        {overrideCount > 0 && <div className="selwp-sub">{overrideCount} waypoint(s) carry custom settings.</div>}
      </div>
    );
  }

  const missionAltitude = mission.parameters.altitude;
  const absolute = absoluteAltitude(coordinates, index, missionAltitude);
  const terrain = getTerrainHeightAtDegrees(coord[0], coord[1]);
  const actions = override?.actions ?? [];
  const overriddenFields = (['speed', 'droneYaw', 'gimbalPitch', 'gimbalYaw', 'turnDistance'] as OverrideField[]).filter(
    (field) => override?.[field] !== undefined
  );

  const writeOverride = (field: OverrideField, raw: string) => {
    setDrafts((previous) => ({ ...previous, [field]: raw }));

    if (raw.trim() === '') {
      setWaypointOverride(missionId, index, { [field]: undefined });
      return;
    }

    const parsed = parseOptional(raw);
    if (parsed === undefined) return;

    setWaypointOverride(missionId, index, { [field]: parsed });

    // DJI ignores per-waypoint yaw while Aircraft Yaw is "Along the Route",
    // so entering a manual yaw switches the route to Manual.
    const followsWayline =
      (mission.parameters.globalHeadingMode ??
        (mission.parameters.waypointAutoDroneHeading ? 'followWayline' : 'manually')) === 'followWayline';

    if (field === 'droneYaw' && followsWayline) {
      updateMission(missionId, {
        parameters: { ...mission.parameters, globalHeadingMode: 'manually', waypointAutoDroneHeading: false },
      });
    }
  };

  const writeHeight = (raw: string) => {
    setDrafts((previous) => ({ ...previous, height: raw }));
    const parsed = parseOptional(raw);
    if (parsed !== undefined) writeRelativeHeight(mission, index, parsed);
  };

  const copyCoordinates = () => {
    navigator.clipboard?.writeText(`${coord[1].toFixed(7)},${coord[0].toFixed(7)}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="selwp">
      <div className="selwp-nav">
        <button type="button" disabled={index <= 0} onClick={() => setSelectedWaypointIndex(index - 1)} title="Previous">
          ◀
        </button>
        <span className="selwp-title">
          WP <strong>{index + 1}</strong>
          <em>/ {total}</em>
          {(override || actions.length > 0) && <span className="selwp-dot" title="Has custom settings" />}
        </span>
        <button
          type="button"
          disabled={index >= total - 1}
          onClick={() => setSelectedWaypointIndex(index + 1)}
          title="Next"
        >
          ▶
        </button>
        <button
          type="button"
          title="Zoom map to this waypoint"
          onClick={() =>
            setCameraTarget({
              longitude: coord[0],
              latitude: coord[1],
              altitude: Math.max(120, absolute + 120),
              heading: 0,
              pitch: -75,
              roll: 0,
            })
          }
        >
          ⌖
        </button>
      </div>

      <button type="button" className="selwp-coord" onClick={copyCoordinates} title="Copy coordinates">
        <span>
          {coord[1].toFixed(7)}, {coord[0].toFixed(7)}
        </span>
        <span className="selwp-copy">{copied ? '✓' : '⧉'}</span>
      </button>

      <div className="selwp-stats">
        <span>
          idx <b>{index}</b>
        </span>
        <span>
          terrain <b>{terrain === null ? '—' : `${terrain.toFixed(1)} m`}</b>
        </span>
        <span>
          AGL <b>{terrain === null ? '—' : `${(absolute - terrain).toFixed(1)} m`}</b>
        </span>
        <span>
          MSL <b>{absolute.toFixed(1)} m</b>
        </span>
      </div>

      <div className="selwp-grid">
        <label>
          <span className="selwp-label">
            Height rel. (m)
            {index === 0 && <em title="Waypoint 1 is the height reference for the whole route"> ref</em>}
          </span>
          <input type="number" step="0.1" value={drafts.height} onChange={(e) => writeHeight(e.target.value)} />
        </label>

        <label>
          <span className="selwp-label">
            Speed (m/s)
            {override?.speed !== undefined && <span className="selwp-dot" />}
          </span>
          <input
            type="number"
            step="0.1"
            min="0.1"
            placeholder={`global ${mission.parameters.speed}`}
            value={drafts.speed}
            onChange={(e) => writeOverride('speed', e.target.value)}
          />
        </label>
      </div>

      {index === 0 && (
        <p className="selwp-sub">Waypoint 1 sets the route reference — changing it shifts every height.</p>
      )}

      <button type="button" className="selwp-more" onClick={() => setShowAdvanced((previous) => !previous)}>
        <span>{showAdvanced ? '▾' : '▸'} Heading, gimbal &amp; turn</span>
        {overriddenFields.length > 0 && <span className="selwp-badge">{overriddenFields.length}</span>}
      </button>

      {showAdvanced && (
        <div className="selwp-grid">
          <label>
            <span className="selwp-label">
              Drone yaw (°){override?.droneYaw !== undefined && <span className="selwp-dot" />}
            </span>
            <input
              type="number"
              step="1"
              min="-180"
              max="180"
              placeholder={`global ${mission.parameters.droneYaw}`}
              value={drafts.droneYaw}
              onChange={(e) => writeOverride('droneYaw', e.target.value)}
            />
          </label>

          <label>
            <span className="selwp-label">
              Gimbal pitch (°){override?.gimbalPitch !== undefined && <span className="selwp-dot" />}
            </span>
            <input
              type="number"
              step="1"
              min="-120"
              max="45"
              placeholder={`global ${mission.parameters.gimbalPitch}`}
              value={drafts.gimbalPitch}
              onChange={(e) => writeOverride('gimbalPitch', e.target.value)}
            />
          </label>

          <label>
            <span className="selwp-label">
              Gimbal yaw (°){override?.gimbalYaw !== undefined && <span className="selwp-dot" />}
            </span>
            <input
              type="number"
              step="1"
              min="-180"
              max="180"
              placeholder={mission.parameters.waypointAutoGimbalYaw ? 'auto' : `global ${mission.parameters.gimbalYaw}`}
              value={drafts.gimbalYaw}
              onChange={(e) => writeOverride('gimbalYaw', e.target.value)}
            />
          </label>

          <label>
            <span className="selwp-label">
              Turn dist. (m){override?.turnDistance !== undefined && <span className="selwp-dot" />}
            </span>
            <input
              type="number"
              step="0.1"
              min="0"
              placeholder={`global ${mission.parameters.waypointTurnDistance ?? 0.5}`}
              value={drafts.turnDistance}
              onChange={(e) => writeOverride('turnDistance', e.target.value)}
            />
          </label>
        </div>
      )}

      <p className="selwp-sub">Empty field = mission-wide value.</p>

      <div className="selwp-actions-bar">
        <span>
          Actions <b>{actions.length}</b>
        </span>
        <button type="button" className="wpa-btn is-small" onClick={() => setDialog({ action: null })}>
          ＋ Add
        </button>
      </div>

      {actions.length > 0 && (
        <ul className="selwp-actions">
          {actions.map((entry, position) => (
            <li key={entry.id}>
              <span className="selwp-action-index">{position + 1}</span>
              <span className="selwp-action-name" title={getActionDef(entry.func)?.description}>
                {describeAction(entry)}
              </span>
              <button
                type="button"
                disabled={position === 0}
                title="Move up"
                onClick={() => moveWaypointAction(missionId, index, entry.id, -1)}
              >
                ▲
              </button>
              <button
                type="button"
                disabled={position === actions.length - 1}
                title="Move down"
                onClick={() => moveWaypointAction(missionId, index, entry.id, 1)}
              >
                ▼
              </button>
              <button type="button" title="Edit" onClick={() => setDialog({ action: entry })}>
                ✎
              </button>
              <button
                type="button"
                className="is-danger"
                title="Delete"
                onClick={() => deleteWaypointAction(missionId, index, entry.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="selwp-check">
        <input
          type="checkbox"
          checked={override?.useGlobalActions !== false}
          onChange={(e) =>
            setWaypointOverride(missionId, index, { useGlobalActions: e.target.checked ? undefined : false })
          }
        />
        <span>Also run mission-wide actions here</span>
      </label>

      {(override || actions.length > 0) && (
        <button type="button" className="selwp-link" onClick={() => clearWaypointOverride(missionId, index)}>
          Reset this waypoint
        </button>
      )}

      {dialog && (
        <WaypointActionDialog
          key={`action-${index}-${dialog.action?.id ?? 'new'}`}
          missionId={missionId}
          pointIndex={index}
          action={dialog.action}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Quick edit — small floating window anchored on the map              */
/* ------------------------------------------------------------------ */

interface WaypointQuickEditProps {
  missionId: string;
  pointIndex: number;
  /** Screen anchor in pixels; omit to center the window. */
  x?: number;
  y?: number;
  onClose: () => void;
  onAddAction?: () => void;
}

export const WaypointQuickEdit = ({ missionId, pointIndex, x, y, onClose, onAddAction }: WaypointQuickEditProps) => {
  const mission = useMissionStore((state) => state.missions.find((m) => m.id === missionId));
  const setWaypointOverride = useMissionStore((state) => state.setWaypointOverride);
  const writeRelativeHeight = useRelativeHeightWriter(missionId);

  const line = mission?.flightLines?.[0];
  const coordinates = line?.coordinates ?? [];
  const coord = coordinates[pointIndex];
  const override = coord ? line?.waypointOverrides?.[waypointKey(coord[0], coord[1])] : undefined;

  const missionAltitude = mission?.parameters.altitude ?? 100;
  const absolute = absoluteAltitude(coordinates, pointIndex, missionAltitude);
  const terrain = coord ? getTerrainHeightAtDegrees(coord[0], coord[1]) : null;

  const [height, setHeight] = useState<string>(relativeHeight(coordinates, pointIndex, missionAltitude).toFixed(1));
  const [agl, setAgl] = useState<string>(terrain === null ? '' : (absolute - terrain).toFixed(1));
  const [speed, setSpeed] = useState<string>(override?.speed !== undefined ? String(override.speed) : '');
  const [gimbalPitch, setGimbalPitch] = useState<string>(
    override?.gimbalPitch !== undefined ? String(override.gimbalPitch) : ''
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!mission || !coord) return null;

  // AGL and relative height differ only by a constant, so keep both in step.
  const relativeFromAgl = (aglValue: number) =>
    terrain === null ? null : missionAltitude + (terrain + aglValue - absoluteAltitude(coordinates, 0, missionAltitude));

  const handleHeightChange = (raw: string) => {
    setHeight(raw);
    const parsed = parseOptional(raw);
    if (parsed === undefined || terrain === null) return;
    const delta = parsed - relativeHeight(coordinates, pointIndex, missionAltitude);
    setAgl((absolute - terrain + delta).toFixed(1));
  };

  const handleAglChange = (raw: string) => {
    setAgl(raw);
    const parsed = parseOptional(raw);
    if (parsed === undefined) return;
    const nextRelative = relativeFromAgl(parsed);
    if (nextRelative !== null) setHeight(nextRelative.toFixed(1));
  };

  const handleApply = () => {
    const parsedHeight = parseOptional(height);
    if (parsedHeight !== undefined) writeRelativeHeight(mission, pointIndex, parsedHeight);

    setWaypointOverride(missionId, pointIndex, {
      speed: parseOptional(speed),
      gimbalPitch: parseOptional(gimbalPitch),
    });

    onClose();
  };

  const style =
    x === undefined || y === undefined
      ? { left: '50%', top: '20%', transform: 'translateX(-50%)' }
      : {
          left: `${Math.max(8, Math.min(x, window.innerWidth - 250))}px`,
          top: `${Math.max(8, Math.min(y, window.innerHeight - 300))}px`,
        };

  return (
    <div className="wpq" style={style} onClick={(event) => event.stopPropagation()}>
      <header className="wpq-head">
        <span>WP #{pointIndex + 1}</span>
        <button type="button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="wpq-coord">
        {coord[1].toFixed(7)}, {coord[0].toFixed(7)}
      </div>

      <div className="wpq-body">
        <label>
          <span>Height rel. (m)</span>
          <input type="number" step="0.1" value={height} onChange={(e) => handleHeightChange(e.target.value)} />
        </label>

        <label>
          <span>AGL (m)</span>
          <input
            type="number"
            step="0.1"
            value={agl}
            disabled={terrain === null}
            onChange={(e) => handleAglChange(e.target.value)}
          />
        </label>

        <label>
          <span>Speed (m/s)</span>
          <input
            type="number"
            step="0.1"
            min="0.1"
            placeholder={`global ${mission.parameters.speed}`}
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
          />
        </label>

        <label>
          <span>Gimbal pitch (°)</span>
          <input
            type="number"
            step="1"
            placeholder={`global ${mission.parameters.gimbalPitch}`}
            value={gimbalPitch}
            onChange={(e) => setGimbalPitch(e.target.value)}
          />
        </label>
      </div>

      <footer className="wpq-foot">
        {onAddAction && (
          <button type="button" className="wpa-btn is-small" onClick={onAddAction}>
            ＋ Action
          </button>
        )}
        <button type="button" className="wpa-btn is-small" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="wpa-btn is-small is-primary" onClick={handleApply}>
          OK
        </button>
      </footer>
    </div>
  );
};
