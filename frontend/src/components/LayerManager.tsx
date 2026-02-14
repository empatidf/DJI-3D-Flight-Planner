/**
 * LayerManager Component
 * Manages visibility and opacity of map layers
 */

import React from 'react';
import { useMissionStore } from '../stores/mission-store';
import { fetchCesiumAssets, filterImageryAssets, getAssetMetadata, validateCesiumToken, type CesiumIonAsset } from '../lib/cesium-ion-api';
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
      layerA.cesiumAssetType === layerB.cesiumAssetType
    );
  });
};

export const LayerManager = () => {
  const layers = useMissionStore((state) => state.layers);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const updateMission = useMissionStore((state) => state.updateMission);
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
  const [tokenInput, setTokenInput] = React.useState('');
  const [isCheckingToken, setIsCheckingToken] = React.useState(false);
  const [isTokenEditing, setIsTokenEditing] = React.useState(true);
  const [tokenStatus, setTokenStatus] = React.useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

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

    const nextSnapshot = layers.map((layer) => ({ ...layer }));

    if (currentMission?.layerSnapshot && areLayersEquivalent(currentMission.layerSnapshot, nextSnapshot)) {
      return;
    }

    updateMission(activeMissionId, {
      layerSnapshot: nextSnapshot,
    });
  }, [layers, activeMissionId, updateMission]);

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
    
    try {
      // Get asset metadata for bounds
      const metadata = await getAssetMetadata(assetId, cesiumToken);
      
      // Add layer with Cesium Ion asset
      addLayer({
        name: asset.name,
        type: 'cesium-ion',
        visible: true,
        opacity: asset.type === 'TERRAIN' ? 1.0 : 1.0,
        cesiumAssetId: assetId,
        cesiumAssetType: asset.type as 'IMAGERY' | 'TERRAIN' | '3DTILES',
        data: metadata,
      });
      
      // Fly to asset if it has bounds
      if (metadata?.rectangle) {
        const rect = metadata.rectangle;
        const centerLon = (rect.west + rect.east) / 2;
        const centerLat = (rect.south + rect.north) / 2;
        const lonDiff = rect.east - rect.west;
        const latDiff = rect.north - rect.south;
        const maxDiff = Math.max(lonDiff, latDiff);
        const altitude = maxDiff * 100000;
        
        setCameraTarget({
          longitude: centerLon,
          latitude: centerLat,
          altitude: Math.max(altitude, 500),
          heading: 0,
          pitch: -90,
          roll: 0,
        });
      }
      
      // Reset selection
      setSelectedAssetId('');
      
    } catch (error) {
      console.error('Failed to add Cesium Ion asset:', error);
      alert('Failed to add asset: ' + error);
    }
  };

  return (
    <div className="layer-manager">
      <h3>Cesium Layer Manager</h3>

      <div className="token-section">
        <div className="token-section-title">Add Cesium Token</div>
        <input
          className="token-input"
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="Paste Cesium Ion access token"
          disabled={!!cesiumToken && !isTokenEditing}
        />
        <div className="token-actions">
          <button
            className="btn-action token-save"
            onClick={cesiumToken && !isTokenEditing ? handleStartTokenEdit : handleSaveToken}
            disabled={isCheckingToken}
          >
            {isCheckingToken ? 'Checking...' : cesiumToken && !isTokenEditing ? 'Change Token' : 'Save Token'}
          </button>
          <button className="btn-action token-delete" onClick={handleDeleteToken} disabled={!cesiumToken}>
            Delete
          </button>
        </div>
        <div className="token-saved-text">
          {cesiumToken ? `Saved: ${maskToken(cesiumToken)} (Added)` : 'Saved: No token'}
        </div>
        {tokenStatus && <div className={`token-status ${tokenStatus.type}`}>{tokenStatus.message}</div>}
      </div>
      
      {/* Add Cesium Ion Asset */}
      <div className="layer-actions">
        <select
          className="layer-asset-select"
          value={selectedAssetId}
          onChange={(e) => setSelectedAssetId(e.target.value)}
          disabled={isLoadingAssets || !cesiumToken}
        >
          <option value="">
            {!cesiumToken ? 'Add token to load assets' : isLoadingAssets ? 'Loading assets...' : 'Select Cesium Ion Asset'}
          </option>
          {cesiumAssets.map(asset => (
            <option key={asset.id} value={asset.id}>
              {asset.name} ({asset.type})
            </option>
          ))}
        </select>
        <button
          className="btn-action"
          onClick={handleAddCesiumAsset}
          disabled={!selectedAssetId || isLoadingAssets || !cesiumToken}
          title="Add selected Cesium Ion asset"
        >
          + Add Asset
        </button>
      </div>
      
      <div className="view-mode-selector">
        <label>View Mode:</label>
        <select
          value={viewMode}
          onChange={(e) => setViewMode(e.target.value as any)}
        >
          <option value="SCENE3D">3D</option>
          <option value="SCENE2D">2D</option>
          <option value="COLUMBUS_VIEW">2.5D</option>
        </select>
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
              </label>

              {layer.id !== 'basemap' && layer.id !== 'terrain' && (
                <button
                  className="layer-remove-btn"
                  onClick={() => deleteLayer(layer.id)}
                  title="Remove layer"
                  aria-label={`Remove ${layer.name}`}
                >
                  ✕
                </button>
              )}
            </div>
            
            {layer.visible && (
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
    </div>
  );
};

