import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useMissionStore } from '../stores/mission-store';
import type { Mission } from '../stores/mission-store';
import { DRONES } from '../lib/drone-specs';
import './MissionManager.css';

const EXPORT_APP = 'dji-3d-flight-planner';
const EXPORT_VERSION = '1.0';

type MissionExportFile = {
  version: string;
  app: string;
  exportedAt: string;
  mission: Omit<Mission, 'id' | 'createdAt' | 'updatedAt'>;
};

const VisibilityIcon = ({ visible }: { visible: boolean }) => (
  <svg className="visibility-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 5C6.5 5 2.1 8.4 1 12c1.1 3.6 5.5 7 11 7s9.9-3.4 11-7c-1.1-3.6-5.5-7-11-7Z" fill="currentColor" />
    <circle cx="12" cy="12" r="3.8" fill="white" />
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    {!visible && <path d="M4 4 20 20" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />}
  </svg>
);

function triggerMissionDownload(mission: Mission) {
  const payload: MissionExportFile = {
    version: EXPORT_VERSION,
    app: EXPORT_APP,
    exportedAt: new Date().toISOString(),
    mission: {
      name: mission.name,
      missionType: mission.missionType,
      drone: mission.drone,
      camera: mission.camera,
      aoi: mission.aoi,
      takeoffPoint: mission.takeoffPoint,
      parameters: mission.parameters,
      flightLines: mission.flightLines,
      layerSnapshot: mission.layerSnapshot,
      visible: mission.visible,
    },
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${mission.name.replace(/[^a-z0-9]/gi, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function isValidExportFile(data: unknown): data is MissionExportFile {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.app !== EXPORT_APP) return false;
  if (!d.mission || typeof d.mission !== 'object') return false;
  const m = d.mission as Record<string, unknown>;
  return (
    typeof m.name === 'string' &&
    (m.missionType === 'area' || m.missionType === 'waypoint') &&
    typeof m.parameters === 'object' &&
    m.parameters !== null &&
    Array.isArray(m.flightLines)
  );
}

interface ContextMenuPos {
  missionId: string;
  right: number;
  buttonTop: number;
  buttonBottom: number;
}

export const MissionManager = () => {
  const missions = useMissionStore((state) => state.missions);
  const layers = useMissionStore((state) => state.layers);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const addMission = useMissionStore((state) => state.addMission);
  const deleteMission = useMissionStore((state) => state.deleteMission);
  const updateMission = useMissionStore((state) => state.updateMission);
  const setActiveMission = useMissionStore((state) => state.setActiveMission);
  const setLayers = useMissionStore((state) => state.setLayers);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);
  const toggleMissionVisibility = useMissionStore((state) => state.toggleMissionVisibility);
  const setMissionsVisibility = useMissionStore((state) => state.setMissionsVisibility);
  const toggleMissionFlown = useMissionStore((state) => state.toggleMissionFlown);
  const setMissionArchived = useMissionStore((state) => state.setMissionArchived);

  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newMissionName, setNewMissionName] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const getMissionTag = (mission: typeof missions[number]) => {
    if (mission.missionType === 'waypoint') return 'Waypoint';
    if (mission.aoi) return 'Area';
    return null;
  };

  const handleCreateMission = () => {
    if (!newMissionName.trim()) {
      alert('Please enter a mission name');
      return;
    }

    const defaultDrone = DRONES[0];
    const defaultCamera = defaultDrone.cameras[0];

    const missionId = addMission({
      name: newMissionName,
      missionType: 'area',
      drone: defaultDrone,
      camera: defaultCamera,
      aoi: null,
      takeoffPoint: null,
      parameters: {
        altitude: 100,
        speed: 8,
        forwardOverlap: 80,
        sideOverlap: 70,
        flightAngle: 0,
        gimbalPitch: -90,
        gimbalYaw: 0,
        droneYaw: 0,
        waypointTakePhoto: false,
        waypointRecordVideo: false,
        waypointHoverEnabled: false,
        waypointHoverTime: 2,
        waypointAutoDroneHeading: false,
        globalHeadingMode: 'manually',
        gimbalPitchMode: 'manual',
        waypointAutoGimbalYaw: false,
        waypointTurnDistance: 0.2,
        alwaysTerrainFollow: false,
        terrainFollowAccuracy: 2,
        terrainFollowMinDist: 5,
        elevationToleranceEnabled: false,
        elevationTolerance: 1,
      },
      flightLines: [],
      layerSnapshot: layers.map((layer) => ({ ...layer })),
      visible: true,
    });

    setNewMissionName('');
    setShowCreateForm(false);
    setActiveMission(missionId);
  };

  const handleSelectMission = (missionId: string) => {
    const mission = missions.find((item) => item.id === missionId);
    if (!mission) return;

    if (mission.layerSnapshot && mission.layerSnapshot.length > 0) {
      setLayers(mission.layerSnapshot.map((layer) => ({ ...layer })));
    }

    setActiveMission(missionId);

    const sourceCoordinates = mission.aoi?.coordinates?.length
      ? mission.aoi.coordinates
      : (mission.flightLines ?? []).flatMap((line) => line.coordinates ?? []);

    const validCoordinates = sourceCoordinates.filter(
      (coord): coord is number[] => !!coord && Number.isFinite(coord[0]) && Number.isFinite(coord[1])
    );

    if (validCoordinates.length === 0) return;

    const lons = validCoordinates.map((coord) => coord[0]);
    const lats = validCoordinates.map((coord) => coord[1]);

    const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const span = Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats));

    setCameraTarget({
      longitude: centerLon,
      latitude: centerLat,
      altitude: Math.max(800, span * 140000),
      heading: 0,
      pitch: -90,
      roll: 0,
    });
  };

  const openContextMenu = (e: React.MouseEvent<HTMLButtonElement>, missionId: string) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({
      missionId,
      right: window.innerWidth - rect.right,
      buttonTop: rect.top,
      buttonBottom: rect.bottom,
    });
  };

  const closeContextMenu = () => setContextMenu(null);

  const startRename = (mission: Mission) => {
    closeContextMenu();
    setRenamingId(mission.id);
    setRenameValue(mission.name);
  };

  const submitRename = (id: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) updateMission(id, { name: trimmed });
    setRenamingId(null);
  };

  const handleDuplicate = (mission: Mission) => {
    closeContextMenu();
    const missionId = addMission({
      ...mission,
      name: `${mission.name} (Copy)`,
      layerSnapshot: mission.layerSnapshot?.map((l) => ({ ...l })),
      flightLines: mission.flightLines.map((fl) => ({
        ...fl,
        coordinates: fl.coordinates.map((c) => [...c]),
        photoPoints: fl.photoPoints.map((p) => [...p]),
        originalCoordinates: fl.originalCoordinates?.map((c) => [...c]),
      })),
    });
    setActiveMission(missionId);
  };

  const handleExport = (mission: Mission) => {
    closeContextMenu();
    triggerMissionDownload(mission);
  };

  const handleDelete = (id: string) => {
    closeContextMenu();
    if (confirm('Are you sure you want to delete this mission?')) {
      deleteMission(id);
    }
  };

  const handleToggleFlown = (mission: Mission) => {
    closeContextMenu();
    toggleMissionFlown(mission.id);
  };

  const handleArchive = (mission: Mission) => {
    closeContextMenu();
    setMissionArchived(mission.id, true);
  };

  const handleRestore = (mission: Mission) => {
    closeContextMenu();
    setMissionArchived(mission.id, false);
    setTab('active');
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        if (!isValidExportFile(data)) {
          setImportError('Invalid file — only missions exported from this app can be imported.');
          return;
        }
        const missionId = addMission({ ...data.mission });
        setActiveMission(missionId);
      } catch {
        setImportError('Could not parse file. Make sure it is a valid JSON mission export.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const contextMission = contextMenu
    ? missions.find((m) => m.id === contextMenu.missionId) ?? null
    : null;

  const activeMissions = missions.filter((mission) => !mission.archived);
  const archivedMissions = missions.filter((mission) => mission.archived);
  const isArchiveTab = tab === 'archived';
  const visibleMissions = isArchiveTab ? archivedMissions : activeMissions;

  // "Show all" / "Hide all" act on the tab you are looking at, never the other one.
  const shownCount = visibleMissions.filter((mission) => mission.visible).length;
  const setAllVisible = (visible: boolean) =>
    setMissionsVisibility(
      visibleMissions.map((mission) => mission.id),
      visible
    );

  return (
    <div className="mission-manager">
      <h2>Missions</h2>

      <div className="mission-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={!isArchiveTab}
          className={!isArchiveTab ? 'is-active' : ''}
          onClick={() => setTab('active')}
        >
          Missions <span className="tab-count">{activeMissions.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isArchiveTab}
          className={isArchiveTab ? 'is-active' : ''}
          onClick={() => {
            setTab('archived');
            setShowCreateForm(false);
          }}
        >
          Archived <span className="tab-count">{archivedMissions.length}</span>
        </button>
      </div>

      {!isArchiveTab && (
        <div className="mission-actions">
          <button
            className="btn-action btn-create"
            onClick={() => setShowCreateForm(!showCreateForm)}
            title="Create New Mission"
          >
            ✚ New Mission
          </button>
          <button
            className="btn-action btn-import-mission"
            onClick={() => fileInputRef.current?.click()}
            title="Import Mission from JSON"
          >
            ↥ Import Mission
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
        </div>
      )}

      {importError && (
        <div className="import-error">
          <span>{importError}</span>
          <button onClick={() => setImportError(null)}>✕</button>
        </div>
      )}

      {showCreateForm && (
        <div className="create-form">
          <input
            type="text"
            placeholder="Mission name..."
            value={newMissionName}
            onChange={(e) => setNewMissionName(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleCreateMission()}
            autoFocus
          />
          <div className="form-buttons">
            <button className="btn-confirm" onClick={handleCreateMission}>Create</button>
            <button className="btn-cancel" onClick={() => setShowCreateForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {isArchiveTab && archivedMissions.length > 0 && (
        <div className="archive-hint">
          Archived missions are read-only and stay hidden on the map until you show them.
        </div>
      )}

      {visibleMissions.length > 0 && (
        <div className="mission-bulk-visibility">
          <span className="bulk-count">
            {shownCount} / {visibleMissions.length} shown
          </span>
          <button
            type="button"
            onClick={() => setAllVisible(true)}
            disabled={shownCount === visibleMissions.length}
            title={isArchiveTab ? 'Show all archived missions on the map' : 'Show all missions on the map'}
          >
            Show all
          </button>
          <button
            type="button"
            onClick={() => setAllVisible(false)}
            disabled={shownCount === 0}
            title={isArchiveTab ? 'Hide all archived missions' : 'Hide all missions'}
          >
            Hide all
          </button>
        </div>
      )}

      <div className="mission-list">
        {visibleMissions.length === 0 ? (
          <div className="empty-state">
            {isArchiveTab ? 'No archived missions.' : 'No missions yet. Create one to start!'}
          </div>
        ) : (
          visibleMissions.map((mission) => (
            <div
              key={mission.id}
              className={[
                'mission-item',
                mission.id === activeMissionId ? 'active' : '',
                mission.flown ? 'is-flown' : '',
                mission.archived ? 'is-archived' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                className="btn-visibility"
                onClick={() => toggleMissionVisibility(mission.id)}
                title={mission.visible ? 'Hide mission' : 'Show mission'}
                aria-label={mission.visible ? 'Hide mission' : 'Show mission'}
              >
                <VisibilityIcon visible={mission.visible} />
              </button>

              {renamingId === mission.id ? (
                <input
                  className="rename-input"
                  value={renameValue}
                  autoFocus
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename(mission.id);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => submitRename(mission.id)}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div
                  className="mission-name"
                  onClick={() => !mission.archived && handleSelectMission(mission.id)}
                  title={mission.archived ? 'Archived — restore it to edit' : 'Click to select'}
                >
                  {mission.name}
                  {getMissionTag(mission) && (
                    <span className="mission-badge">{getMissionTag(mission)}</span>
                  )}
                  {mission.flown && <span className="mission-badge is-flown">Flown</span>}
                </div>
              )}

              <button
                className="btn-menu"
                onClick={(e) => openContextMenu(e, mission.id)}
                title="More options"
                aria-label="Mission options"
              >
                ⋯
              </button>
            </div>
          ))
        )}
      </div>

      {activeMissionId && (
        <div className="active-mission-info">
          <strong>Active:</strong> {missions.find(m => m.id === activeMissionId)?.name}
        </div>
      )}

      {contextMenu && contextMission && createPortal(
        <>
          <div className="context-menu-backdrop" onClick={closeContextMenu} />
          <div
            className="context-menu"
            style={{
              position: 'fixed',
              ...(contextMenu.buttonBottom + (contextMission.archived ? 150 : 275) > window.innerHeight
                ? { bottom: window.innerHeight - contextMenu.buttonTop + 4 }
                : { top: contextMenu.buttonBottom + 4 }),
              right: contextMenu.right,
              zIndex: 9999,
            }}
          >
            {contextMission.archived ? (
              <button onClick={() => handleRestore(contextMission)}>
                <span className="menu-icon">↩</span> Restore to Missions
              </button>
            ) : (
              <>
                <button onClick={() => startRename(contextMission)}>
                  <span className="menu-icon">✏️</span> Rename
                </button>
                <button onClick={() => handleDuplicate(contextMission)}>
                  <span className="menu-icon">⧉</span> Duplicate
                </button>
                <div className="context-menu-separator" />
                <button onClick={() => handleToggleFlown(contextMission)}>
                  <span className="menu-icon">{contextMission.flown ? '↺' : '✓'}</span>{' '}
                  {contextMission.flown ? 'Mark Not Flown' : 'Mark Flown'}
                </button>
                <button onClick={() => handleArchive(contextMission)}>
                  <span className="menu-icon">🗄️</span> Archive
                </button>
              </>
            )}
            <div className="context-menu-separator" />
            <button onClick={() => handleExport(contextMission)}>
              <span className="menu-icon">↧</span> Export JSON
            </button>
            <button className="danger" onClick={() => handleDelete(contextMission.id)}>
              <span className="menu-icon">🗑️</span> Delete
            </button>
          </div>
        </>,
        document.body
      )}
    </div>
  );
};
