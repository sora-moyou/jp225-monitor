#!/usr/bin/env node
// 署名付き Tauri ビルド(2製品対応)。
// PRODUCT=monitor2(既定) / lite で切替:
//   - monitor2(フル): 鍵 ~/.tauri/jp225-monitor2.key・config=base・exe "JP225 Monitor2_..."
//   - lite(表示縮小): 鍵 ~/.tauri/jp225-monitor.key・config=tauri.lite.conf.json・exe "JP225 Monitor_..."
// 両鍵ともパスフレーズ無し(空)。共有 env TAURI_SIGNING_PRIVATE_KEY_PASSWORD は
// 他プロジェクト(jp225-Trade=パスフレーズ"trade")の値が入りうるため参照せず空に固定する。

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PRODUCTS = {
  monitor2: {
    keyFile: 'jp225-monitor2.key',
    buildScript: 'tauri:build',        // base tauri.conf.json
    exeBase: 'JP225 Monitor2',
  },
  lite: {
    keyFile: 'jp225-monitor.key',
    buildScript: 'tauri:build:lite',   // tauri build --config tauri.lite.conf.json
    exeBase: 'JP225 Monitor',
  },
};

const PRODUCT = process.env.PRODUCT ?? 'monitor2';
const cfg = PRODUCTS[PRODUCT];
if (!cfg) {
  console.error(`❌ Unknown PRODUCT="${PRODUCT}". Use one of: ${Object.keys(PRODUCTS).join(', ')}`);
  process.exit(1);
}

const keyPath = join(homedir(), '.tauri', cfg.keyFile);
if (!existsSync(keyPath)) {
  console.error(`❌ Private key not found: ${keyPath}`);
  console.error('   Generate it with `tauri signer generate -w <path>` first.');
  process.exit(1);
}
const key = readFileSync(keyPath, 'utf-8').trim();
const password = ''; // 両鍵ともパスフレーズ無し(空)。

// ── プリフライト検査(署名ビルドの入場券) ────────────────────────────────
// 型検査とテストを **ビルドより前に** 走らせ、1つでも落ちたらここで中止する。
// これが無かった頃は、型エラー/テスト赤のまま署名済みインストーラを作れてしまった。
// 直前の PRODUCT / 鍵の存在確認は副作用ゼロの即時チェックなので先に済ませてある
// (鍵が無いのに数分のテストを待たされるのを避けるため)。ビルド(tauri build)を
// 起動しうる経路はこの下だけで、そこへ到達するには必ず検査を通る必要がある。
const PREFLIGHT = [
  { label: '型検査 (tsc --noEmit)', args: ['run', 'typecheck'] },
  { label: 'テスト (vitest run)', args: ['run', 'test'] },
];

for (const step of PREFLIGHT) {
  console.log('');
  console.log(`🔎 preflight: ${step.label} ...`);
  const r = spawnSync('npm', step.args, { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error('');
    console.error(`❌ preflight 失敗: ${step.label} (exit code ${r.status})`);
    console.error('   検査が通らないため署名ビルドを中止しました。修正してからやり直してください。');
    process.exit(r.status ?? 1);
  }
  console.log(`✅ preflight OK: ${step.label}`);
}

console.log('');
console.log('✅ preflight 完了 — ビルドを開始します。');

console.log(`📦 PRODUCT: ${PRODUCT}`);
console.log(`🔐 Using private key: ${keyPath} (${key.length} chars)`);
console.log(`🔐 Password length:   ${password.length} (0 = no password)`);

const result = spawnSync('npm', ['run', cfg.buildScript], {
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
const exe = `src-tauri/target/release/bundle/nsis/${cfg.exeBase}_${version}_x64-setup.exe`;
const sig = exe + '.sig';

console.log('');
console.log('✅ Build complete:');
console.log(`   exe: ${exe} (${existsSync(exe) ? 'OK' : '❌ MISSING'})`);
console.log(`   sig: ${sig} (${existsSync(sig) ? 'OK' : '❌ MISSING — signing did not run'})`);
