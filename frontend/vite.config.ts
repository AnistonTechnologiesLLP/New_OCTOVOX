/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `build` emits into the OCTOVOX Flask app's static dir so the compiled bundle
// is served at /static/ui/ (the `base`); Flask exposes the page at /ui during
// the migration and at / after cutover. The absolute `base` keeps asset URLs
// correct regardless of the page URL the HTML is served from (same pattern as
// room-acoustics/).
//
// `dev` proxies API + output + the acoustics sub-app to a locally running
// Flask (run.py, port 5050) so the React app develops with HMR against real
// data.
export default defineConfig({
  base: '/static/ui/',
  plugins: [react()],
  build: {
    outDir: '../octovox_app/static/ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:5050',
      '/output': 'http://127.0.0.1:5050',
      '/acoustics': 'http://127.0.0.1:5050',
      '/static/acoustics': 'http://127.0.0.1:5050',
      '/static/uploads': 'http://127.0.0.1:5050',
      '/static/assets': 'http://127.0.0.1:5050',
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
