#!/usr/bin/env node
// tauri:dev / tauri:build 開始前に残存している jp225-monitor プロセスを一掃する。
// Tauri 開発中の Ctrl+C やクラッシュで orphan 化したサイドカーが、
// 次回起動時のファイルコピー (sidecar:copy) を競合させたり、port 3000 を専有して
// 新サイドカーを多重起動させたりするのを防ぐ。

import { execSync } from 'node:child_process';
import { platform } from 'node:process';

// 旧名 (jp225-monitor.exe) と新名 (jp225-sidecar.exe) の両方を掃除。
// 旧名は Rust クレート由来の名前と衝突していた歴史的事情。
const targets = platform === 'win32'
  ? ['jp225-sidecar.exe', 'jp225-monitor.exe']
  : ['jp225-sidecar', 'jp225-monitor'];

let killed = 0;
for (const t of targets) {
  try {
    if (platform === 'win32') {
      execSync(`taskkill /F /T /IM ${t}`, { stdio: ['ignore', 'pipe', 'ignore'] });
    } else {
      execSync(`pkill -f ${t}`, { stdio: ['ignore', 'pipe', 'ignore'] });
    }
    killed++;
  } catch {
    /* not found = OK */
  }
}
console.log(killed > 0 ? `🧹 killed lingering sidecar(s) (${killed} name(s) matched)` : '🧹 no lingering sidecar');
