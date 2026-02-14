/**
 * MissionManager Component
 * Manages missions: create, select, delete, visibility toggle, import KML
 * Similar to UGCS mission management system
 */

import { useState } from 'react';
import { useMissionStore } from '../stores/mission-store';
import { DRONES } from '../lib/drone-specs';
import './MissionManager.css';

const VisibilityIcon = ({ visible }: { visible: boolean }) => (
  <svg
    className="visibility-icon"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 5C6.5 5 2.1 8.4 1 12c1.1 3.6 5.5 7 11 7s9.9-3.4 11-7c-1.1-3.6-5.5-7-11-7Z" fill="currentColor" />
    <circle cx="12" cy="12" r="3.8" fill="white" />
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    {!visible && <path d="M4 4 20 20" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />}
  </svg>
);

const areLayersEquivalent = (a: ReturnType<typeof useMissionStore.getState>['layers'], b: ReturnType<typeof useMissionStore.getState>['layers']) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  return a.every((layerA, index) => {
    const layerB = b[index];
    if (!layerB) return false;

    return (
      layerA.id === layerB.id &&
      layerA.name === layerB.name &&
      layerA.type === layerB.type &&
      layerA.visible === layerB.visible &&
      layerA.opacity === layerB.opacity &&
      layerA.url === layerB.url &&
      layerA.cesiumAssetId === layerB.cesiumAssetId &&
      layerA.cesiumAssetType === layerB.cesiumAssetType
    );
  });
};

export const MissionManager = () => {
  const missions = useMissionStore((state) => state.missions);
  const layers = useMissionStore((state) => state.layers);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const addMission = useMissionStore((state) => state.addMission);
  const deleteMission = useMissionStore((state) => state.deleteMission);
  const setActiveMission = useMissionStore((state) => state.setActiveMission);
  const setLayers = useMissionStore((state) => state.setLayers);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);
  const toggleMissionVisibility = useMissionStore((state) => state.toggleMissionVisibility);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newMissionName, setNewMissionName] = useState('');

  const getMissionTag = (mission: typeof missions[number]) => {
    if (mission.missionType === 'waypoint') {
      const firstLineId = mission.flightLines?.[0]?.id ?? '';
      return firstLineId.startsWith('waypoint-import-') ? 'Kml Waypoint' : 'Add Waypoint';
    }

    if (mission.aoi?.type === 'kml') return 'Kml Area';
    if (mission.aoi) return 'Drawn Area';

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
      parameters: {
        altitude: 100,
        speed: 8,
        forwardOverlap: 80,
        sideOverlap: 70,
        flightAngle: 0,
        gimbalPitch: -90,
        gimbalYaw: 0,
        droneYaw: 0,
        waypointTakePhoto: true,
        waypointRecordVideo: false,
        waypointHoverEnabled: false,
        waypointHoverTime: 2,
        waypointAutoDroneHeading: true,
        waypointAutoGimbalYaw: true,
      },
      flightLines: [],
      layerSnapshot: layers.map((layer) => ({ ...layer })),
      visible: true,
    });

    setNewMissionName('');
    setShowCreateForm(false);
    setActiveMission(missionId);
  };

  const handleDeleteMission = (id: string) => {
    if (confirm('Are you sure you want to delete this mission?')) {
      deleteMission(id);
    }
  };

  const handleSelectMission = (missionId: string) => {
    const mission = missions.find((item) => item.id === missionId);
    if (!mission) return;

    if (mission.layerSnapshot && mission.layerSnapshot.length > 0) {
      const snapshotLayers = mission.layerSnapshot.map((layer) => ({ ...layer }));
      if (!areLayersEquivalent(snapshotLayers, layers)) {
        setLayers(snapshotLayers);
      }
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

    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const span = Math.max(maxLon - minLon, maxLat - minLat);
    const focusAltitude = Math.max(800, span * 140000);

    setCameraTarget({
      longitude: centerLon,
      latitude: centerLat,
      altitude: focusAltitude,
      heading: 0,
      pitch: -90,
      roll: 0,
    });
  };

  return (
    <div className="mission-manager">
      <h2>Missions</h2>

      {/* Action Buttons */}
      <div className="mission-actions">
        <button
          className="btn-action btn-create"
          onClick={() => setShowCreateForm(!showCreateForm)}
          title="Create New Mission"
        >
          ✚ New Mission
        </button>
      </div>

      {/* Create Mission Form */}
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
            <button className="btn-confirm" onClick={handleCreateMission}>
              Create
            </button>
            <button className="btn-cancel" onClick={() => setShowCreateForm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Mission List */}
      <div className="mission-list">
        {missions.length === 0 ? (
          <div className="empty-state">No missions yet. Create one to start!</div>
        ) : (
          missions.map((mission) => (
            <div
              key={mission.id}
              className={`mission-item ${mission.id === activeMissionId ? 'active' : ''}`}
            >
              {/* Visibility Toggle */}
              <button
                className="btn-visibility"
                onClick={() => toggleMissionVisibility(mission.id)}
                title={mission.visible ? 'Hide mission' : 'Show mission'}
                aria-label={mission.visible ? 'Hide mission' : 'Show mission'}
              >
                <VisibilityIcon visible={mission.visible} />
              </button>

              {/* Mission Name */}
              <div
                className="mission-name"
                onClick={() => handleSelectMission(mission.id)}
                title="Select mission"
              >
                {mission.name}
                {getMissionTag(mission) && (
                  <span className="mission-badge">
                    {getMissionTag(mission)}
                  </span>
                )}
              </div>

              {/* Delete Button */}
              <button
                className="btn-delete"
                onClick={() => handleDeleteMission(mission.id)}
                title="Delete mission"
              >
                🗑️
              </button>
            </div>
          ))
        )}
      </div>

      {/* Active Mission Info */}
      {activeMissionId && (
        <div className="active-mission-info">
          <strong>Active:</strong> {missions.find(m => m.id === activeMissionId)?.name}
        </div>
      )}
    </div>
  );
};
