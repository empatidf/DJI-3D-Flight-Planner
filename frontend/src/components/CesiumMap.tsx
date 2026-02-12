/**
 * CesiumMap Component
 * Main 3D/2D visualization component using CesiumJS
 */

import { useEffect, useRef } from 'react';
import {
  Viewer,
  Ion,
  IonImageryProvider,
  CesiumTerrainProvider,
  createWorldTerrainAsync,
  SceneMode,
  Cartesian3,
  Math as CesiumMath,
  Color,
  Entity,
  EllipsoidTerrainProvider,
  ImageryLayer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useMissionStore } from '../stores/mission-store';
import { sampleTerrainForWaypoints } from '../lib/terrain-sampler';

// Set Cesium Ion access token
Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJhYjM3ZjBkMy0wZWFiLTQzNzYtYjk5Zi1mZDU4NzZhZGZkMmUiLCJpZCI6Mzg5Nzk1LCJpYXQiOjE3NzA4NTExMzd9.LATM9S0nkja1YrqNanCBDYhse2_bX-CqIa5rgkhIXNQ';

export const CesiumMap = () => {
  const viewerRef = useRef<Viewer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewMode = useMissionStore((state) => state.viewMode);
  const cameraTarget = useMissionStore((state) => state.cameraTarget);
  const setCameraTarget = useMissionStore((state) => state.setCameraTarget);
  const missions = useMissionStore((state) => state.missions);
  const layers = useMissionStore((state) => state.layers);

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;

    // Initialize Cesium Viewer with default satellite imagery
    const viewer = new Viewer(containerRef.current, {
      baseLayerPicker: false,
      
      // UI elements
      animation: false,
      timeline: false,
      fullscreenButton: false,
      vrButton: false,
      geocoder: true,
      homeButton: true,
      sceneModePicker: true,
      navigationHelpButton: true,
      
      // Scene settings
      requestRenderMode: false,
      maximumRenderTimeChange: Infinity,
    });
    
    // Cesium Viewer comes with Bing Maps satellite imagery by default
    // Add labels layer on top for city names and features
    IonImageryProvider.fromAssetId(3).then((labelsProvider) => {
      viewer.imageryLayers.addImageryProvider(labelsProvider); // Bing Maps Road Labels
    });

    // Set initial terrain provider to flat ellipsoid
    // Will be toggled by Layer Manager terrain checkbox
    viewer.terrainProvider = new EllipsoidTerrainProvider();

    // Configure scene for better 3D terrain visualization
    viewer.scene.globe.enableLighting = false;
    // Disable depth test so flight lines are always visible, even with terrain loaded
    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.globe.tileCacheSize = 1000;
    
    // Enable terrain exaggeration for better visibility (2x exaggeration)
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;

    // Set initial camera position (centered view of Earth)
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(0, 30, 20000000), // Above equator, high enough to see Earth
      orientation: {
        heading: CesiumMath.toRadians(0),
        pitch: CesiumMath.toRadians(-90), // Looking straight down
        roll: 0.0,
      },
    });

    viewerRef.current = viewer;
    
    // Store viewer globally for terrain sampling access
    // @ts-ignore
    window.cesiumViewer = viewer;

    // Cleanup
    return () => {
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, []);

  // Handle view mode changes
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    
    switch (viewMode) {
      case 'SCENE2D':
        viewer.scene.mode = SceneMode.SCENE2D;
        break;
      case 'SCENE3D':
        viewer.scene.mode = SceneMode.SCENE3D;
        break;
      case 'COLUMBUS_VIEW':
        viewer.scene.mode = SceneMode.COLUMBUS_VIEW;
        break;
    }
  }, [viewMode]);

  // Handle camera target changes (fly to location)
  useEffect(() => {
    if (!viewerRef.current || !cameraTarget) return;

    const viewer = viewerRef.current;
    
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(
        cameraTarget.longitude,
        cameraTarget.latitude,
        cameraTarget.altitude || 5000
      ),
      orientation: {
        heading: CesiumMath.toRadians(cameraTarget.heading || 0),
        pitch: CesiumMath.toRadians(cameraTarget.pitch || -45),
        roll: cameraTarget.roll || 0.0,
      },
      duration: 2.0,
      complete: () => {
        // Clear the target after flying to it
        setCameraTarget(null);
      },
    });
  }, [cameraTarget, setCameraTarget]);

  // Handle terrain visibility
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    const terrainLayer = layers.find(l => l.id === 'terrain');
    
    if (terrainLayer?.visible) {
      // Enable 3D terrain with vertex normals and water mask for better visualization
      console.log('Loading 3D terrain...');
      createWorldTerrainAsync({
        requestVertexNormals: true,
        requestWaterMask: true,
      }).then((terrainProvider) => {
        if (viewerRef.current) {
          viewerRef.current.terrainProvider = terrainProvider;
          console.log('3D terrain loaded - navigate to mountainous areas to see elevation');
        }
      }).catch((error) => {
        console.error('Failed to load Cesium World Terrain:', error);
      });
    } else {
      // Disable terrain (use flat ellipsoid)
      console.log('Switching to flat terrain');
      viewer.terrainProvider = new EllipsoidTerrainProvider();
    }
  }, [layers]);

  // Render mission AOI polygons - updates immediately when altitude changes
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    
    // Remove existing mission entities
    const entitiesToRemove: Entity[] = [];
    viewer.entities.values.forEach((entity) => {
      if (entity.id.startsWith('mission-aoi-')) {
        entitiesToRemove.push(entity);
      }
    });
    entitiesToRemove.forEach((entity) => viewer.entities.remove(entity));

    // Add polygons for visible missions with AOI - async for terrain sampling
    missions.forEach(async (mission) => {
      if (!mission.visible || !mission.aoi) return;

      const coordinates = mission.aoi.coordinates;
      if (coordinates.length < 3) return;

      // Use mission altitude for polygon elevation (AGL)
      const missionAltitude = mission.parameters.altitude;

      // Sample terrain and create positions with terrain-following
      const waypointsWithAltitude = coordinates.map(coord => [coord[0], coord[1], missionAltitude]);
      const terrainAdjustedPoints = await sampleTerrainForWaypoints(viewer, waypointsWithAltitude, missionAltitude);
      
      // Convert coordinates to Cartesian3 positions with terrain-following altitudes
      const positions = terrainAdjustedPoints.map(coord =>
        Cartesian3.fromDegrees(coord[0], coord[1], coord[2])
      );

      // Add polygon entity at terrain-following altitude - using polyline for better visibility
      // Close the polygon by adding first point at end
      const closedPositions = [...positions, positions[0]];
      
      viewer.entities.add({
        id: `mission-aoi-${mission.id}`,
        name: mission.aoi.name,
        polyline: {
          positions: closedPositions,
          width: 3,
          material: Color.CYAN,
          clampToGround: false,
          arcType: 0, // NONE - straight lines
        },
      });
    });
    
    // Dependencies include missions array - any change triggers immediate re-render
  }, [missions]);

  // Render imagery layers (RGB/DSM/Cesium Ion)
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    
    // Remove existing custom imagery layers
    const layersToRemove: ImageryLayer[] = [];
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      const imageryLayer = viewer.imageryLayers.get(i);
      // @ts-ignore - accessing custom property
      if (imageryLayer._customLayerId) {
        layersToRemove.push(imageryLayer);
      }
    }
    layersToRemove.forEach((layer) => viewer.imageryLayers.remove(layer));

    // Add imagery layers for visible layers
    layers.forEach(async (layer) => {
      if (!layer.visible) return;
      
      let imageryLayer: ImageryLayer | null = null;
      
      // Handle Cesium Ion assets
      if (layer.type === 'cesium-ion' && layer.cesiumAssetId) {
        try {
          // Handle TERRAIN assets differently from IMAGERY
          if (layer.cesiumAssetType === 'TERRAIN') {
            const terrainProvider = await CesiumTerrainProvider.fromIonAssetId(layer.cesiumAssetId);
            viewer.terrainProvider = terrainProvider;
            console.log(`Applied Cesium Ion TERRAIN: ${layer.name} (Asset: ${layer.cesiumAssetId})`);
            // Terrain doesn't use imagery layers, so skip the rest
            return;
          } else {
            // IMAGERY or 3DTILES - use IonImageryProvider
            const provider = await IonImageryProvider.fromAssetId(layer.cesiumAssetId);
            imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
            console.log(`Added Cesium Ion ${layer.cesiumAssetType || 'IMAGERY'} layer: ${layer.name} (Asset: ${layer.cesiumAssetId})`);
          }
        } catch (error) {
          console.error(`Failed to load Cesium Ion asset ${layer.cesiumAssetId}:`, error);
          return;
        }
      }
      // Future: Add support for other layer types here
      
      if (imageryLayer) {
        // Store custom ID for removal
        // @ts-ignore - adding custom property
        imageryLayer._customLayerId = `custom-${layer.id}`;
        
        // Set opacity (transparency slider)
        imageryLayer.alpha = layer.opacity;
        
        // Move custom layers to top (above basemap and labels)
        viewer.imageryLayers.raise(imageryLayer);
      }
    });
  }, [layers]);

  // Render flight lines and waypoints
  useEffect(() => {
    console.log('=== FLIGHT LINE RENDERING EFFECT TRIGGERED ===');
    console.log('Missions array:', missions);
    console.log('Missions length:', missions.length);
    console.log('Missions with flight lines:', missions.filter(m => m.flightLines && m.flightLines.length > 0).length);
    
    if (!viewerRef.current) {
      console.log('No viewer ref - skipping render');
      return;
    }

    const viewer = viewerRef.current;
    
    // Remove existing flight line entities
    const entitiesToRemove: Entity[] = [];
    viewer.entities.values.forEach((entity) => {
      if (entity.id.startsWith('flight-line-') || entity.id.startsWith('waypoint-')) {
        entitiesToRemove.push(entity);
      }
    });
    console.log(`Removing ${entitiesToRemove.length} old flight line entities`);
    entitiesToRemove.forEach((entity) => viewer.entities.remove(entity));

    // Add flight lines for visible missions
    let totalLinesRendered = 0;
    missions.forEach((mission) => {
      console.log(`Mission ${mission.name} (${mission.id}):`, {
        visible: mission.visible,
        hasFlightLines: !!mission.flightLines,
        numLines: mission.flightLines?.length || 0,
        flightLines: mission.flightLines
      });
      
      if (!mission.visible) {
        console.log(`  Skipping ${mission.name} - not visible`);
        return;
      }
      
      if (!mission.flightLines || mission.flightLines.length === 0) {
        console.log(`  Skipping ${mission.name} - no flight lines`);
        return;
      }

      console.log(`Rendering flight lines for mission ${mission.name}: ${mission.flightLines.length} lines`);
      
      const missionAltitude = mission.parameters.altitude;

      mission.flightLines.forEach((line, lineIndex) => {
        if (line.coordinates.length < 2) {
          console.log(`  Skipping line ${lineIndex} - insufficient coordinates`);
          return;
        }

        console.log(`  Line ${lineIndex}: ${line.coordinates.length} waypoints, first coord:`, line.coordinates[0]);

        // Create polyline for flight path
        const positions = line.coordinates.map(coord =>
          Cartesian3.fromDegrees(coord[0], coord[1], coord[2] || missionAltitude)
        );
        
        console.log(`  Creating polyline with ${positions.length} positions`);

        const polylineEntity = viewer.entities.add({
          id: `flight-line-${mission.id}-${lineIndex}`,
          name: `Flight Line ${lineIndex + 1}`,
          polyline: {
            positions: positions,
            width: 4,
            material: Color.YELLOW,
            clampToGround: false,
            arcType: 0, // NONE - straight lines
          },
        });
        
        console.log(`  ✓ Created polyline entity: ${polylineEntity.id}`);
        totalLinesRendered++;

        // Add waypoint markers
        line.coordinates.forEach((coord, wpIndex) => {
          const isPhotoPoint = line.photoPoints?.some(
            pp => pp[0] === coord[0] && pp[1] === coord[1]
          );

          viewer.entities.add({
            id: `waypoint-${mission.id}-${lineIndex}-${wpIndex}`,
            position: Cartesian3.fromDegrees(coord[0], coord[1], coord[2] || missionAltitude),
            point: {
              pixelSize: isPhotoPoint ? 10 : 6,
              color: isPhotoPoint ? Color.RED : Color.YELLOW,
              outlineColor: Color.WHITE,
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY, // Always visible
            },
          });
        });
      });
    });
    
    console.log(`=== RENDER COMPLETE: ${totalLinesRendered} flight lines rendered ===`);
    console.log(`Total entities in viewer: ${viewer.entities.values.length}`);
  }, [missions]);

  return (
    <div 
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        position: 'relative',
      }}
    />
  );
};
