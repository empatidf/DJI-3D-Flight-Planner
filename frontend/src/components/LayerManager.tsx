/**
 * LayerManager Component
 * Manages visibility and opacity of map layers
 */

import React from 'react';
import { useMissionStore, type Layer } from '../stores/mission-store';
import { fetchCesiumAssets, filterImageryAssets, getAssetMetadata, validateCesiumToken, type CesiumIonAsset } from '../lib/cesium-ion-api';
import { getIonAssetBounds, type IonAssetType } from '../lib/ion-asset-bounds';
import {
  buildLocalLayer,
  getLocalRegistryVersion,
  hasLocalEntry,
  setLocalEntry,
  subscribeLocalRegistry,
  type LocalLayerKind,
} from '../lib/local-tiff/registry';
import {
  deleteHandle,
  ensurePermission,
  getHandle,
  isFsaSupported,
  makeHandleKey,
  pickTiffFile,
  putHandle,
} from '../lib/local-tiff/local-file-store';
import './LayerManager.css';

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
      layerA.cesiumAssetType === layerB.cesiumAssetType &&
      // localBounds is fixed when the layer is created, so it cannot diverge
      // while the id and the handle key still match.
      layerA.localKind === layerB.localKind &&
      layerA.localFileName === layerB.localFileName &&
      layerA.localHandleKey === layerB.localHandleKey
    );
  });
};

export const LayerManager = () => {
  const layers = useMissionStore((state) => state.layers);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const setMissionLayerSnapshot = useMissionStore((state) => state.setMissionLayerSnapshot);
  const viewMode = useMissionStore((state) => state.viewMode);
  const toggleLayerVisibility = useMissionStore((state) => state.toggleLayerVisibility);
  const updateLayer = useMissionStore((state) => state.updateLayer);
  const deleteLayer = useMissionStore((state) => state.deleteLayer);
  const setViewMode = useMissionStore((state) => state.setViewMode);
  const addLayer = useMissionStore((state) => state.addLayer);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);
  const cesiumToken = useMissionStore((state) => state.cesiumToken);
  const setCesiumToken = useMissionStore((state) => state.setCesiumToken);
  
  const [cesiumAssets, setCesiumAssets] = React.useState<CesiumIonAsset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = React.useState<string>('');
  const [isLoadingAssets, setIsLoadingAssets] = React.useState(false);
  const [zoomingLayerId, setZoomingLayerId] = React.useState<string | null>(null);
  const [tokenInput, setTokenInput] = React.useState('');
  const [isCheckingToken, setIsCheckingToken] = React.useState(false);
  const [isTokenEditing, setIsTokenEditing] = React.useState(true);
  const [tokenStatus, setTokenStatus] = React.useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // The registry holds the live CogSource objects. It is not part of zustand,
  // so subscribe to it explicitly: restoring a file after a reload changes
  // nothing in `layers` but must still re-render this panel.
  React.useSyncExternalStore(subscribeLocalRegistry, getLocalRegistryVersion);
  const [localStatus, setLocalStatus] = React.useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [isLoadingLocal, setIsLoadingLocal] = React.useState(false);

  React.useEffect(() => {
    setTokenInput(cesiumToken || '');
    setIsTokenEditing(!cesiumToken);
  }, [cesiumToken]);

  const maskToken = (token: string) => {
    if (!token) return '';
    if (token.length <= 8) return '••••••••';
    return `••••••••••••${token.slice(-6)}`;
  };

  const handleSaveToken = async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setTokenStatus({ type: 'error', message: 'Please enter a Cesium token' });
      return;
    }

    setIsCheckingToken(true);
    setTokenStatus({ type: 'info', message: 'Checking token with Cesium...' });
    const result = await validateCesiumToken(trimmed);
    setIsCheckingToken(false);

    if (!result.valid) {
      setTokenStatus({ type: 'error', message: result.message });
      return;
    }

    setCesiumToken(trimmed);
    setIsTokenEditing(false);
    setTokenStatus({ type: 'success', message: 'Token saved and activated' });
  };

  const handleStartTokenEdit = () => {
    setIsTokenEditing(true);
    setTokenStatus({ type: 'info', message: 'Edit token and click Save Token' });
  };

  const handleDeleteToken = () => {
    setCesiumToken('');
    setTokenInput('');
    setIsTokenEditing(true);
    setCesiumAssets([]);
    setSelectedAssetId('');
    setTokenStatus({ type: 'info', message: 'Token removed' });
  };
  
  // Fetch Cesium Ion assets on component mount
  React.useEffect(() => {
    const loadAssets = async () => {
      if (!cesiumToken) {
        setCesiumAssets([]);
        return;
      }

      setIsLoadingAssets(true);
      try {
        const allAssets = await fetchCesiumAssets(cesiumToken);
        const imageryAssets = filterImageryAssets(allAssets);
        setCesiumAssets(imageryAssets);
      } catch (error) {
        console.error('Failed to load Cesium Ion assets:', error);
      } finally {
        setIsLoadingAssets(false);
      }
    };
    loadAssets();
  }, [cesiumToken]);

  React.useEffect(() => {
    if (!activeMissionId) return;

    const currentMission = useMissionStore
      .getState()
      .missions.find((mission) => mission.id === activeMissionId);

    // Missions load asynchronously; nothing to snapshot into before they arrive.
    if (!currentMission) return;

    const nextSnapshot = layers.map((layer) => ({ ...layer }));

    if (currentMission.layerSnapshot && areLayersEquivalent(currentMission.layerSnapshot, nextSnapshot)) {
      return;
    }

    setMissionLayerSnapshot(activeMissionId, nextSnapshot);
  }, [layers, activeMissionId, setMissionLayerSnapshot]);

  const handleAddCesiumAsset = async () => {
    if (!selectedAssetId) {
      alert('Please select a Cesium Ion asset');
      return;
    }

    if (!cesiumToken) {
      alert('Please add a valid Cesium token first');
      return;
    }
    
    const assetId = parseInt(selectedAssetId);
    const asset = cesiumAssets.find(a => a.id === assetId);
    
    if (!asset) return;
    
    const assetType = asset.type as IonAssetType;

    try {
      // The bounds come from the data itself; the metadata record has none.
      const [metadata, bounds] = await Promise.all([
        getAssetMetadata(assetId, cesiumToken),
        getIonAssetBounds(assetId, assetType, cesiumToken),
      ]);

      // Add layer with Cesium Ion asset
      addLayer({
        name: asset.name,
        type: 'cesium-ion',
        visible: true,
        opacity: asset.type === 'TERRAIN' ? 1.0 : 1.0,
        cesiumAssetId: assetId,
        cesiumAssetType: assetType,
        data: metadata,
      });

      if (bounds) flyToBounds(bounds);

      // Reset selection
      setSelectedAssetId('');
      
    } catch (error) {
      console.error('Failed to add Cesium Ion asset:', error);
      alert('Failed to add asset: ' + error);
    }
  };

  /**
   * Frame a dataset. Padding the extent matters: flying to the bare rectangle
   * lands far too close on a small site, which makes Cesium demand max-detail
   * tiles across the whole view.
   */
  const flyToBounds = (bounds: { west: number; south: number; east: number; north: number }) => {
    const maxDiff = Math.max(bounds.east - bounds.west, bounds.north - bounds.south) * 1.25;
    setCameraTarget({
      longitude: (bounds.west + bounds.east) / 2,
      latitude: (bounds.south + bounds.north) / 2,
      altitude: Math.min(Math.max(maxDiff * 100000, 500), 20_000_000),
      heading: 0,
      pitch: -90,
      roll: 0,
    });
  };

  const handleZoomToIonLayer = async (layer: Layer) => {
    const assetId = Number(layer.cesiumAssetId);
    if (!Number.isFinite(assetId) || !cesiumToken) return;

    setZoomingLayerId(layer.id);
    try {
      const bounds = await getIonAssetBounds(assetId, layer.cesiumAssetType, cesiumToken);
      if (bounds) {
        flyToBounds(bounds);
      } else {
        alert(`Could not determine where ${layer.name} is located`);
      }
    } finally {
      setZoomingLayerId(null);
    }
  };

  const localLayers = layers.filter((layer) => layer.type === 'local-tiff');
  const localTerrainLayer = localLayers.find((layer) => layer.localKind === 'TERRAIN');

  const handleAddLocalFile = async (kind: LocalLayerKind) => {
    const picked = await pickTiffFile();
    if (!picked) return;

    setIsLoadingLocal(true);
    setLocalStatus({ type: 'info', message: `Opening ${picked.file.name}…` });

    try {
      const entry = await buildLocalLayer(picked.file, kind, (message) =>
        setLocalStatus({ type: 'info', message })
      );

      // Only one DSM can drive the terrain at a time. The map effect unloads
      // the old one once it sees the row disappear.
      if (kind === 'TERRAIN' && localTerrainLayer) {
        if (localTerrainLayer.localHandleKey) await deleteHandle(localTerrainLayer.localHandleKey);
        deleteLayer(localTerrainLayer.id);
      }

      const handleKey = picked.handle ? makeHandleKey() : undefined;
      if (handleKey) await putHandle(handleKey, picked.handle, picked.file.name);

      const id = addLayer({
        name: picked.file.name,
        type: 'local-tiff',
        visible: true,
        opacity: 1.0,
        localKind: kind,
        localFileName: picked.file.name,
        localHandleKey: handleKey,
        localBounds: entry.extent,
      });

      setLocalEntry(id, entry);
      flyToBounds(entry.extent);
      setLocalStatus({
        type: 'success',
        message: handleKey || !isFsaSupported()
          ? entry.summary
          : `${entry.summary}\nThis browser cannot remember the file — it must be picked again after a reload.`,
      });
    } catch (error) {
      console.error('Failed to load local GeoTIFF:', error);
      setLocalStatus({ type: 'error', message: (error as Error).message });
    } finally {
      setIsLoadingLocal(false);
    }
  };

  /**
   * Re-open a layer's file after a reload. Runs from a click because Chrome
   * needs a user gesture to re-grant read access to a stored handle.
   */
  const handleRestoreLocal = async (layer: Layer) => {
    setIsLoadingLocal(true);
    setLocalStatus({ type: 'info', message: `Restoring ${layer.localFileName ?? layer.name}…` });

    try {
      let file: File | null = null;

      const stored = layer.localHandleKey ? await getHandle(layer.localHandleKey) : null;
      if (stored && (await ensurePermission(stored.handle))) {
        file = await stored.handle.getFile();
      }

      // No handle, permission refused, or the file moved: ask for it again.
      if (!file) {
        const picked = await pickTiffFile();
        if (!picked) {
          setLocalStatus({ type: 'info', message: 'Restore cancelled' });
          return;
        }
        file = picked.file;
        if (picked.handle && layer.localHandleKey) {
          await putHandle(layer.localHandleKey, picked.handle, picked.file.name);
        }
      }

      const entry = await buildLocalLayer(file, layer.localKind ?? 'IMAGERY', (message) =>
        setLocalStatus({ type: 'info', message })
      );
      setLocalEntry(layer.id, entry);
      setLocalStatus({ type: 'success', message: entry.summary });
    } catch (error) {
      console.error('Failed to restore local GeoTIFF:', error);
      setLocalStatus({ type: 'error', message: (error as Error).message });
    } finally {
      setIsLoadingLocal(false);
    }
  };

  /**
   * Removing the row is enough to unload the file: the map effect notices the
   * layer is gone, detaches it from the viewer and only then frees the raster.
   * Disposing here instead would pull the provider out from under Cesium.
   */
  const handleRemoveLayer = (layer: Layer) => {
    if (layer.type === 'local-tiff' && layer.localHandleKey) {
      void deleteHandle(layer.localHandleKey);
    }
    deleteLayer(layer.id);
  };

  const handleRemoveAllLocal = () => {
    localLayers.forEach(handleRemoveLayer);
    setLocalStatus({ type: 'info', message: 'Local files unloaded' });
  };

  const handleZoomToLocalData = () => {
    const target = localLayers.find((layer) => layer.visible && layer.localBounds)
      ?? localLayers.find((layer) => layer.localBounds);
    if (target?.localBounds) flyToBounds(target.localBounds);
  };

  return (
    <div className="layer-manager">
      <div className="view-mode-switch" role="group" aria-label="Map view mode">
        {(
          [
            ['SCENE3D', '3D'],
            ['COLUMBUS_VIEW', '2.5D'],
            ['SCENE2D', '2D'],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            className={viewMode === mode ? 'is-active' : ''}
            aria-pressed={viewMode === mode}
            onClick={() => setViewMode(mode)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="layers-list">
        {layers.map((layer) => (
          <div key={layer.id} className="layer-item">
            <div className="layer-header">
              <label>
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={() => toggleLayerVisibility(layer.id)}
                />
                <span className="layer-name">{layer.name}</span>
                {layer.type === 'cesium-ion' && layer.cesiumAssetType && (
                  <span
                    className={`layer-type-badge ${layer.cesiumAssetType === 'TERRAIN' ? 'terrain' : 'imagery'}`}
                  >
                    {layer.cesiumAssetType}
                  </span>
                )}
                {layer.type === 'local-tiff' && (
                  <span
                    className={`layer-type-badge local ${layer.localKind === 'TERRAIN' ? 'terrain' : 'imagery'}`}
                  >
                    LOCAL · {layer.localKind ?? 'IMAGERY'}
                  </span>
                )}
              </label>

              {layer.type === 'cesium-ion' && Number.isFinite(Number(layer.cesiumAssetId)) && (
                <button
                  className="layer-zoom-btn"
                  onClick={() => handleZoomToIonLayer(layer)}
                  disabled={zoomingLayerId === layer.id || !cesiumToken}
                  title="Center the map on this asset"
                  aria-label={`Center the map on ${layer.name}`}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                    <circle cx="8" cy="8" r="4.5" />
                    <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
                    <path d="M8 0.5v3M8 12.5v3M0.5 8h3M12.5 8h3" strokeLinecap="round" />
                  </svg>
                </button>
              )}

              {layer.id !== 'basemap' && layer.id !== 'terrain' && (
                <button
                  className="layer-remove-btn"
                  onClick={() => handleRemoveLayer(layer)}
                  title="Remove layer"
                  aria-label={`Remove ${layer.name}`}
                >
                  ✕
                </button>
              )}
            </div>

            {/* A local layer whose file is not open yet — the handle survived
                the reload but the raster did not. */}
            {layer.type === 'local-tiff' && !hasLocalEntry(layer.id) && (
              <div className="layer-controls layer-restore">
                <span className="layer-restore-hint">File not loaded</span>
                <button
                  className="btn-action"
                  onClick={() => handleRestoreLocal(layer)}
                  disabled={isLoadingLocal}
                  title={`Re-open ${layer.localFileName ?? layer.name}`}
                >
                  Restore
                </button>
              </div>
            )}

            {layer.visible && !(layer.type === 'local-tiff' && !hasLocalEntry(layer.id)) &&
             !(layer.type === 'local-tiff' && layer.localKind === 'TERRAIN') && (
              <div className="layer-controls">
                <label>
                  Opacity:
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={layer.opacity}
                    onChange={(e) =>
                      updateLayer(layer.id, { opacity: parseFloat(e.target.value) })
                    }
                  />
                  <span>{Math.round(layer.opacity * 100)}%</span>
                </label>
              </div>
            )}
          </div>
        ))}
      </div>

      {cesiumToken && (
        <div className="layer-actions">
          <select
            className="layer-asset-select"
            value={selectedAssetId}
            onChange={(e) => setSelectedAssetId(e.target.value)}
            disabled={isLoadingAssets}
          >
            <option value="">{isLoadingAssets ? 'Loading your assets…' : 'Add a layer from Cesium Ion'}</option>
            {cesiumAssets.map(asset => (
              <option key={asset.id} value={asset.id}>
                {asset.name} ({asset.type})
              </option>
            ))}
          </select>
          <button
            className="btn-action"
            onClick={handleAddCesiumAsset}
            disabled={!selectedAssetId || isLoadingAssets}
            title="Add the selected asset to the map"
          >
            + Add
          </button>
        </div>
      )}

      {/* Deliberately not gated on cesiumToken: loading site data from disk is
          exactly what is needed when there is no Ion account and no internet. */}
      <details className="map-setup local-files" open={localLayers.length > 0}>
        <summary>
          <span>Local files (offline)</span>
          <span className={`setup-state ${localLayers.length > 0 ? 'is-ok' : ''}`}>
            {localLayers.length > 0 ? `${localLayers.length} loaded` : 'GeoTIFF from disk'}
          </span>
        </summary>

        <div className="token-section">
          <p className="token-hint">
            Load a site orthophoto and DSM straight from this computer. Nothing is uploaded and no
            token is needed. Cloud Optimized GeoTIFFs load fastest.
          </p>
          <div className="local-file-actions">
            <button
              className="btn-action"
              onClick={() => handleAddLocalFile('IMAGERY')}
              disabled={isLoadingLocal}
              title="Add a local orthophoto as an imagery layer"
            >
              + Orthophoto
            </button>
            <button
              className="btn-action"
              onClick={() => handleAddLocalFile('TERRAIN')}
              disabled={isLoadingLocal}
              title="Use a local DSM as the terrain"
            >
              {localTerrainLayer ? 'Replace DSM' : '+ DSM terrain'}
            </button>
            <button
              className="btn-action"
              onClick={handleZoomToLocalData}
              disabled={isLoadingLocal || localLayers.length === 0}
              title="Fly the camera to the local data"
            >
              Zoom to data
            </button>
            <button
              className="btn-action btn-danger"
              onClick={handleRemoveAllLocal}
              disabled={isLoadingLocal || localLayers.length === 0}
              title="Unload every local file and free the memory it holds"
            >
              Remove all
            </button>
          </div>
          {localStatus && <div className={`token-status ${localStatus.type}`}>{localStatus.message}</div>}
        </div>
      </details>

      <details className="map-setup" open={!cesiumToken}>
        <summary>
          <span>Cesium Ion account</span>
          <span className={`setup-state ${cesiumToken ? 'is-ok' : 'is-missing'}`}>
            {cesiumToken ? maskToken(cesiumToken) : 'No token yet'}
          </span>
        </summary>

        <div className="token-section">
          <p className="token-hint">
            A token lets the map load Cesium Ion imagery, terrain and your own uploaded assets.
          </p>
          <input
            className="token-input"
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Paste your access token"
            disabled={!!cesiumToken && !isTokenEditing}
          />
          <div className="token-actions">
            <button
              className="btn-action token-save"
              onClick={cesiumToken && !isTokenEditing ? handleStartTokenEdit : handleSaveToken}
              disabled={isCheckingToken}
            >
              {isCheckingToken ? 'Checking…' : cesiumToken && !isTokenEditing ? 'Change token' : 'Save token'}
            </button>
            <button className="btn-action token-delete" onClick={handleDeleteToken} disabled={!cesiumToken}>
              Delete
            </button>
          </div>
          {tokenStatus && <div className={`token-status ${tokenStatus.type}`}>{tokenStatus.message}</div>}
        </div>
      </details>
    </div>
  );
};

