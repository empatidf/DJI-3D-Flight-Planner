import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    cesium(),
    // Installable app: its own window, and Chrome keeps the project folder
    // permission for installed apps.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Droneverse 3D Mission Planner',
        short_name: 'Droneverse',
        description: 'Plan DJI drone missions in 3D and keep them in a folder on your computer.',
        theme_color: '#0d6efd',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        // Cesium's static build is tens of MB; cache it as it is used instead of
        // precaching all of it on install.
        globIgnores: ['cesium/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/cesium\//],
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/cesium/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'cesium-static',
              expiration: { maxEntries: 3000 },
            },
          },
        ],
      },
    }),
  ],
  // Stamp the build date into the bundle so the version badge stays honest.
  define: {
    // Date and time, so two deploys on the same day can be told apart.
    __BUILD_DATE__: JSON.stringify(`${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`),
  },
  server: {
    port: 3000,
  },
})
