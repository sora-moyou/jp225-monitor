import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'web',
  server: {
    port: 5173,
    fs: {
      // server/ ディレクトリの共有型を web/ から import するため、ルートの一つ上を許可
      allow: [projectRoot],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/api/stream': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        // SSE をバッファせず流す
        ws: false,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
