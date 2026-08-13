import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── ★日次予算は「腕(exitVariant)ごと」に独立する ────────────────────────────
//
// 守っているもの: **片方の腕だけが先に枯れる状態を作らない**。
//   予算を全腕で1本にすると、先に叩いた腕が取引日の残りを全部食う。20時間の取引日を
//   先着順で切ることになるので、標本が Day セッション前半に系統的に偏る。
//   この案件の過去の検証(ADR)で見つかった最大の効果は **時間帯そのもの**(Day-AM / Night-NY前 /
//   それ以外で性質が全く違う)なので、時間帯で切られた標本で決済パラメータを比べると
//   既知の最大の交絡を標本設計に組み込むことになる。だから腕ごとに独立させる。
//
// ★否定対照(修正前の generatorGate.ts での結果):
//   checkGeneratorGate に腕の引数が無く、state.used ひとつで判定していたため
//     - 「'current' が予算を使い切っても 'candidate-a' は通る」が **budget で弾かれて赤**
//     - generatorArmUsage が存在せず import 解決に失敗して **ファイル全体が赤**
//   (実証手順: git show HEAD:server/llm/generatorGate.ts で旧版に差し替えて実行)

const h = vi.hoisted(() => ({ budget: 100 }));
vi.mock('../configStore.js', () => ({
  resolveGeneratorDailyBudget: () => h.budget,
}));

import {
  checkGeneratorGate, generatorGateSnapshot, generatorArmUsage, notifyDefaultQuota,
  resetGeneratorGateForTest,
} from './generatorGate.js';
import { DEFAULT_EXIT_VARIANT } from '../signalTrade/exit/index.js';

// JST の実時刻 → epoch(既存 generatorGate.test.ts と同じ基準日)。
const jst = (y: number, mo: number, d: number, hh: number, mm = 0) => Date.UTC(y, mo - 1, d, hh - 9, mm);
const D1_DAY = jst(2026, 6, 1, 10, 0);
const D1_NIGHT = jst(2026, 6, 1, 18, 0);
const D2_DAY = jst(2026, 6, 2, 10, 0);

const reason = (now: number, arm?: 'current' | 'candidate-a'): string | true => {
  const r = checkGeneratorGate(now, arm);
  return r.allowed ? true : r.reason;
};

describe('generatorGate — 予算は腕ごとに独立する', () => {
  beforeEach(() => {
    h.budget = 100;
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('★片方の腕が予算を使い切っても、もう片方は自分の予算を丸ごと持っている', () => {
    h.budget = 2;
    expect(reason(D1_DAY, 'current')).toBe(true);
    expect(reason(D1_DAY, 'current')).toBe(true);
    expect(reason(D1_DAY, 'current')).toBe('budget');       // current は枯れた

    // ★ここが本体: candidate-a は1回も消費していないので、まだ2回ぶん残っている。
    expect(reason(D1_DAY, 'candidate-a')).toBe(true);
    expect(reason(D1_DAY, 'candidate-a')).toBe(true);
    expect(reason(D1_DAY, 'candidate-a')).toBe('budget');
  });

  it('腕を跨いだ消費は混ざらない(帳簿が別)', () => {
    h.budget = 5;
    reason(D1_DAY, 'current');
    reason(D1_DAY, 'current');
    reason(D1_DAY, 'candidate-a');

    expect(generatorArmUsage(D1_DAY)).toEqual({ 'current': 2, 'candidate-a': 1 });
    // 合計は従来どおり snapshot.used で読める(既存の診断表示を壊さない)。
    expect(generatorGateSnapshot(D1_DAY).used).toBe(3);
  });

  it('腕を省略した呼び出しは既定の腕(current)に計上される(既存の呼び出し元と同じ帳簿)', () => {
    h.budget = 5;
    reason(D1_DAY);
    reason(D1_DAY, DEFAULT_EXIT_VARIANT);
    expect(generatorArmUsage(D1_DAY)).toEqual({ current: 2 });
  });

  it('予算は「腕あたりの上限」= Day と Night で同じ取引日なら腕ごとに持ち越す', () => {
    h.budget = 2;
    expect(reason(D1_DAY, 'current')).toBe(true);
    expect(reason(D1_DAY, 'current')).toBe(true);
    expect(reason(D1_NIGHT, 'current')).toBe('budget');     // 同一取引日=復活しない
    expect(reason(D1_NIGHT, 'candidate-a')).toBe(true);     // 別の腕は独立
  });

  it('取引日が変わると全腕の帳簿がリセットされる', () => {
    h.budget = 1;
    reason(D1_DAY, 'current');
    reason(D1_DAY, 'candidate-a');
    expect(reason(D1_DAY, 'current')).toBe('budget');

    expect(reason(D2_DAY, 'current')).toBe(true);
    expect(generatorArmUsage(D2_DAY)).toEqual({ current: 1 });
  });

  it('弾かれた腕は消費しない(枯れた腕が他の腕の帳簿を汚さない)', () => {
    h.budget = 1;
    reason(D1_DAY, 'current');
    reason(D1_DAY, 'current');     // budget で弾かれる
    reason(D1_DAY, 'current');     // budget で弾かれる
    expect(generatorArmUsage(D1_DAY)).toEqual({ current: 1 });
  });

  it('従属停止(default の quota)は **全腕を同時に** 止める(片腕だけ回り続けない)', () => {
    // 「腕ごとに独立」は予算の話。上流クォータの枯渇は全腕に等しく効くべきなので、
    // ここで腕別にすると実取引(A)の枠を片腕が食い続けることになる。
    notifyDefaultQuota('gemini', D1_DAY);
    expect(reason(D1_DAY, 'current')).toBe('default-quota');
    expect(reason(D1_DAY, 'candidate-a')).toBe('default-quota');
  });

  it('★既定の予算は「1本の腕だけでも1取引日をフルカバーできる」値である', async () => {
    // 2分間隔で日中7h+ナイト13hをフルカバーすると約 600 回/取引日。既定がこれを下回ると、
    // 腕ごとに分けても腕が **需要側の都合で** 枯れ、取引日の途中で標本が切れる(=時間帯で切れる)。
    // 運用見込み(分析用2本+対照で約 1,584 回/日)を腕で割った値も満たすこと。
    const cfg = await vi.importActual<typeof import('../configStore.js')>('../configStore.js');
    expect(cfg.GENERATOR_DAILY_BUDGET_DEFAULT).toBeGreaterThanOrEqual(600);
    expect(cfg.GENERATOR_DAILY_BUDGET_DEFAULT * 2).toBeGreaterThanOrEqual(1584);
    // ★上限は残す(予算は上流クォータへの露出の天井なので、無制限にはしない)。
    expect(cfg.GENERATOR_DAILY_BUDGET_MAX).toBeGreaterThan(cfg.GENERATOR_DAILY_BUDGET_DEFAULT);
  });

  it('腕別の消費にキーや決済の実数値は含まれない(回数だけ)', () => {
    h.budget = 3;
    reason(D1_DAY, 'candidate-a');
    const s = JSON.stringify(generatorArmUsage(D1_DAY));
    expect(s).not.toMatch(/key|sk-|api[-_]?key/i);
    expect(Object.values(generatorArmUsage(D1_DAY)).every(v => Number.isInteger(v))).toBe(true);
  });
});
