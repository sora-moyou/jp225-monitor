#!/usr/bin/env node
// server/index.ts → dist/server.cjs (esbuild, 単一CJS、全依存inline)

import { build } from 'esbuild';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

mkdirSync('dist', { recursive: true });

try {
  rmSync('dist/server.cjs', { force: true });
} catch { /* ignore */ }

await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/server.cjs',
  minify: false,                     // バイナリには圧縮不要、デバッグ性優先
  sourcemap: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // yahoo-finance2 が内部参照する Deno 専用 / .ts ファイルを除外
  // (実行時には呼ばれないので require error は出ない)
  external: [
    '@std/testing/mock',
    '@std/testing/bdd',
    '@gadicc/fetch-mock-cache/runtimes/deno.ts',
    '@gadicc/fetch-mock-cache/stores/fs.ts',
  ],
  logLevel: 'info',
});

console.log(`✅ dist/server.cjs built (JP225 Monitor v${pkg.version})`);
