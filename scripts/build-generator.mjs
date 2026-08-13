#!/usr/bin/env node
// server/generator/sidecar.ts → dist/generator.cjs (esbuild, CJS, full bundle)
// then SEA blob → bin/jp225-generator.exe
// ★scripts/build-collector.mjs をそのまま写した流儀(新しい機構を作らない)。

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
const CJS_OUT       = 'dist/generator.cjs';
const BLOB_PATH     = 'dist/generator-sea.blob';
const SEA_CFG_PATH  = 'dist/generator-sea-config.json';
const OUT_NAME      = platform === 'win32' ? 'jp225-generator.exe' : 'jp225-generator';
const OUT_PATH      = join(BIN_DIR, OUT_NAME);

mkdirSync('dist',   { recursive: true });
mkdirSync(BIN_DIR,  { recursive: true });

// ── Step 0: 実行中の分析用を停止 ──────────────────────────────────────────────
// collector と同じ理由: 実行中の exe は上書きできず EPERM になる。
// bin の直接実行版とバンドル版(triple名)の両方を掃除する。
const generatorTargets = platform === 'win32'
  ? ['jp225-generator.exe', 'jp225-generator-x86_64-pc-windows-msvc.exe']
  : ['jp225-generator'];
let killed = 0;
for (const t of generatorTargets) {
  try {
    if (platform === 'win32') {
      execSync(`taskkill /F /T /IM ${t}`, { stdio: ['ignore', 'pipe', 'ignore'] });
    } else {
      execSync(`pkill -f ${t}`, { stdio: ['ignore', 'pipe', 'ignore'] });
    }
    killed++;
  } catch { /* not running = OK */ }
}
console.log(killed > 0
  ? `0️⃣  killed running generator(s) (${killed} name(s) matched)`
  : '0️⃣  no running generator');

// ── Step 1: esbuild ──────────────────────────────────────────────────────────
console.log('1️⃣  esbuild server/generator/sidecar.ts → dist/generator.cjs');
try { rmSync(CJS_OUT, { force: true }); } catch { /* ignore */ }

await build({
  entryPoints: ['server/generator/sidecar.ts'],
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

console.log(`✅ ${CJS_OUT} built (generator v${pkg.version})`);

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
execSync(
  `node --max-old-space-size=8192 node_modules/postject/dist/cli.js ${OUT_PATH} NODE_SEA_BLOB ${BLOB_PATH} --sentinel-fuse ${sentinel} ${machoArg}`,
  { stdio: 'inherit' }
);

const sizeMB = (statSync(OUT_PATH).size / 1024 / 1024).toFixed(1);
console.log(`\n✅ Binary built: ${OUT_PATH} (${sizeMB} MB)`);
console.log(`\nTest run:  ${OUT_PATH}`);
