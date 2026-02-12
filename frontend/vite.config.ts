import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'
import { tilerPlugin } from './vite-plugin-tiler'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cesium(), tilerPlugin()],
  server: {
    port: 3000,
  },
})
