import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the build works when served from any sub-path
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // the Arena live-preview proxy serves the app from a generated host name
    allowedHosts: true,
    cors: true,
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
});
