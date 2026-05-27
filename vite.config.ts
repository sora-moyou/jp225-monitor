import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: 'web',
  server: {
    port: 5173,
    fs: {
      // server/ ディレクトリの共有型を web/ から import するため、ルートの一つ上を許可
      allow: [path.resolve(__dirname)],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/stream': {
        target: 'http://localhost:3000',
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
