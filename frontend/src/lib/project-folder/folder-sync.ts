/**
 * Keeps missions on disk.
 *
 * Every mission lives in its own JSON file inside a folder the user picked once
 * (see folder-store). The zustand store stays the working copy the UI edits;
 * this module watches it and mirrors each changed mission into the IndexedDB
 * cache and then into the folder, a moment after the last edit, so a slider
 * drag becomes one write instead of hundreds.
 *
 * A mission is "dirty" from the moment it changes until its file is written.
 * The dirty list lives in the cache too, so edits made while folder access was
 * pending survive a reload and are written as soon as access comes back.
 *
 * All cache and folder work runs through one serial queue: a reconcile never
 * interleaves with a save, and saves of the same mission cannot overtake each
 * other.
 */

import JSZip from 'jszip';
import { MISSION_STORE_KEY, useMissionStore, type Mission } from '../../stores/mission-store';
import * as cache from './mission-cache';
import { useFolderStatus, type FolderStatus } from './folder-status';
import {
  isFolderStorageSupported,
  loadFolderHandle,
  pickProjectFolder,
  queryFolderPermission,
  removeMissionFile,
  requestFolderPermission,
  saveFolderHandle,
  scanFolder,
  trashMissionFile,
  writeMissionFile,
  writeProjectFile,
} from './folder-store';
import { MISSIONS_DIR, PROJECT_FILE_NAME, missionFileName, serializeMission, serializeProject } from './mission-file';

type MissionState = ReturnType<typeof useMissionStore.getState>;

const SAVE_DELAY_MS = 600;

let started = false;
/** Folder we may write to right now. */
let root: FileSystemDirectoryHandle | null = null;
/** Folder remembered from an earlier visit, possibly still waiting for access. */
let knownFolder: FileSystemDirectoryHandle | null = null;
let fileNames = new Map<string, string>();
let lastSeen = new Map<string, Mission>();
let lastOrderKey = '';
let dirtyIds = new Set<string>();
let pendingDeletes = new Set<string>();
const saveTimers = new Map<string, number>();
let orderTimer: number | null = null;
let queue: Promise<void> = Promise.resolve();
let runningTasks = 0;

const setStatus = (patch: Partial<FolderStatus>) => useFolderStatus.setState(patch);

const isBusy = () => runningTasks > 0 || saveTimers.size > 0 || orderTimer !== null;

const refreshStatus = () => {
  const current = useFolderStatus.getState();
  const patch: Partial<FolderStatus> = {};

  const unsavedCount = new Set([...dirtyIds, ...saveTimers.keys(), ...pendingDeletes]).size;
  if (current.unsavedCount !== unsavedCount) patch.unsavedCount = unsavedCount;

  if (root && (current.state === 'saving' || current.state === 'saved')) {
    const next = isBusy() ? 'saving' : 'saved';
    if (next !== current.state) {
      patch.state = next;
      if (next === 'saved') patch.lastSavedAt = Date.now();
    }
  }

  if (Object.keys(patch).length > 0) setStatus(patch);
};

const handleFailure = (error: unknown) => {
  console.error('[ProjectFolder] Save failed:', error);
  const name = (error as DOMException)?.name;

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    root = null;
    setStatus({ state: 'needs-permission', message: 'Access to the folder was withdrawn.' });
  } else if (name === 'NotFoundError') {
    root = null;
    setStatus({ state: 'error', message: 'The project folder was moved or deleted. Choose it again.' });
  } else {
    setStatus({ state: 'error', message: `Could not save: ${(error as Error)?.message ?? String(error)}` });
  }
};

const enqueue = (task: () => Promise<void>): Promise<void> => {
  runningTasks++;
  refreshStatus();
  const next = queue
    .then(task)
    .catch(handleFailure)
    .finally(() => {
      runningTasks--;
      refreshStatus();
    });
  queue = next;
  return next;
};

const persistDirty = () => cache.setMeta('dirty', [...dirtyIds]);
const persistPendingDeletes = () => cache.setMeta('pendingDeletes', [...pendingDeletes]);

/** A write went through after an error: the folder works again. */
const clearErrorAfterWrite = () => {
  if (root && useFolderStatus.getState().state === 'error') setStatus({ state: 'saving', message: null });
};

const saveMission = (id: string) =>
  enqueue(async () => {
    // Read at run time, not when scheduled: always the newest version.
    const mission = useMissionStore.getState().missions.find((item) => item.id === id);
    if (!mission) return;

    if (!dirtyIds.has(id)) {
      dirtyIds.add(id);
      await persistDirty();
    }
    await cache.putMission(mission);

    const folder = root;
    if (!folder) return;
    await writeMissionFile(folder, mission, fileNames);
    dirtyIds.delete(id);
    await persistDirty();
    clearErrorAfterWrite();
  });

const saveOrder = () =>
  enqueue(async () => {
    const order = useMissionStore.getState().missions.map((mission) => mission.id);
    await cache.setMeta('order', order);
    if (root) await writeProjectFile(root, order);
  });

const scheduleSave = (id: string) => {
  const existing = saveTimers.get(id);
  if (existing !== undefined) window.clearTimeout(existing);
  saveTimers.set(
    id,
    window.setTimeout(() => {
      saveTimers.delete(id);
      void saveMission(id);
    }, SAVE_DELAY_MS)
  );
  refreshStatus();
};

const scheduleOrderSave = () => {
  if (orderTimer !== null) window.clearTimeout(orderTimer);
  orderTimer = window.setTimeout(() => {
    orderTimer = null;
    void saveOrder();
  }, SAVE_DELAY_MS);
  refreshStatus();
};

const removeMission = (id: string) => {
  const timer = saveTimers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    saveTimers.delete(id);
  }

  void enqueue(async () => {
    if (useMissionStore.getState().missions.some((mission) => mission.id === id)) return;

    dirtyIds.delete(id);
    pendingDeletes.add(id);
    await Promise.all([persistDirty(), persistPendingDeletes()]);
    await cache.deleteMission(id);

    const folder = root;
    if (!folder) return;
    await trashMissionFile(folder, id, fileNames);
    pendingDeletes.delete(id);
    await persistPendingDeletes();
  });
};

/** Write every pending change now instead of after the delay. */
const flushPendingSaves = () => {
  for (const [id, timer] of saveTimers) {
    window.clearTimeout(timer);
    saveTimers.delete(id);
    void saveMission(id);
  }
  if (orderTimer !== null) {
    window.clearTimeout(orderTimer);
    orderTimer = null;
    void saveOrder();
  }
};

const handleStoreChange = (state: MissionState, previous: MissionState) => {
  if (state.missions === previous.missions) return;

  const next = new Map<string, Mission>();
  for (const mission of state.missions) {
    next.set(mission.id, mission);
    // Store updates replace only the changed mission object, so a reference
    // check finds exactly the missions that need writing.
    if (lastSeen.get(mission.id) !== mission) scheduleSave(mission.id);
  }
  for (const id of lastSeen.keys()) {
    if (!next.has(id)) removeMission(id);
  }
  lastSeen = next;

  const orderKey = state.missions.map((mission) => mission.id).join('|');
  if (orderKey !== lastOrderKey) {
    lastOrderKey = orderKey;
    scheduleOrderSave();
  }
};

/** Put missions into the store without them counting as edits. */
const applyMissions = (missions: Mission[]) => {
  lastSeen = new Map(missions.map((mission) => [mission.id, mission]));
  lastOrderKey = missions.map((mission) => mission.id).join('|');

  const { activeMissionId } = useMissionStore.getState();
  useMissionStore.setState({
    missions,
    activeMissionId: activeMissionId && missions.some((m) => m.id === activeMissionId) ? activeMissionId : null,
  });
};

const orderMissions = (missions: Mission[], order: string[]) => {
  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  return [...missions].sort(
    (a, b) =>
      (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) ||
      a.createdAt.getTime() - b.createdAt.getTime()
  );
};

/** Union by id; the more recently updated copy wins. */
const mergeNewest = (base: Mission[], extra: Mission[]) => {
  const byId = new Map(base.map((mission) => [mission.id, mission]));
  for (const mission of extra) {
    const existing = byId.get(mission.id);
    if (!existing || mission.updatedAt.getTime() > existing.updatedAt.getTime()) byId.set(mission.id, mission);
  }
  return [...byId.values()];
};

/**
 * Bring the folder and the app into agreement.
 *
 * - on disk only                      -> loaded (created or copied in by hand)
 * - in the app only, dirty            -> written (made while the folder was away)
 * - in the app only, clean            -> dropped (deleted from the folder by hand,
 *                                        or another project folder was opened)
 * - both, app copy dirty and not older -> app copy written
 * - both, otherwise                   -> disk copy wins
 *
 * An empty folder adopts everything: choosing a fresh folder copies the
 * current missions into it.
 */
const reconcile = async (handle: FileSystemDirectoryHandle) => {
  const scan = await scanFolder(handle);
  const current = useMissionStore.getState().missions;
  const onDiskById = new Map(scan.missions.map((mission) => [mission.id, mission]));
  const duplicateIds = new Set(scan.duplicates.map((duplicate) => duplicate.mission.id));
  const isEmptyFolder = !scan.hasProjectFile && scan.missions.length === 0 && scan.unreadable.length === 0;
  // With unreadable files around, a missing mission may just be the broken
  // file — keep the browser copy and write it back rather than dropping it.
  const keepMissing = isEmptyFolder || scan.unreadable.length > 0;

  const result: Mission[] = [];
  const toWrite: Mission[] = [];
  const toCache: Mission[] = [];
  const toDrop: string[] = [];

  for (const mission of current) {
    const onDisk = onDiskById.get(mission.id);
    onDiskById.delete(mission.id);

    if (!onDisk) {
      if (keepMissing || dirtyIds.has(mission.id)) {
        result.push(mission);
        toWrite.push(mission);
      } else {
        toDrop.push(mission.id);
      }
    } else if (dirtyIds.has(mission.id) && mission.updatedAt.getTime() >= onDisk.updatedAt.getTime()) {
      result.push(mission);
      toWrite.push(mission);
    } else if (JSON.stringify(onDisk) === JSON.stringify(mission)) {
      result.push(mission);
    } else {
      result.push(onDisk);
      toCache.push(onDisk);
    }
  }

  for (const [id, onDisk] of onDiskById) {
    if (pendingDeletes.has(id)) continue; // deleted in the app while the folder was away
    result.push(onDisk);
    toCache.push(onDisk);
    if (duplicateIds.has(id)) toWrite.push(onDisk);
  }

  root = handle;
  knownFolder = handle;
  fileNames = scan.fileNames;

  for (const mission of toWrite) await writeMissionFile(handle, mission, fileNames);
  for (const duplicate of scan.duplicates) await removeMissionFile(handle, duplicate.fileName);
  for (const id of pendingDeletes) await trashMissionFile(handle, id, fileNames);

  const currentOrder = current.map((mission) => mission.id);
  const ordered = orderMissions(
    result,
    scan.order && !isEmptyFolder ? [...scan.order, ...currentOrder] : currentOrder
  );
  await writeProjectFile(
    handle,
    ordered.map((mission) => mission.id)
  );

  for (const mission of toCache) await cache.putMission(mission);
  for (const id of toDrop) await cache.deleteMission(id);
  dirtyIds.clear();
  pendingDeletes.clear();
  await Promise.all([
    persistDirty(),
    persistPendingDeletes(),
    cache.setMeta(
      'order',
      ordered.map((mission) => mission.id)
    ),
  ]);
  await saveFolderHandle(handle);

  // Edits made while the folder was being read must not be overwritten. Their
  // saves are already scheduled; just keep the live objects.
  const snapshot = new Map(current.map((mission) => [mission.id, mission]));
  const live = new Map(useMissionStore.getState().missions.map((mission) => [mission.id, mission]));
  const final: Mission[] = [];
  for (const mission of ordered) {
    const liveMission = live.get(mission.id);
    if (snapshot.has(mission.id) && !liveMission) continue; // deleted meanwhile
    final.push(liveMission && liveMission !== snapshot.get(mission.id) ? liveMission : mission);
  }
  for (const mission of live.values()) {
    if (!snapshot.has(mission.id)) final.push(mission); // created meanwhile
  }
  applyMissions(final);

  setStatus({
    state: 'saved',
    folderName: handle.name,
    lastSavedAt: Date.now(),
    message: scan.unreadable.length
      ? `${scan.unreadable.length} file(s) in ${MISSIONS_DIR}/ could not be read and were left untouched: ${scan.unreadable.join(', ')}`
      : null,
  });
};

const connect = async (handle: FileSystemDirectoryHandle) => {
  setStatus({ state: 'connecting', folderName: handle.name, message: null });

  // Pending edits are handled by the reconcile, as dirty missions.
  for (const [id, timer] of saveTimers) {
    window.clearTimeout(timer);
    dirtyIds.add(id);
  }
  saveTimers.clear();
  if (orderTimer !== null) {
    window.clearTimeout(orderTimer);
    orderTimer = null;
  }

  await enqueue(() => reconcile(handle));
};

const warnIfUnsaved = (event: BeforeUnloadEvent) => {
  if (!isBusy()) return;
  flushPendingSaves();
  event.preventDefault();
  event.returnValue = '';
};

/**
 * Load missions from the browser cache, move over missions still sitting in
 * localStorage, then reopen the project folder if access is still granted.
 */
const boot = async () => {
  void navigator.storage?.persist?.().catch(() => false);

  const [cached, order, dirty, deletes] = await Promise.all([
    cache.getAllMissions(),
    cache.getMeta<string[]>('order'),
    cache.getMeta<string[]>('dirty'),
    cache.getMeta<string[]>('pendingDeletes'),
  ]);
  dirtyIds = new Set(dirty ?? []);
  pendingDeletes = new Set(deletes ?? []);

  const { missionsMigrated } = useMissionStore.getState();
  // Missions in memory now: from localStorage (older versions kept them there)
  // or created in the instant before the cache answered.
  const inMemory = useMissionStore.getState().missions;
  const cachedById = new Map(cached.map((mission) => [mission.id, mission]));
  const newer = inMemory.filter((mission) => {
    const copy = cachedById.get(mission.id);
    return !copy || mission.updatedAt.getTime() > copy.updatedAt.getTime();
  });

  if (!missionsMigrated && inMemory.length > 0) {
    const raw = localStorage.getItem(MISSION_STORE_KEY);
    if (raw) await cache.setMeta('legacyBackup', raw);
  }

  if (newer.length > 0) {
    newer.forEach((mission) => dirtyIds.add(mission.id));
    await persistDirty();
    for (const mission of newer) await cache.putMission(mission);
  }

  if (!missionsMigrated) {
    // localStorage lets go of the missions only once the cache verifiably
    // holds every single one.
    const stored = new Set((await cache.getAllMissions()).map((mission) => mission.id));
    if (!inMemory.every((mission) => stored.has(mission.id))) {
      throw new Error('the missions could not be copied into browser storage');
    }
  }

  const latest = useMissionStore.getState().missions;
  applyMissions(orderMissions(mergeNewest(cached, latest), order ?? latest.map((mission) => mission.id)));
  if (!missionsMigrated) useMissionStore.getState().markMissionsMigrated();

  useMissionStore.subscribe(handleStoreChange);
  window.addEventListener('pagehide', flushPendingSaves);
  window.addEventListener('beforeunload', warnIfUnsaved);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSaves();
  });

  const newerIds = new Set(newer.map((mission) => mission.id));
  latest.forEach((mission) => {
    if (!cachedById.has(mission.id) && !newerIds.has(mission.id)) scheduleSave(mission.id);
  });
  if (!order) scheduleOrderSave();
  refreshStatus();

  if (!isFolderStorageSupported()) {
    setStatus({ state: 'unsupported' });
    return;
  }

  const handle = await loadFolderHandle();
  if (!handle) {
    setStatus({ state: 'no-folder' });
    return;
  }

  knownFolder = handle;
  if ((await queryFolderPermission(handle)) === 'granted') {
    await connect(handle);
  } else {
    setStatus({ state: 'needs-permission', folderName: handle.name, message: null });
  }
};

/** Start once, from the app shell. Safe to call again (React StrictMode). */
export const startMissionPersistence = () => {
  if (started) return;
  started = true;

  boot().catch((error) => {
    console.error('[ProjectFolder] Startup failed:', error);
    setStatus({
      state: 'error',
      message: `Browser storage is not available (${(error as Error)?.message ?? String(error)}). Missions stay in the old storage for now.`,
    });
  });
};

/** From a click. An empty folder receives the current missions; a project folder is opened. */
export const chooseProjectFolder = async () => {
  const handle = await pickProjectFolder();
  if (!handle) return;
  knownFolder = handle;
  await connect(handle);
};

/** From a click: re-grant access to the remembered folder. */
export const reconnectProjectFolder = async () => {
  const handle = knownFolder;
  if (!handle) return chooseProjectFolder();

  if (!(await requestFolderPermission(handle))) {
    setStatus({ state: 'needs-permission', folderName: handle.name, message: 'Access was not granted.' });
    return;
  }
  await connect(handle);
};

/** Pick up files edited or copied into the folder outside the app. */
export const reloadProjectFolder = async () => {
  if (root) await connect(root);
};

/** Zip with the same layout as a project folder — a backup that works in every browser. */
export const exportAllMissions = async () => {
  const { missions } = useMissionStore.getState();
  const zip = new JSZip();
  const dir = zip.folder(MISSIONS_DIR);
  missions.forEach((mission) => dir?.file(missionFileName(mission), serializeMission(mission)));
  zip.file(PROJECT_FILE_NAME, serializeProject(missions.map((mission) => mission.id)));

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `droneverse-missions-${new Date().toISOString().slice(0, 10)}.zip`;
  link.click();
  URL.revokeObjectURL(url);
};
