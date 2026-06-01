#!/usr/bin/env node
// collector/index.ts → dist/collector.cjs (esbuild, CJS, full bundle)
// then SEA blob → bin/jp225-collector.exe
// Mirrors scripts/build-server.mjs + scripts/package-sea.mjs exactly.

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:process';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// ── paths ────────────────────────────────────────────────────────────────────
const BIN_DIR       = 'bin';
const CJS_OUT       = 'dist/collector.cjs';
const BLOB_PATH     = 'dist/collector-sea.blob';
const SEA_CFG_PATH  = 'dist/collector-sea-config.json';
const OUT_NAME      = platform === 'win32' ? 'jp225-collector.exe' : 'jp225-collector';
const OUT_PATH      = join(BIN_DIR, OUT_NAME);

mkdirSync('dist',   { recursive: true });
mkdirSync(BIN_DIR,  { recursive: true });

// ── Step 1: esbuild ──────────────────────────────────────────────────────────
console.log('1️⃣  esbuild collector/index.ts → dist/collector.cjs');
try { rmSync(CJS_OUT, { force: true }); } catch { /* ignore */ }

await build({
  entryPoints: ['collector/index.ts'],
  bundle:      true,
  platform:    'node',
  target:      'node20',
  format:      'cjs',
  outfile:     CJS_OUT,
  minify:      false,
  sourcemap:   false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // node:sqlite is a Node builtin – esbuild leaves node: builtins external by
  // default, but list it explicitly to be safe.
  external: [
    'node:sqlite',
    // yahoo-finance2 Deno stubs (same as build-server.mjs)
    '@std/testing/mock',
    '@std/testing/bdd',
    '@gadicc/fetch-mock-cache/runtimes/deno.ts',
    '@gadicc/fetch-mock-cache/stores/fs.ts',
  ],
  logLevel: 'info',
});

console.log(`✅ ${CJS_OUT} built (collector v${pkg.version})`);

// ── Step 2: SEA config ───────────────────────────────────────────────────────
console.log('\n2️⃣  Writing SEA config → ' + SEA_CFG_PATH);
writeFileSync(SEA_CFG_PATH, JSON.stringify({
  main:                        CJS_OUT,
  output:                      BLOB_PATH,
  disableExperimentalSEAWarning: true,
  useCodeCache:                false,
}, null, 2));

// ── Step 3: generate SEA blob ────────────────────────────────────────────────
console.log('\n3️⃣  Generating SEA blob...');
execSync(`node --experimental-sea-config ${SEA_CFG_PATH}`, { stdio: 'inherit' });

// ── Step 4: copy node binary ──────────────────────────────────────────────────
console.log(`\n4️⃣  Copying node binary → ${OUT_PATH}`);
if (existsSync(OUT_PATH)) rmSync(OUT_PATH);
copyFileSync(process.execPath, OUT_PATH);

// ── Step 5: inject blob with postject ────────────────────────────────────────
console.log(`\n5️⃣  Injecting blob with postject...`);
const sentinel  = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const machoArg  = platform === 'darwin' ? '--macho-segment-name NODE_SEA' : '';
// Use node directly (avoids bash-shebang issue on Windows) with increased heap
// to prevent WASM OOM on large (~90 MB) PE binaries.
execSync(
  `node --max-old-space-size=8192 node_modules/postject/dist/cli.js ${OUT_PATH} NODE_SEA_BLOB ${BLOB_PATH} --sentinel-fuse ${sentinel} ${machoArg}`,
  { stdio: 'inherit' }
);

const sizeMB = (statSync(OUT_PATH).size / 1024 / 1024).toFixed(1);
console.log(`\n✅ Binary built: ${OUT_PATH} (${sizeMB} MB)`);
console.log(`\nTest run:  ${OUT_PATH}`);
