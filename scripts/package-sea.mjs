#!/usr/bin/env node
// Node.js SEA (Single Executable Applications) で単一バイナリ生成
// 前提: dist/server.cjs が build:server 済みであること

import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:process';

const BIN_DIR = 'bin';
const OUT_NAME = platform === 'win32' ? 'jp225-monitor.exe' : 'jp225-monitor';
const OUT_PATH = join(BIN_DIR, OUT_NAME);
const BLOB_PATH = 'dist/sea-prep.blob';
const SEA_CONFIG_PATH = 'dist/sea-config.json';

mkdirSync(BIN_DIR, { recursive: true });

console.log('1️⃣  Writing sea-config.json');
writeFileSync(SEA_CONFIG_PATH, JSON.stringify({
  main: 'dist/server.cjs',
  output: BLOB_PATH,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,        // pkg のような cache 圧縮はせず確実性優先
}, null, 2));

console.log('2️⃣  Generating SEA blob...');
execSync(`node --experimental-sea-config ${SEA_CONFIG_PATH}`, { stdio: 'inherit' });

console.log(`3️⃣  Copying node binary → ${OUT_PATH}`);
if (existsSync(OUT_PATH)) rmSync(OUT_PATH);
copyFileSync(process.execPath, OUT_PATH);

console.log(`4️⃣  Injecting blob with postject...`);
const sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const machoArg = platform === 'darwin' ? '--macho-segment-name NODE_SEA' : '';
execSync(
  `npx postject ${OUT_PATH} NODE_SEA_BLOB ${BLOB_PATH} --sentinel-fuse ${sentinel} ${machoArg}`,
  { stdio: 'inherit' }
);

const sizeMB = (statSync(OUT_PATH).size / 1024 / 1024).toFixed(1);
console.log(`\n✅ Binary built: ${OUT_PATH} (${sizeMB} MB)`);
console.log(`\nTest run:  ${OUT_PATH}`);
console.log(`Then open: http://localhost:3000/api/health`);
