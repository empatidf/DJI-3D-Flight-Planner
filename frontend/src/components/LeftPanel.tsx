/**
 * Left instrument rail.
 *
 * Replaces the two fixed half-height panels (Cesium Layer Manager + Missions).
 * They split the sidebar 50/50 regardless of what was in them, so a one-time
 * token field held as much space as a ten-mission list. Here the two views are
 * stacked collapsible sections: the open one takes every remaining pixel, the
 * closed one shrinks to a summary bar that still reports its state.
 */

import { useState } from 'react';
import { useMissionStore } from '../stores/mission-store';
import { estimateMissionFlight } from '../lib/flight-calculations';
import { LayerManager } from './LayerManager';
import { MissionManager } from './MissionManager';
import './LeftPanel.css';

type PanelSection = 'map' | 'missions';

const VIEW_MODE_LABEL: Record<string, string> = {
  SCENE3D: '3D',
  COLUMBUS_VIEW: '2.5D',
  SCENE2D: '2D',
};

export const LeftPanel = () => {
  const layers = useMissionStore((state) => state.layers);
  const missions = useMissionStore((state) => state.missions);
  const viewMode = useMissionStore((state) => state.viewMode);

  const [open, setOpen] = useState<PanelSection>('missions');
  const [collapsed, setCollapsed] = useState(false);

  const activeMissions = missions.filter((mission) => !mission.archived);
  const shownMissions = activeMissions.filter((mission) => mission.visible);
  const layersOn = layers.filter((layer) => layer.visible).length;

  // Combined air time of everything currently drawn on the map — the figure you
  // need when deciding how many of these routes fit in one battery session.
  const shownMinutes = Math.round(
    shownMissions.reduce((sum, mission) => sum + estimateMissionFlight(mission).seconds, 0) / 60
  );

  const summary: Record<PanelSection, string> = {
    map: `${VIEW_MODE_LABEL[viewMode] ?? '3D'} · ${layersOn} of ${layers.length} layers on`,
    missions: `${shownMissions.length} on map · ${shownMinutes} min`,
  };

  if (collapsed) {
    return (
      <div className="rail is-collapsed">
        <button
          type="button"
          className="rail-restore"
          onClick={() => setCollapsed(false)}
          title="Show map and mission controls"
        >
          <span className="rail-restore-icon">☰</span>
          <span className="rail-restore-label">Map &amp; Missions</span>
        </button>
      </div>
    );
  }

  const renderSection = (id: PanelSection, title: string, children: React.ReactNode) => {
    const isOpen = open === id;
    return (
      <section className={`rail-section${isOpen ? ' is-open' : ''}`}>
        <h2>
          <button
            type="button"
            className="rail-section-bar"
            aria-expanded={isOpen}
            onClick={() => setOpen(id)}
          >
            <span className="rail-caret" aria-hidden="true">
              {isOpen ? '▾' : '▸'}
            </span>
            <span className="rail-section-title">{title}</span>
            <span className="rail-section-summary">{summary[id]}</span>
          </button>
        </h2>
        {isOpen && <div className="rail-section-body">{children}</div>}
      </section>
    );
  };

  return (
    <div className="rail">
      <button
        type="button"
        className="rail-hide"
        onClick={() => setCollapsed(true)}
        title="Hide this panel and use the full map"
        aria-label="Hide panel"
      >
        ❮
      </button>

      {renderSection('map', 'Map', <LayerManager />)}
      {renderSection('missions', 'Missions', <MissionManager />)}
    </div>
  );
};
