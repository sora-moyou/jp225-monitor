#!/usr/bin/env node
// bin/jp225-monitor.exe → src-tauri/binaries/jp225-monitor-<target-triple>.exe
// Tauri が sidecar として認識する命名規則に合わせる

import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

function targetTriple() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

const src = process.platform === 'win32' ? 'bin/jp225-monitor.exe' : 'bin/jp225-monitor';
if (!existsSync(src)) {
  console.error(`❌ ${src} がありません。先に \`npm run package\` を実行してください。`);
  process.exit(1);
}

const triple = targetTriple();
const ext = process.platform === 'win32' ? '.exe' : '';
const dstDir = 'src-tauri/binaries';
// NOTE: ファイル名は Rust クレート名 (jp225-monitor) と衝突させない。
// 衝突すると Tauri の sidecar 解決が target/debug/jp225-monitor.exe (Rust本体) を掴み
// fork-bomb 化する。よって "jp225-sidecar-" prefix を採用。
const dst = join(dstDir, `jp225-sidecar-${triple}${ext}`);

mkdirSync(dstDir, { recursive: true });
copyFileSync(src, dst);

const sizeMB = (statSync(dst).size / 1024 / 1024).toFixed(1);
console.log(`✅ Copied ${src} → ${dst} (${sizeMB} MB)`);
