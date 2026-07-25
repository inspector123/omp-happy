import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: { outDir: 'out/main' },
  },
  preload: {
    // Sandboxed preload scripts must be CJS. `electron` must stay external —
    // bundling the npm package ships its executable-path shim instead of the
    // injected API, and its require("fs") is unavailable in a sandboxed preload.
    build: {
      outDir: 'out/preload',
      rollupOptions: { external: ['electron'], output: { format: 'cjs' } },
    },
  },
  renderer: {
    // happy-desktop has its own react copy while react-dom is hoisted at the
    // workspace root — dedupe so the renderer never loads two React instances.
    resolve: { dedupe: ['react', 'react-dom'] },
    plugins: [react(), tailwindcss()],
  },
});
