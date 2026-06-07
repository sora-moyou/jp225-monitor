#!/usr/bin/env node
// 署名付き Tauri ビルド。
// ~/.tauri/jp225-monitor.key を読み、Tauri が期待する env var に設定して
// npm run tauri:build を呼ぶ。シェル依存の export 失敗を避ける。

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const keyPath = join(homedir(), '.tauri', 'jp225-monitor.key');
if (!existsSync(keyPath)) {
  console.error(`❌ Private key not found: ${keyPath}`);
  console.error('   Run `npm run tauri:signer` first.');
  process.exit(1);
}
const key = readFileSync(keyPath, 'utf-8').trim();
// jp225-monitor 鍵はパスフレーズ無し(空)。共有 env 変数 TAURI_SIGNING_PRIVATE_KEY_PASSWORD は
// 他プロジェクト(jp225-Trade=パスフレーズ"trade")の値が入りうるため参照せず空に固定する
// (誤った非空パスワードで署名が "Wrong password" になるのを防ぐ)。
const password = '';

console.log(`🔐 Using private key: ${keyPath} (${key.length} chars)`);
console.log(`🔐 Password length:   ${password.length} (0 = no password)`);

const result = spawnSync('npm', ['run', 'tauri:build'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  },
});

if (result.status !== 0) {
  console.error(`❌ Build failed with exit code ${result.status}`);
  process.exit(result.status ?? 1);
}

// 成果物の場所を表示
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const version = pkg.version;
const exe = `src-tauri/target/release/bundle/nsis/JP225 Monitor_${version}_x64-setup.exe`;
const sig = exe + '.sig';

console.log('');
console.log('✅ Build complete:');
console.log(`   exe: ${exe} (${existsSync(exe) ? 'OK' : '❌ MISSING'})`);
console.log(`   sig: ${sig} (${existsSync(sig) ? 'OK' : '❌ MISSING — signing did not run'})`);
