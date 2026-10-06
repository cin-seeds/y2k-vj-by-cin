import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // GitHub Pages serves the preview under /y2k-vj-by-cin/. Desktop builds leave this unset.
  base: process.env.PAGES_BASE || '/',
  server: {
    // localhost counts as a secure context, which getUserMedia and Web MIDI require.
    host: 'localhost',
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        output: resolve(root, 'output.html'),
      },
    },
  },
});
