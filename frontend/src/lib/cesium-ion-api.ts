/**
 * Cesium Ion API integration
 * Fetch and manage Cesium Ion assets
 */

export interface CesiumIonAsset {
  id: number;
  name: string;
  description: string;
  type: string;
  bytes: number;
  dateAdded: string;
  status: string;
  percentComplete: number;
}

const CESIUM_ION_API = 'https://api.cesium.com/v1';

/**
 * Fetch all assets from Cesium Ion account
 */
export async function fetchCesiumAssets(accessToken: string): Promise<CesiumIonAsset[]> {
  try {
    const response = await fetch(`${CESIUM_ION_API}/assets`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch assets: ${response.statusText}`);
    }

    const data = await response.json();
    return data.items || [];
  } catch (error) {
    console.error('Error fetching Cesium Ion assets:', error);
    return [];
  }
}

/**
 * Get asset metadata including bounds
 */
export async function getAssetMetadata(assetId: number, accessToken: string) {
  try {
    const response = await fetch(`${CESIUM_ION_API}/assets/${assetId}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch asset metadata: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching asset metadata:', error);
    return null;
  }
}

/**
 * Filter assets for imagery and terrain types
 */
export function filterImageryAssets(assets: CesiumIonAsset[]): CesiumIonAsset[] {
  const imageryTypes = ['IMAGERY', '3DTILES', 'TERRAIN'];
  return assets.filter(asset => 
    asset.status === 'COMPLETE' && 
    imageryTypes.includes(asset.type)
  );
}
