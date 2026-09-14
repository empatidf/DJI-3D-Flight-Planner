/**
 * Where missions are saved, and the buttons to fix it when they are not.
 *
 * Sits at the top of the mission list so "not on disk" is never out of sight.
 */

import { useState } from 'react';
import { useFolderStatus } from '../lib/project-folder/folder-status';
import {
  chooseProjectFolder,
  exportAllMissions,
  reconnectProjectFolder,
  reloadProjectFolder,
} from '../lib/project-folder/folder-sync';

const SWITCH_CONFIRM =
  'Use a different folder?\n\n' +
  '• An empty folder: your current missions are copied into it.\n' +
  '• A folder that already holds a project: that project is opened. ' +
  'Missions saved in the current folder stay there.';

export const ProjectFolderBar = () => {
  const { state, folderName, message, unsavedCount } = useFolderStatus();
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      console.error('[ProjectFolder] Action failed:', error);
      alert(`Something went wrong: ${(error as Error)?.message ?? String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const switchFolder = run(async () => {
    if (confirm(SWITCH_CONFIRM)) await chooseProjectFolder();
  });

  const exportButton = (
    <button
      type="button"
      className="folder-icon-btn"
      onClick={run(exportAllMissions)}
      disabled={busy}
      title="Download every mission as a .zip backup"
      aria-label="Export all missions"
    >
      ⤓
    </button>
  );

  const unsavedNote = unsavedCount > 0 ? ` ${unsavedCount} change${unsavedCount === 1 ? '' : 's'} not on disk yet.` : '';

  let tone: 'ok' | 'warn' | 'error' | 'muted' = 'muted';
  let title = folderName ?? 'Missions';
  let detail: string | null = null;
  let hint: string | null = null;
  let buttons: React.ReactNode = null;
  let icons: React.ReactNode = null;

  switch (state) {
    case 'loading':
      title = 'Loading missions…';
      break;

    case 'unsupported':
      tone = 'warn';
      title = 'Saved in this browser only';
      detail = 'Saving to a folder needs Chrome or Edge. Use the ⤓ button for backups.';
      icons = exportButton;
      break;

    case 'no-folder':
      tone = 'warn';
      title = 'Not saved to disk yet';
      detail = 'Choose a folder and every mission is kept there as a file.';
      buttons = (
        <button type="button" className="folder-btn is-primary" onClick={run(chooseProjectFolder)} disabled={busy}>
          Choose folder…
        </button>
      );
      icons = exportButton;
      break;

    case 'needs-permission':
      tone = 'warn';
      detail = `${message ?? 'The browser needs your OK to keep saving here.'}${unsavedNote}`;
      hint = 'Tip: pick “Allow on every visit” and this step is gone next time.';
      buttons = (
        <>
          <button type="button" className="folder-btn is-primary" onClick={run(reconnectProjectFolder)} disabled={busy}>
            Reconnect
          </button>
          <button type="button" className="folder-btn" onClick={switchFolder} disabled={busy}>
            Other folder…
          </button>
        </>
      );
      break;

    case 'connecting':
      detail = 'Opening folder…';
      break;

    case 'saving':
    case 'saved':
      tone = 'ok';
      detail = state === 'saving' ? 'Saving…' : message ?? 'All changes saved to disk';
      icons = (
        <>
          <button
            type="button"
            className="folder-icon-btn"
            onClick={run(reloadProjectFolder)}
            disabled={busy}
            title="Reload missions from the folder (after editing files outside the app)"
            aria-label="Reload from folder"
          >
            ↻
          </button>
          <button
            type="button"
            className="folder-icon-btn"
            onClick={switchFolder}
            disabled={busy}
            title="Use a different folder"
            aria-label="Change folder"
          >
            ⇄
          </button>
          {exportButton}
        </>
      );
      break;

    case 'error':
      tone = 'error';
      title = folderName ?? 'Saving failed';
      detail = `${message ?? 'Saving failed.'}${unsavedNote}`;
      buttons = (
        <>
          <button type="button" className="folder-btn is-primary" onClick={run(reconnectProjectFolder)} disabled={busy}>
            Retry
          </button>
          <button type="button" className="folder-btn" onClick={run(chooseProjectFolder)} disabled={busy}>
            Choose folder…
          </button>
        </>
      );
      icons = exportButton;
      break;
  }

  return (
    <div className={`folder-bar is-${tone}${state === 'saving' ? ' is-saving' : ''}`} role="status">
      <span className="folder-dot" aria-hidden="true" />
      <div className="folder-text">
        <span className="folder-title" title={title}>
          {folderName && state !== 'unsupported' && state !== 'no-folder' ? '📁 ' : ''}
          {title}
        </span>
        {detail && <span className="folder-detail">{detail}</span>}
        {hint && <span className="folder-hint">{hint}</span>}
        {buttons && <div className="folder-cta">{buttons}</div>}
      </div>
      {icons && <div className="folder-actions">{icons}</div>}
    </div>
  );
};
