import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UPDATER_ENDPOINTS, UPDATER_CONF_FILES, updaterEndpointFor, resolveUpdaterEndpoint } from './endpoints.js';
import type { MonitorVariant } from '../variant.js';

// ─────────────────────────────────────────────────────────────────────────────
// 「宣言(tauri conf)と、サーバが実際に叩く URL が別物になる」を作らないための番人。
//
// サーバの probe(server/updater/probe.ts)は **Tauri の updater が見るのと同じ URL** を
// 叩いて初めて証拠になる。別の URL を叩いていたら、記録は正しい顔をしたまま嘘をつく
// (今回の事故=「画面がそう言った以外の証拠が無い」より悪い形)。
// 値は server/updater/endpoints.ts にだけ書き、conf 側との一致をここで固定する。
//
// ★恒真にしないための設計:
//   ①「期待値」を手で書き写さない。左辺は定数モジュール、右辺は **conf ファイルを実際に読んだ値**。
//     どちらか一方を書き換えれば必ず赤くなる。
//   ② 否定対照(下の describe)で、この検査が実際に落ちることを実行して示す。
//
// ★この番人にできないこと(「塞いだ」と書かないための限界):
//   限界A: ここで証明できるのは「定数 ≡ conf の文字列」まで。**その URL が実在して
//          latest.json を返すか** は分からない(オフライン)。実配信の確認は運用側の責務で、
//          それを毎回残すのが update_check の probe(= このモジュールの利用側)。
//   限界B: Rust(lib.rs)が identifier からどちらの conf を選ぶかは検査しない。
//          variant の解決は server/variant.ts に一本化してあり、ここはその結果で表を引くだけ。
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

interface TauriConf { plugins?: { updater?: { endpoints?: unknown } } }

/** conf ファイルを実際に読んで plugins.updater.endpoints を取り出す。 */
export function readConfEndpoints(relPath: string): unknown {
  const conf = JSON.parse(readFileSync(repoRoot + relPath, 'utf-8')) as TauriConf;
  return conf.plugins?.updater?.endpoints;
}

const VARIANTS: readonly MonitorVariant[] = ['full', 'lite'];

describe('updater エンドポイントの定数と tauri conf の一致(番人)', () => {
  for (const variant of VARIANTS) {
    it(`${variant}: ${UPDATER_CONF_FILES[variant]} の endpoints が定数と1バイト違わず一致する`, () => {
      expect(readConfEndpoints(UPDATER_CONF_FILES[variant])).toEqual([updaterEndpointFor(variant)]);
    });
  }

  it('full と lite は別の URL(取り違えると別リポの版を見る)', () => {
    expect(UPDATER_ENDPOINTS.full).not.toBe(UPDATER_ENDPOINTS.lite);
  });

  it('endpoints は必ず 1 本(複数あると「どれを probe したか」が記録から読めない)', () => {
    for (const variant of VARIANTS) {
      expect(readConfEndpoints(UPDATER_CONF_FILES[variant])).toHaveLength(1);
    }
  });

  it('variant の解決は既存の resolveVariant に従う(新しい判定を作っていない)', () => {
    expect(resolveUpdaterEndpoint({ MONITOR_VARIANT: 'lite' } as NodeJS.ProcessEnv)).toBe(UPDATER_ENDPOINTS.lite);
    expect(resolveUpdaterEndpoint({ MONITOR_VARIANT: 'full' } as NodeJS.ProcessEnv)).toBe(UPDATER_ENDPOINTS.full);
    // 未設定/その他は full(variant.ts と同じ安全側の倒し方)。
    expect(resolveUpdaterEndpoint({} as NodeJS.ProcessEnv)).toBe(UPDATER_ENDPOINTS.full);
    expect(resolveUpdaterEndpoint({ MONITOR_VARIANT: 'nonsense' } as NodeJS.ProcessEnv)).toBe(UPDATER_ENDPOINTS.full);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 否定対照: 上の検査が恒真でないことの実証。**ズレを実際に作って、赤になることを見る**。
// ─────────────────────────────────────────────────────────────────────────────
describe('否定対照(この番人が恒真でないことの実証)', () => {
  it('① 定数側を1文字変えると一致検査が落ちる', () => {
    const drifted = UPDATER_ENDPOINTS.full.replace('monitor2-releases', 'monitor2-release');
    expect(drifted).not.toBe(UPDATER_ENDPOINTS.full);
    expect(() => expect(readConfEndpoints(UPDATER_CONF_FILES.full)).toEqual([drifted])).toThrow();
  });

  it('② conf 側が別 URL になっていると一致検査が落ちる(conf を読んだ値を差し替えて再現)', () => {
    const confSaysLite = [UPDATER_ENDPOINTS.lite];      // full の conf に lite の URL が入った状態
    expect(() => expect(confSaysLite).toEqual([updaterEndpointFor('full')])).toThrow();
  });

  it('③ conf の endpoints が 2 本になったら落ちる', () => {
    const two = [UPDATER_ENDPOINTS.full, UPDATER_ENDPOINTS.lite];
    expect(() => expect(two).toHaveLength(1)).toThrow();
  });

  it('④ conf から updater ごと消えたら undefined になり、一致検査が落ちる', () => {
    const conf: TauriConf = { plugins: {} };
    expect(conf.plugins?.updater?.endpoints).toBeUndefined();
    expect(() => expect(conf.plugins?.updater?.endpoints).toEqual([updaterEndpointFor('full')])).toThrow();
  });
});
