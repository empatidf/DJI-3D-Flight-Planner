/**
 * Save state of the project folder, for the UI.
 *
 * A separate store on purpose: the mission store is persisted, and every
 * `set()` there rewrites localStorage — status ticks during a slider drag
 * must not.
 */

import { create } from 'zustand';

export type FolderState =
  | 'loading' // reading the browser cache
  | 'unsupported' // no File System Access API: browser storage only
  | 'no-folder' // supported, but no folder chosen yet
  | 'needs-permission' // folder remembered, access must be re-granted by a click
  | 'connecting' // reading and reconciling the folder
  | 'saving'
  | 'saved'
  | 'error';

export interface FolderStatus {
  state: FolderState;
  folderName: string | null;
  message: string | null;
  /** changes that exist only in the browser so far */
  unsavedCount: number;
  lastSavedAt: number | null;
}

export const useFolderStatus = create<FolderStatus>(() => ({
  state: 'loading',
  folderName: null,
  message: null,
  unsavedCount: 0,
  lastSavedAt: null,
}));
