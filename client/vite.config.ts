import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy the websocket to the game server during development so the
    // client can use a same-origin URL in every environment.
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/health': { target: 'http://localhost:8080' },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
