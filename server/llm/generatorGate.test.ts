import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── 生成器ゲート: 日次予算 / ★従属規則 / backpressure ────────────────────
//
// 守っているもの:
//   1. 生成器は **自分の予算** を持ち、使い切ったら **止まる**(モードを書き換えたり無音で縮退したりしない)。
//      過去に「上限50回で無音の dryrun 化」が保護注文を消した事故がある。同じ形にしない。
//   2. ★従属規則: **default(実弾A)が quota を踏んだら**、生成器はそのセッションの残りを停止する。
//      同一APIキーだと上流クォータは共有されたままなので、プール分離だけでは A の枠を食える。
//   3. backpressure: A/B のプラン生成中に生成器が叩くと vision 呼び出しが同時多重になる。生成中は弾く。
//
// ★否定対照: 修正前は generatorGate.ts 自体が存在しない(=このファイルは import で失敗して赤)。
//   予算も従属も backpressure も、生成器を止める手段がひとつも無かった。

const h = vi.hoisted(() => ({ budget: 100 }));
vi.mock('../configStore.js', () => ({
  resolveGeneratorDailyBudget: () => h.budget,
}));

import {
  checkGeneratorGate, notifyDefaultQuota, beginScalpPlan, endScalpPlan,
  scalpPlanInFlight, generatorGateSnapshot, resetGeneratorGateForTest,
} from './generatorGate.js';

// JST の実時刻 → epoch。core/session.classifySession の判定を実際に通す。
const jst = (y: number, mo: number, d: number, hh: number, mm = 0) => Date.UTC(y, mo - 1, d, hh - 9, mm);

// 2026-06-01(月)は取引日(collector/session.test.ts と同じ基準日)。
const D1_DAY = jst(2026, 6, 1, 10, 0);      // Day セッション(sessionDate 2026-06-01)
const D1_NIGHT = jst(2026, 6, 1, 18, 0);    // Night セッション(sessionDate 2026-06-01 = **同一取引日**)
const D2_DAY = jst(2026, 6, 2, 10, 0);      // 翌取引日の Day(sessionDate 2026-06-02)

function reason(now: number): string | true {
  const r = checkGeneratorGate(now);
  return r.allowed ? true : r.reason;
}

describe('generatorGate', () => {
  beforeEach(() => {
    h.budget = 100;
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('日次予算', () => {
    it('予算内は通す/使い切ったら止まる(reason=budget)', () => {
      h.budget = 3;
      expect(reason(D1_DAY)).toBe(true);
      expect(reason(D1_DAY)).toBe(true);
      expect(reason(D1_DAY)).toBe(true);
      expect(reason(D1_DAY)).toBe('budget');
      expect(reason(D1_DAY)).toBe('budget');   // 以後ずっと止まったまま
    });

    it('★止まるだけ: 予算切れで縮退や別モードへの切替は起きない(通過しない=それが全て)', () => {
      h.budget = 1;
      expect(checkGeneratorGate(D1_DAY).allowed).toBe(true);
      const blocked = checkGeneratorGate(D1_DAY);
      expect(blocked.allowed).toBe(false);
      expect(blocked.allowed === false && blocked.reason).toBe('budget');
      // 使用量は増えない(弾いた分は消費しない)
      expect(generatorGateSnapshot(D1_DAY).used).toBe(1);
    });

    it('弾かれた要求は予算を消費しない', () => {
      h.budget = 2;
      beginScalpPlan();                       // busy で弾かれる状況を作る
      expect(reason(D1_DAY)).toBe('busy');
      expect(reason(D1_DAY)).toBe('busy');
      endScalpPlan();
      expect(generatorGateSnapshot(D1_DAY).used).toBe(0);
      expect(reason(D1_DAY)).toBe(true);
      expect(generatorGateSnapshot(D1_DAY).used).toBe(1);
    });

    it('★Day と Night は同じ取引日 = 同じ予算を共有する(sessionDate 単位)', () => {
      h.budget = 2;
      expect(reason(D1_DAY)).toBe(true);
      expect(reason(D1_DAY)).toBe(true);
      // 同じ 2026-06-01 の Night に移っても予算は復活しない
      expect(reason(D1_NIGHT)).toBe('budget');
      expect(generatorGateSnapshot(D1_NIGHT).dayKey).toBe('2026-06-01');
    });

    it('翌取引日で予算がリセットされる', () => {
      h.budget = 1;
      expect(reason(D1_DAY)).toBe(true);
      expect(reason(D1_DAY)).toBe('budget');
      expect(reason(D2_DAY)).toBe(true);
      expect(generatorGateSnapshot(D2_DAY).dayKey).toBe('2026-06-02');
    });

    it('予算 0 = 生成器を無効化(reason=disabled)', () => {
      h.budget = 0;
      expect(reason(D1_DAY)).toBe('disabled');
      expect(generatorGateSnapshot(D1_DAY).used).toBe(0);
    });

    it('取引時間外は直前のセッションのキーを保持する(空白帯で予算がリセットされる抜け穴を作らない)', () => {
      h.budget = 1;
      expect(reason(D1_DAY)).toBe(true);
      const gap = jst(2026, 6, 1, 16, 30);   // 15:45〜17:00 の空白帯(セッション外)
      expect(reason(gap)).toBe('budget');
      expect(generatorGateSnapshot(gap).dayKey).toBe('2026-06-01');
    });
  });

  describe('★従属規則(default が quota を踏んだら生成器を止める)', () => {
    it('default の quota でそのセッションの残りを停止する(予算が余っていても止まる)', () => {
      h.budget = 100;
      expect(reason(D1_DAY)).toBe(true);

      notifyDefaultQuota('gemini', D1_DAY);

      expect(reason(D1_DAY)).toBe('default-quota');
      expect(reason(D1_DAY)).toBe('default-quota');
      // 予算はまだ 99 残っているのに止まっている = 「自分の429ではなく A の429で止まる」
      expect(generatorGateSnapshot(D1_DAY).used).toBe(1);
      expect(generatorGateSnapshot(D1_DAY).haltedSessionKey).toBe('2026-06-01|Day');
    });

    it('従属停止は **そのセッションだけ**: 次のセッション(Night)で解除される', () => {
      notifyDefaultQuota('gemini', D1_DAY);
      expect(reason(D1_DAY)).toBe('default-quota');
      expect(reason(D1_NIGHT)).toBe(true);
      expect(generatorGateSnapshot(D1_NIGHT).haltedSessionKey).toBeNull();
    });

    it('従属停止は backpressure より優先して報告される(より重い状態を隠さない)', () => {
      notifyDefaultQuota('gemini', D1_DAY);
      beginScalpPlan();
      expect(reason(D1_DAY)).toBe('default-quota');
      endScalpPlan();
    });

    it('停止していない通常時は素通しする(誤検知しない)', () => {
      expect(reason(D1_DAY)).toBe(true);
      expect(generatorGateSnapshot(D1_DAY).haltedSessionKey).toBeNull();
    });
  });

  describe('backpressure(生成中は弾く)', () => {
    it('生成中(inFlight>0)なら reason=busy / 終わったら通す', () => {
      beginScalpPlan();
      expect(scalpPlanInFlight()).toBe(1);
      expect(reason(D1_DAY)).toBe('busy');
      endScalpPlan();
      expect(scalpPlanInFlight()).toBe(0);
      expect(reason(D1_DAY)).toBe(true);
    });

    it('多重の begin/end が釣り合う(負にならない)', () => {
      beginScalpPlan();
      beginScalpPlan();
      expect(scalpPlanInFlight()).toBe(2);
      endScalpPlan();
      expect(reason(D1_DAY)).toBe('busy');
      endScalpPlan();
      endScalpPlan();                        // 余分な end でも負にしない
      expect(scalpPlanInFlight()).toBe(0);
      expect(reason(D1_DAY)).toBe(true);
    });
  });

  describe('記録(無音にしない)', () => {
    it('見送りは種別ごとにカウントされ、スナップショットから読める', () => {
      h.budget = 1;
      beginScalpPlan();
      checkGeneratorGate(D1_DAY);            // busy
      endScalpPlan();
      checkGeneratorGate(D1_DAY);            // allowed(予算1を消費)
      checkGeneratorGate(D1_DAY);            // budget
      notifyDefaultQuota('groq', D1_DAY);
      checkGeneratorGate(D1_DAY);            // default-quota

      const snap = generatorGateSnapshot(D1_DAY);
      expect(snap.used).toBe(1);
      expect(snap.skipped).toEqual({ busy: 1, budget: 1, defaultQuota: 1, disabled: 0 });
    });

    it('見送りは必ずログに残る(console.warn が呼ばれる)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.budget = 0;
      checkGeneratorGate(D1_DAY);
      expect(warn).toHaveBeenCalled();
    });

    it('スナップショットに API キーの類は含まれない', () => {
      const snap = generatorGateSnapshot(D1_DAY);
      expect(Object.keys(snap).sort()).toEqual(
        ['budget', 'dayKey', 'haltedSessionKey', 'inFlight', 'sessionKey', 'skipped', 'used'],
      );
    });
  });
});
