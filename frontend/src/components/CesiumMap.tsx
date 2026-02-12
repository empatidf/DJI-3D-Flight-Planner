/**
 * CesiumMap Component
 * Main 3D/2D visualization component using CesiumJS
 */

import { useEffect, useRef } from 'react';
import {
  Viewer,
  Ion,
  IonImageryProvider,
  createWorldTerrainAsync,
  SceneMode,
  Cartesian3,
  Cartesian2,
  Math as CesiumMath,
  Color,
  PolygonHierarchy,
  Entity,
  EllipsoidTerrainProvider,
  UrlTemplateImageryProvider,
  Rectangle,
  ImageryLayer,
  WebMercatorTilingScheme,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useMissionStore } from '../stores/mission-store';

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
    viewer.scene.globe.depthTestAgainstTerrain = true;
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

    // Add polygons for visible missions with AOI
    missions.forEach((mission) => {
      if (!mission.visible || !mission.aoi) return;

      const coordinates = mission.aoi.coordinates;
      if (coordinates.length < 3) return;

      // Use mission altitude for polygon elevation
      const missionAltitude = mission.parameters.altitude;

      // Convert coordinates to Cartesian3 positions at mission altitude
      const positions = coordinates.map(coord =>
        Cartesian3.fromDegrees(coord[0], coord[1], missionAltitude)
      );

      // Add polygon entity at mission altitude - outline only
      viewer.entities.add({
        id: `mission-aoi-${mission.id}`,
        name: mission.aoi.name,
        polygon: {
          hierarchy: new PolygonHierarchy(positions),
          fill: false, // No fill, outline only
          outline: true,
          outlineColor: Color.CYAN,
          outlineWidth: 3,
          height: missionAltitude, // Polygon floor at mission altitude
        },
      });
    });
    
    // Dependencies include missions array - any change triggers immediate re-render
  }, [missions]);

  // Render RGB/DSM tiled imagery layers
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    
    // Remove existing RGB/DSM imagery layers
    const layersToRemove: ImageryLayer[] = [];
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      const imageryLayer = viewer.imageryLayers.get(i);
      // @ts-ignore - accessing custom property
      if (imageryLayer._customLayerId && imageryLayer._customLayerId.startsWith('geotiff-')) {
        layersToRemove.push(imageryLayer);
      }
    }
    layersToRemove.forEach((layer) => viewer.imageryLayers.remove(layer));

    // Add tiled imagery layers for visible RGB/DSM layers
    layers.forEach((layer) => {
      if (!layer.visible || !layer.geoTiffInfo || !layer.url) return;
      if (layer.type !== 'rgb' && layer.type !== 'dsm') return;

      const bounds = layer.geoTiffInfo.bounds;
      
      // Create rectangle from bounds
      const rectangle = Rectangle.fromDegrees(
        bounds.minLon,
        bounds.minLat,
        bounds.maxLon,
        bounds.maxLat
      );

      // Create tiled imagery provider with zoom level configuration
      const provider = new UrlTemplateImageryProvider({
        url: layer.url,
        rectangle: rectangle,
        tilingScheme: new WebMercatorTilingScheme(),
        minimumLevel: layer.geoTiffInfo.minZoom || 0,
        maximumLevel: layer.geoTiffInfo.maxZoom || 22,
      });

      // Add to viewer
      const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
      
      // Store custom ID for removal
      // @ts-ignore - adding custom property
      imageryLayer._customLayerId = `geotiff-${layer.id}`;
      
      // Set opacity
      imageryLayer.alpha = layer.opacity;
      
      // Move RGB/DSM layers to top (above basemap and labels)
      viewer.imageryLayers.raise(imageryLayer);
      
      console.log(`Added ${layer.type.toUpperCase()} tiled imagery layer: ${layer.name}`);
    });
  }, [layers]);

  // Render RGB/DSM layer coverage areas
  useEffect(() => {
    if (!viewerRef.current) return;

    const viewer = viewerRef.current;
    
    // Remove existing layer coverage entities
    const entitiesToRemove: Entity[] = [];
    viewer.entities.values.forEach((entity) => {
      if (entity.id.startsWith('layer-coverage-')) {
        entitiesToRemove.push(entity);
      }
    });
    entitiesToRemove.forEach((entity) => viewer.entities.remove(entity));

    // Add coverage rectangles for visible RGB/DSM layers
    layers.forEach((layer) => {
      if (!layer.visible || !layer.geoTiffInfo) return;
      if (layer.type !== 'rgb' && layer.type !== 'dsm') return;

      const bounds = layer.geoTiffInfo.bounds;
      
      // Create rectangle corners
      const positions = [
        Cartesian3.fromDegrees(bounds.minLon, bounds.minLat, 0),
        Cartesian3.fromDegrees(bounds.maxLon, bounds.minLat, 0),
        Cartesian3.fromDegrees(bounds.maxLon, bounds.maxLat, 0),
        Cartesian3.fromDegrees(bounds.minLon, bounds.maxLat, 0),
      ];

      // Color coding: green for RGB, purple for DSM
      const color = layer.type === 'rgb' ? Color.GREEN : Color.PURPLE;

      // Add coverage outline
      viewer.entities.add({
        id: `layer-coverage-${layer.id}`,
        name: `${layer.name} Coverage`,
        polygon: {
          hierarchy: new PolygonHierarchy(positions),
          fill: true,
          material: color.withAlpha(0.2), // Semi-transparent fill
          outline: true,
          outlineColor: color,
          outlineWidth: 4,
          height: 0,
        },
      });
      
      // Add label at center
      const centerLon = (bounds.minLon + bounds.maxLon) / 2;
      const centerLat = (bounds.minLat + bounds.maxLat) / 2;
      
      viewer.entities.add({
        id: `layer-label-${layer.id}`,
        position: Cartesian3.fromDegrees(centerLon, centerLat, 50),
        label: {
          text: `${layer.type.toUpperCase()}: ${layer.name}\\n${layer.geoTiffInfo.epsg}`,
          font: '14px sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          style: 0, // FILL
          verticalOrigin: 1, // CENTER
          pixelOffset: new Cartesian2(0, 0),
          showBackground: true,
          backgroundColor: color.withAlpha(0.7),
          backgroundPadding: new Cartesian2(8, 4),
        },
      });
    });
  }, [layers]);

  // Render flight lines and waypoints
  useEffect(() => {
    console.log('Flight line rendering effect triggered');
    console.log('Missions array:', missions);
    
    if (!viewerRef.current) {
      console.log('No viewer ref');
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
      console.log(`Checking mission ${mission.id}: visible=${mission.visible}, hasFlightLines=${!!mission.flightLines}, numLines=${mission.flightLines?.length || 0}`);
      
      if (!mission.visible || !mission.flightLines || mission.flightLines.length === 0) return;

      console.log(`Rendering flight lines for mission ${mission.id}: ${mission.flightLines.length} lines`);
      
      const missionAltitude = mission.parameters.altitude;

      mission.flightLines.forEach((line, lineIndex) => {
        if (line.coordinates.length < 2) return;

        console.log(`  Line ${lineIndex}: ${line.coordinates.length} waypoints, first coord:`, line.coordinates[0]);

        // Create polyline for flight path
        const positions = line.coordinates.map(coord =>
          Cartesian3.fromDegrees(coord[0], coord[1], coord[2] || missionAltitude)
        );
        
        console.log(`  Positions for line ${lineIndex}:`, positions.length, 'positions created');

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
        
        console.log(`  Created polyline entity:`, polylineEntity.id);
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
              heightReference: 0, // NONE - use absolute heights
            },
          });
        });
      });
    });
    
    console.log(`Total flight lines rendered: ${totalLinesRendered}`);
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
