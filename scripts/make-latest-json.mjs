#!/usr/bin/env node
// tauri:build 完了後に呼ぶ。生成された .sig ファイルを読んで
// updater 用の latest.json を作る。
//
// 使い方:
//   npm run release:latest-json
//   → release/latest.json と release/notes.md を生成
//   → 中身を確認して GitHub Release にアップロードする
//
// 環境変数 RELEASE_NOTES があればその内容を notes フィールドに入れる。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const version = pkg.version;

const SIG_PATH = `src-tauri/target/release/bundle/nsis/JP225 Monitor_${version}_x64-setup.exe.sig`;
const EXE_NAME = `JP225 Monitor_${version}_x64-setup.exe`;
const RELEASE_URL_BASE = 'https://github.com/sora-moyou/jp225-monitor/releases/download';

if (!existsSync(SIG_PATH)) {
  console.error(`❌ Signature file not found: ${SIG_PATH}`);
  console.error('   Run `npm run release:build` first to produce signed installer.');
  process.exit(1);
}

const signature = readFileSync(SIG_PATH, 'utf-8').trim();
const downloadUrl = `${RELEASE_URL_BASE}/v${version}/${encodeURIComponent(EXE_NAME)}`;

const latest = {
  version,
  notes: process.env.RELEASE_NOTES ?? `JP225 Monitor v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: downloadUrl,
    },
  },
};

const outDir = 'release';
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'latest.json');
writeFileSync(outPath, JSON.stringify(latest, null, 2), 'utf-8');

console.log(`✅ Wrote ${outPath}`);
console.log(`   version: ${version}`);
console.log(`   download URL: ${downloadUrl}`);
console.log(`   signature length: ${signature.length} chars`);
console.log('');
console.log('Next: upload the following to GitHub Release v' + version + ':');
console.log(`   1. ${EXE_NAME}`);
console.log(`   2. ${EXE_NAME}.sig`);
console.log(`   3. release/latest.json`);
