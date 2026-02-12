/**
 * LayerManager Component
 * Manages visibility and opacity of map layers
 */

import { useMissionStore } from '../stores/mission-store';
import './LayerManager.css';

export const LayerManager = () => {
  const layers = useMissionStore((state) => state.layers);
  const viewMode = useMissionStore((state) => state.viewMode);
  const toggleLayerVisibility = useMissionStore((state) => state.toggleLayerVisibility);
  const updateLayer = useMissionStore((state) => state.updateLayer);
  const setViewMode = useMissionStore((state) => state.setViewMode);
  const addLayer = useMissionStore((state) => state.addLayer);
  const deleteLayerWithTiles = useMissionStore((state) => state.deleteLayerWithTiles);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);

  const handleAddRGB = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tif,.tiff';
    input.onchange = async (e: any) => {
      const file = e.target.files?.[0];
      if (!file) return;
      
      // Generate unique layer ID
      const layerId = `rgb_${Date.now()}`;
      
      // Show loading message
      alert('Generating tiles... This may take a few moments for large files.\n\nClick OK and wait for completion message.');
      
      try {
        // Save file to public/tiles directory and generate tiles using Python
        const formData = new FormData();
        formData.append('file', file);
        formData.append('layerId', layerId);
        formData.append('layerType', 'rgb');
        
        // Call Vite dev server API to save file and run Python tiling
        const response = await fetch('/api/tile', {
          method: 'POST',
          body: formData,
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          throw new Error(`Tiling failed: ${errorData.error || response.statusText}${errorData.stderr ? '\n' + errorData.stderr : ''}`);
        }
        
        const result = await response.json();
        
        // Add layer with local tile URL
        addLayer({
          name: file.name,
          type: 'rgb',
          visible: true,
          opacity: 1.0,
          url: `/tiles/${layerId}/{z}/{x}/{y}.png`,
          geoTiffInfo: {
            bounds: {
              minLon: result.bounds[0],
              minLat: result.bounds[1],
              maxLon: result.bounds[2],
              maxLat: result.bounds[3],
            },
            epsg: 'EPSG:4326',
            fileName: file.name,
            minZoom: result.minZoom,
            maxZoom: result.maxZoom,
          },
        });
        
        // Fly camera to RGB coverage area
        const centerLon = (result.bounds[0] + result.bounds[2]) / 2;
        const centerLat = (result.bounds[1] + result.bounds[3]) / 2;
        const lonDiff = result.bounds[2] - result.bounds[0];
        const latDiff = result.bounds[3] - result.bounds[1];
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
        
        alert(`RGB layer added!\nFile: ${file.name}\nTiles: ${result.tileCount}\nZoom: ${result.minZoom}-${result.maxZoom}`);
      } catch (error: any) {
        console.error('Failed to generate tiles:', error);
        const errorMsg = error?.message || String(error);
        const detailedError = error?.response ? 
          `\n\nServer response: ${JSON.stringify(error.response)}` : '';
        alert(`Failed to generate tiles: ${errorMsg}${detailedError}`);
      }
    };
    input.click();
  };

  const handleAddDSM = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tif,.tiff';
    input.onchange = async (e: any) => {
      const file = e.target.files?.[0];
      if (!file) return;
      
      // Generate unique layer ID
      const layerId = `dsm_${Date.now()}`;
      
      // Show loading message
      alert('Generating tiles... This may take a few moments for large files.\n\nClick OK and wait for completion message.');
      
      try {
        // Save file and generate tiles using Python
        const formData = new FormData();
        formData.append('file', file);
        formData.append('layerId', layerId);
        formData.append('layerType', 'dsm');
        
        // Call Vite dev server API to save file and run Python tiling
        const response = await fetch('/api/tile', {
          method: 'POST',
          body: formData,
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          throw new Error(`Tiling failed: ${errorData.error || response.statusText}${errorData.stderr ? '\n' + errorData.stderr : ''}`);
        }
        
        const result = await response.json();
        
        // Add layer with local tile URL
        addLayer({
          name: file.name,
          type: 'dsm',
          visible: true,
          opacity: 0.7,
          url: `/tiles/${layerId}/{z}/{x}/{y}.png`,
          geoTiffInfo: {
            bounds: {
              minLon: result.bounds[0],
              minLat: result.bounds[1],
              maxLon: result.bounds[2],
              maxLat: result.bounds[3],
            },
            epsg: 'EPSG:4326',
            fileName: file.name,
            minZoom: result.minZoom,
            maxZoom: result.maxZoom,
          },
        });
        
        // Fly camera to DSM coverage area
        const centerLon = (result.bounds[0] + result.bounds[2]) / 2;
        const centerLat = (result.bounds[1] + result.bounds[3]) / 2;
        const lonDiff = result.bounds[2] - result.bounds[0];
        const latDiff = result.bounds[3] - result.bounds[1];
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
        
        alert(`DSM layer added!\nFile: ${file.name}\nTiles: ${result.tileCount}\nZoom: ${result.minZoom}-${result.maxZoom}`);
      } catch (error) {
        console.error('Failed to generate tiles:', error);
        alert('Failed to generate tiles: ' + (error as Error).message);
      }
    };
    input.click();
  };

  return (
    <div className="layer-manager">
      <h3>Layers</h3>
      
      {/* Add Layer Buttons */}
      <div className="layer-actions" style={{
        display: 'flex',
        gap: '8px',
        marginBottom: '15px'
      }}>
        <button
          className="btn-action"
          onClick={handleAddRGB}
          title="Add RGB Orthomosaic Layer"
          style={{
            flex: 1,
            padding: '8px 12px',
            fontSize: '13px',
            backgroundColor: '#10b981',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          + RGB
        </button>
        <button
          className="btn-action"
          onClick={handleAddDSM}
          title="Add Digital Surface Model Layer"
          style={{
            flex: 1,
            padding: '8px 12px',
            fontSize: '13px',
            backgroundColor: '#8b5cf6',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          + DSM
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
                {(layer.type === 'rgb' || layer.type === 'dsm') && (
                  <span style={{
                    marginLeft: '8px',
                    padding: '2px 6px',
                    fontSize: '10px',
                    backgroundColor: layer.type === 'rgb' ? '#10b981' : '#8b5cf6',
                    color: 'white',
                    borderRadius: '3px'
                  }}>
                    {layer.type.toUpperCase()}
                  </span>
                )}
              </label>
              {(layer.type === 'rgb' || layer.type === 'dsm') && (
                <button
                  onClick={() => deleteLayerWithTiles(layer.id)}
                  title="Remove layer"
                  style={{
                    marginLeft: 'auto',
                    padding: '2px 8px',
                    fontSize: '12px',
                    backgroundColor: 'transparent',
                    color: '#ef4444',
                    border: 'none',
                    cursor: 'pointer'
                  }}
                >
                  ×
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
