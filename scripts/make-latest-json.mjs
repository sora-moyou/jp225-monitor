#!/usr/bin/env node
// tauri:build 完了後に呼ぶ。生成された .sig ファイルを読んで updater 用の latest.json を作る。
// PRODUCT=monitor2(既定) / lite で release repo・URL・exe 名を切替。
//
// 使い方:
//   PRODUCT=monitor2 npm run release:latest-json   (既定)
//   PRODUCT=lite     npm run release:latest-json
//   → release/latest.json と成果物名を出力
//   → 中身を確認して各 GitHub Release にアップロードする
//
// 環境変数 RELEASE_NOTES があればその内容を notes フィールドに入れる。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PRODUCTS = {
  monitor2: {
    exeBase: 'JP225 Monitor2',
    // GitHub は asset 名の空白をドットに置換するため、DL URL はドット形にする。
    exeBaseForUrl: 'JP225.Monitor2',
    releaseRepo: 'sora-moyou/jp225-monitor2-releases',
    urlBase: 'https://github.com/sora-moyou/jp225-monitor2-releases/releases/download',
    notesName: 'JP225 Monitor2',
  },
  lite: {
    exeBase: 'JP225 Monitor',
    exeBaseForUrl: 'JP225.Monitor',
    releaseRepo: 'sora-moyou/jp225-monitor',
    urlBase: 'https://github.com/sora-moyou/jp225-monitor/releases/download',
    notesName: 'JP225 Monitor',
  },
};

const PRODUCT = process.env.PRODUCT ?? 'monitor2';
const cfg = PRODUCTS[PRODUCT];
if (!cfg) {
  console.error(`❌ Unknown PRODUCT="${PRODUCT}". Use one of: ${Object.keys(PRODUCTS).join(', ')}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const version = pkg.version;

const SIG_PATH = `src-tauri/target/release/bundle/nsis/${cfg.exeBase}_${version}_x64-setup.exe.sig`;
const EXE_NAME_FOR_URL = `${cfg.exeBaseForUrl}_${version}_x64-setup.exe`;
const RELEASE_URL_BASE = cfg.urlBase;

if (!existsSync(SIG_PATH)) {
  console.error(`❌ Signature file not found: ${SIG_PATH}`);
  console.error('   Run `PRODUCT=' + PRODUCT + ' npm run release:build` first to produce signed installer.');
  process.exit(1);
}

const signature = readFileSync(SIG_PATH, 'utf-8').trim();
const downloadUrl = `${RELEASE_URL_BASE}/v${version}/${EXE_NAME_FOR_URL}`;

const latest = {
  version,
  notes: process.env.RELEASE_NOTES ?? `${cfg.notesName} v${version}`,
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
console.log(`   PRODUCT: ${PRODUCT}`);
console.log(`   version: ${version}`);
console.log(`   download URL: ${downloadUrl}`);
console.log(`   signature length: ${signature.length} chars`);
console.log('');
console.log(`Next: upload the following to GitHub Release v${version} on ${cfg.releaseRepo}:`);
console.log(`   1. ${cfg.exeBase}_${version}_x64-setup.exe`);
console.log(`   2. ${cfg.exeBase}_${version}_x64-setup.exe.sig`);
console.log(`   3. release/latest.json`);
