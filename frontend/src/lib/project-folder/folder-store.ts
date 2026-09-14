/**
 * Reading and writing the project folder.
 *
 * Writes go through createWritable(), which fills a hidden swap file and only
 * replaces the real file on close(). A crash mid-save therefore leaves the
 * previous version of the mission intact instead of a half-written file.
 */

import { createMissionId, type Mission } from '../../stores/mission-store';
import { ensurePermission, getHandle, putHandle } from '../local-tiff/local-file-store';
import {
  MISSIONS_DIR,
  PROJECT_FILE_NAME,
  TRASH_DIR,
  missionFileName,
  parseMissionFile,
  parseProjectFile,
  serializeMission,
  serializeProject,
} from './mission-file';

const HANDLE_KEY = 'project-folder';

export const isFolderStorageSupported = () =>
  typeof window !== 'undefined' && window.isSecureContext && typeof window.showDirectoryPicker === 'function';

/** Null when the user closed the picker. */
export const pickProjectFolder = async (): Promise<FileSystemDirectoryHandle | null> => {
  try {
    return (await window.showDirectoryPicker?.({ id: 'droneverse-project', mode: 'readwrite' })) ?? null;
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') return null;
    throw error;
  }
};

export const saveFolderHandle = (handle: FileSystemDirectoryHandle) => putHandle(HANDLE_KEY, handle, handle.name);

export const loadFolderHandle = async (): Promise<FileSystemDirectoryHandle | null> =>
  ((await getHandle(HANDLE_KEY))?.handle as FileSystemDirectoryHandle | undefined) ?? null;

/** Never prompts, so it is safe outside a click. */
export const queryFolderPermission = async (handle: FileSystemDirectoryHandle): Promise<PermissionState> => {
  try {
    return (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
  } catch {
    return 'prompt';
  }
};

/** Must run inside a click: Chrome only shows the prompt with a user gesture. */
export const requestFolderPermission = (handle: FileSystemDirectoryHandle) => ensurePermission(handle, 'readwrite');

const isNotFound = (error: unknown) => (error as DOMException)?.name === 'NotFoundError';

const writeTextFile = async (dir: FileSystemDirectoryHandle, name: string, text: string) => {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
};

const missionsDir = (root: FileSystemDirectoryHandle) => root.getDirectoryHandle(MISSIONS_DIR, { create: true });

export interface FolderScan {
  missions: Mission[];
  /** mission id -> file name in missions/ */
  fileNames: Map<string, string>;
  /** Copied files that still carry another mission's id. Given a new id here. */
  duplicates: { fileName: string; mission: Mission }[];
  unreadable: string[];
  order: string[] | null;
  hasProjectFile: boolean;
}

export const scanFolder = async (root: FileSystemDirectoryHandle): Promise<FolderScan> => {
  const scan: FolderScan = {
    missions: [],
    fileNames: new Map(),
    duplicates: [],
    unreadable: [],
    order: null,
    hasProjectFile: false,
  };

  const dir = await missionsDir(root);
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== 'file' || !name.toLowerCase().endsWith('.json')) continue;

    try {
      const file = await (entry as FileSystemFileHandle).getFile();
      let mission = parseMissionFile(await file.text());

      if (scan.fileNames.has(mission.id)) {
        mission = { ...mission, id: createMissionId() };
        scan.duplicates.push({ fileName: name, mission });
      } else {
        scan.fileNames.set(mission.id, name);
      }
      scan.missions.push(mission);
    } catch (error) {
      console.warn(`[ProjectFolder] Skipping unreadable file ${name}:`, error);
      scan.unreadable.push(name);
    }
  }

  try {
    const file = await (await root.getFileHandle(PROJECT_FILE_NAME)).getFile();
    scan.hasProjectFile = true;
    scan.order = parseProjectFile(await file.text());
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  return scan;
};

/** Writes the mission and drops its previous file when a rename changed the name. */
export const writeMissionFile = async (
  root: FileSystemDirectoryHandle,
  mission: Mission,
  fileNames: Map<string, string>
) => {
  const dir = await missionsDir(root);
  const name = missionFileName(mission);
  const previous = fileNames.get(mission.id);

  await writeTextFile(dir, name, serializeMission(mission));

  // On a case-insensitive disk a case-only rename writes into the old file;
  // removing the "old" name would delete the file just written.
  if (previous && previous.toLowerCase() === name.toLowerCase()) {
    fileNames.set(mission.id, previous);
    return;
  }
  if (previous) await removeMissionFile(root, previous);
  fileNames.set(mission.id, name);
};

export const removeMissionFile = async (root: FileSystemDirectoryHandle, fileName: string) => {
  try {
    await (await missionsDir(root)).removeEntry(fileName);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
};

/** Moves a mission file into .trash/ with a timestamp, so a delete can be undone by hand. */
export const trashMissionFile = async (
  root: FileSystemDirectoryHandle,
  id: string,
  fileNames: Map<string, string>
) => {
  const name = fileNames.get(id);
  if (!name) return;

  let text: string;
  try {
    const file = await (await (await missionsDir(root)).getFileHandle(name)).getFile();
    text = await file.text();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    fileNames.delete(id);
    return;
  }

  // Copy and remove: FileSystemHandle.move() between folders is not in every Chromium build.
  const trash = await root.getDirectoryHandle(TRASH_DIR, { create: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeTextFile(trash, name.replace(/\.json$/i, `__deleted-${stamp}.json`), text);
  await removeMissionFile(root, name);
  fileNames.delete(id);
};

export const writeProjectFile = async (root: FileSystemDirectoryHandle, order: string[]) =>
  writeTextFile(root, PROJECT_FILE_NAME, serializeProject(order));
