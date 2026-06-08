/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Engine tests are pure (no DOM), so the default 'node' test environment is
// enough — the React component is not unit-tested per the spec.
//
// `build` emits into the OCTOVOX Flask app's static dir so the compiled bundle
// is served at /static/acoustics/ (the `base`), and Flask exposes the page at
// /acoustics. The absolute `base` keeps asset URLs correct regardless of the
// page URL the HTML is served from.
export default defineConfig({
  base: '/static/acoustics/',
  plugins: [react()],
  build: {
    outDir: '../octovox_app/static/acoustics',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
