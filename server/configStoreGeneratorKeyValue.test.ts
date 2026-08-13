import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache, resolveApiKeyForPool, resolveGeneratorKeySource } from './configStore.js';
import { evaluatePreflight } from './generator/preflight.js';

// ─── ★C1: 専用キーの検証は「出どころ」ではなく **値** を見る ─────────────────────────
//
// 何を守っているか:
//   分析用の起動時検証(preflight)は generatorKeySources が 'own'/'env' であることだけを見ている。
//   その検証が守ろうとしているのは「分析用が上流クォータを食って **A が429を踏み、最大8時間ポーズする**」
//   という一点。だから **共通キーと同じ文字列** を分析用キー欄に貼った状態は、欄がどこであれ
//   上流クォータ 100% 共有で、危険は1ミリも減っていない。それを 'own' と呼ぶと検証が通ってしまう。
//
// ★否定対照(修正前 = git show HEAD:server/configStore.ts):
//   resolveGeneratorKey は generatorKeys[provider] が非空なら無条件に source='own' を返していたので、
//   下の「共通キーと同じ値なら shared」「その状態で preflight が止まる」が **赤** になる。
//   実証手順: git show HEAD:server/configStore.ts > /tmp/old.ts で差し替えて実行。

const ENV_KEYS = [
  'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'KIMI_API_KEY',
  'GENERATOR_GEMINI_API_KEY', 'GENERATOR_GROQ_API_KEY', 'GENERATOR_OPENAI_API_KEY',
  'GENERATOR_KIMI_API_KEY',
] as const;
const ORIG: Record<string, string | undefined> = {};

let dir: string;
function writeConfig(obj: Record<string, unknown>): void {
  mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
  writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify(obj, null, 2));
  resetConfigCache();
}

describe('★分析用専用キーの判定は値で行う(コピペした共通キーを own と呼ばない)', () => {
  beforeEach(() => {
    for (const k of ['HOME', 'USERPROFILE', 'APPDATA', ...ENV_KEYS]) ORIG[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'jp225-genkeyval-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    for (const k of ENV_KEYS) delete process.env[k];
    resetConfigCache();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(ORIG)) { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
    resetConfigCache();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('★共通キーをそのまま分析用キー欄に貼った場合は shared(上流クォータは分かれていない)', () => {
    writeConfig({ geminiKey: 'AIza-same', generatorKeys: { gemini: 'AIza-same' } });
    expect(resolveGeneratorKeySource('gemini')).toBe('shared');
    // 実際に使うキーは変わらない(=だからこそ危険が減っていない)。
    expect(resolveApiKeyForPool('gemini', 'generator')).toBe('AIza-same');
  });

  it('前後の空白だけが違う値も同一として扱う(貼り付け由来の空白で判定が変わらない)', () => {
    writeConfig({ geminiKey: 'AIza-same', generatorKeys: { gemini: '  AIza-same  ' } });
    expect(resolveGeneratorKeySource('gemini')).toBe('shared');
  });

  it('値が違えば従来どおり own(正しく分離しているケースは1ミリも変わらない)', () => {
    writeConfig({ geminiKey: 'AIza-shared', generatorKeys: { gemini: 'AIza-dedicated' } });
    expect(resolveGeneratorKeySource('gemini')).toBe('own');
    expect(resolveApiKeyForPool('gemini', 'generator')).toBe('AIza-dedicated');
    // ★default プール(実取引 A)は一切変わらない。
    expect(resolveApiKeyForPool('gemini', 'default')).toBe('AIza-shared');
  });

  it('★環境変数の専用キーが共通キーと同じ値でも shared', () => {
    writeConfig({ geminiKey: 'AIza-same' });
    process.env.GENERATOR_GEMINI_API_KEY = 'AIza-same';
    resetConfigCache();
    expect(resolveGeneratorKeySource('gemini')).toBe('shared');
  });

  it('★その shared を preflight が拾って分析用を走らせない(検証が実際に守れるようになる)', () => {
    writeConfig({ geminiKey: 'AIza-same', generatorKeys: { gemini: 'AIza-same' } });
    const status = { exit: { impl: 'private', variantImpl: 'private', configVersion: 1, configHash: 'h' } };
    const settings = {
      generatorKeySources: {
        gemini: resolveGeneratorKeySource('gemini'),
        groq: 'own', openai: 'own', kimi: 'own',
      },
    };
    const r = evaluatePreflight(status, settings);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('violated');
      expect(r.reason).toContain('gemini=shared');
    }
  });
});
