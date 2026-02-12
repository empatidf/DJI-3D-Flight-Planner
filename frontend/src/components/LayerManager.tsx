/**
 * LayerManager Component
 * Manages visibility and opacity of map layers
 */

import React from 'react';
import { useMissionStore } from '../stores/mission-store';
import { fetchCesiumAssets, filterImageryAssets, getAssetMetadata, type CesiumIonAsset } from '../lib/cesium-ion-api';
import { Ion } from 'cesium';
import './LayerManager.css';

export const LayerManager = () => {
  const layers = useMissionStore((state) => state.layers);
  const viewMode = useMissionStore((state) => state.viewMode);
  const toggleLayerVisibility = useMissionStore((state) => state.toggleLayerVisibility);
  const updateLayer = useMissionStore((state) => state.updateLayer);
  const setViewMode = useMissionStore((state) => state.setViewMode);
  const addLayer = useMissionStore((state) => state.addLayer);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);
  
  const [cesiumAssets, setCesiumAssets] = React.useState<CesiumIonAsset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = React.useState<string>('');
  const [isLoadingAssets, setIsLoadingAssets] = React.useState(false);
  
  // Fetch Cesium Ion assets on component mount
  React.useEffect(() => {
    const loadAssets = async () => {
      setIsLoadingAssets(true);
      try {
        const token = Ion.defaultAccessToken;
        const allAssets = await fetchCesiumAssets(token);
        const imageryAssets = filterImageryAssets(allAssets);
        setCesiumAssets(imageryAssets);
      } catch (error) {
        console.error('Failed to load Cesium Ion assets:', error);
      } finally {
        setIsLoadingAssets(false);
      }
    };
    loadAssets();
  }, []);

  const handleAddCesiumAsset = async () => {
    if (!selectedAssetId) {
      alert('Please select a Cesium Ion asset');
      return;
    }
    
    const assetId = parseInt(selectedAssetId);
    const asset = cesiumAssets.find(a => a.id === assetId);
    
    if (!asset) return;
    
    try {
      // Get asset metadata for bounds
      const metadata = await getAssetMetadata(assetId, Ion.defaultAccessToken);
      
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
      <h3>Layers</h3>
      
      {/* Add Cesium Ion Asset */}
      <div className="layer-actions" style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        marginBottom: '15px'
      }}>
        <select
          value={selectedAssetId}
          onChange={(e) => setSelectedAssetId(e.target.value)}
          disabled={isLoadingAssets}
          style={{
            padding: '8px 12px',
            fontSize: '13px',
            borderRadius: '4px',
            border: '1px solid #ccc',
            backgroundColor: 'white'
          }}
        >
          <option value="">
            {isLoadingAssets ? 'Loading assets...' : 'Select Cesium Ion Asset'}
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
          disabled={!selectedAssetId || isLoadingAssets}
          title="Add selected Cesium Ion asset"
          style={{
            padding: '8px 12px',
            fontSize: '13px',
            backgroundColor: selectedAssetId ? '#10b981' : '#ccc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: selectedAssetId ? 'pointer' : 'not-allowed'
          }}
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
                  <span style={{
                    marginLeft: '8px',
                    padding: '2px 6px',
                    fontSize: '10px',
                    backgroundColor: layer.cesiumAssetType === 'TERRAIN' ? '#f59e0b' : '#3b82f6',
                    color: 'white',
                    borderRadius: '3px'
                  }}>
                    {layer.cesiumAssetType}
                  </span>
                )}
              </label>
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

