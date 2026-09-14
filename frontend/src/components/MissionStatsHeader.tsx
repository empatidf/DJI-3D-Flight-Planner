/**
 * At-a-glance numbers for the active mission, like the header of the FlightHub 2
 * route editor: the size of the job before its details.
 */

import type { Mission } from '../stores/mission-store';
import { estimateMissionFlight } from '../lib/flight-calculations';
import { formatArea, polygonAreaM2 } from '../lib/mission-import';

const EMPTY = '—';

const formatDistance = (meters: number) =>
  meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;

const formatDuration = (seconds: number) => {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${total % 60} s`;
  return `${total} s`;
};

export const MissionStatsHeader = ({ mission }: { mission: Mission }) => {
  const flightLines = mission.flightLines ?? [];
  const hasRoute = flightLines.some((line) => line.coordinates.length > 1);
  // Same estimate as the left rail's "on map" total, so the two always agree.
  const { distanceM, seconds } = estimateMissionFlight(mission);

  const distance = hasRoute ? formatDistance(distanceM) : EMPTY;
  const duration = hasRoute ? formatDuration(seconds) : EMPTY;

  const stats =
    mission.missionType === 'waypoint'
      ? [
          { label: 'Waypoints', value: String(flightLines[0]?.coordinates.length ?? 0) },
          { label: 'Distance', value: distance },
          { label: 'Est. duration', value: duration },
        ]
      : [
          { label: 'Area', value: mission.aoi ? formatArea(polygonAreaM2(mission.aoi.coordinates)) : EMPTY },
          { label: 'Distance', value: distance },
          { label: 'Est. duration', value: duration },
          {
            label: 'Photos',
            value: hasRoute
              ? String(flightLines.reduce((sum, line) => sum + (line.photoPoints?.length ?? 0), 0))
              : EMPTY,
          },
        ];

  return (
    <div className={`mission-stats cols-${stats.length}`}>
      {stats.map((stat) => (
        <div key={stat.label} className="mission-stat">
          <span className="mission-stat-label">{stat.label}</span>
          <span className="mission-stat-value" title={stat.value}>
            {stat.value}
          </span>
        </div>
      ))}
    </div>
  );
};
