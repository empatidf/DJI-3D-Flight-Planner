/**
 * On-disk format of a project folder.
 *
 *   <folder>/droneverse-project.json   mission order
 *   <folder>/missions/<name>__<id>.json one file per mission
 *   <folder>/.trash/                    deleted missions, never hard-deleted
 *
 * The mission file keeps the `app` and `version` fields of the old single
 * mission export, so a file copied out of the folder can still be loaded with
 * "Import Mission".
 */

import { withMissionType, type Mission } from '../../stores/mission-store';

export const PROJECT_FILE_NAME = 'droneverse-project.json';
export const MISSIONS_DIR = 'missions';
export const TRASH_DIR = '.trash';

const MISSION_FORMAT = 'droneverse-mission';
const PROJECT_FORMAT = 'droneverse-project';
const SCHEMA_VERSION = 1;
const LEGACY_APP = 'dji-3d-flight-planner';
const LEGACY_VERSION = '1.0';

const slugify = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'mission';

/** Readable and unique: the name for people, the id so renames never collide. */
export const missionFileName = (mission: Mission) =>
  `${slugify(mission.name)}__${mission.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;

export const serializeMission = (mission: Mission): string =>
  JSON.stringify(
    {
      format: MISSION_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      app: LEGACY_APP,
      version: LEGACY_VERSION,
      savedAt: new Date().toISOString(),
      mission,
    },
    null,
    2
  );

const toDate = (value: unknown) => {
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

/** Throws with a readable message when the text is not a usable mission file. */
export const parseMissionFile = (text: string): Mission => {
  const data = JSON.parse(text) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || data.format !== MISSION_FORMAT) {
    throw new Error('not a mission file');
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > SCHEMA_VERSION) {
    throw new Error('saved by a newer version of the planner');
  }

  const mission = data.mission as Record<string, unknown> | null;
  const valid =
    !!mission &&
    typeof mission.id === 'string' &&
    mission.id.length > 0 &&
    typeof mission.name === 'string' &&
    // A missing type is an older area mission (see withMissionType).
    typeof mission.parameters === 'object' &&
    mission.parameters !== null &&
    Array.isArray(mission.flightLines);
  if (!valid) throw new Error('mission data is incomplete');

  return withMissionType({
    ...(mission as unknown as Mission),
    visible: mission.visible !== false,
    createdAt: toDate(mission.createdAt),
    updatedAt: toDate(mission.updatedAt),
  });
};

export const serializeProject = (missionOrder: string[]): string =>
  JSON.stringify(
    {
      format: PROJECT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      missionOrder,
    },
    null,
    2
  );

/** Mission order from the project file, or null when it is missing or unreadable. */
export const parseProjectFile = (text: string): string[] | null => {
  try {
    const data = JSON.parse(text) as Record<string, unknown> | null;
    if (!data || data.format !== PROJECT_FORMAT || !Array.isArray(data.missionOrder)) return null;
    return data.missionOrder.filter((id): id is string => typeof id === 'string');
  } catch {
    return null;
  }
};
