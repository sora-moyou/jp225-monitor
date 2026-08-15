import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getRecentAlerts, insertAlert, type AlertRow } from './db/store.js';
import { recordAlert, followupTick, summarize, kindLabel, rowKind, shouldPersistInMonitor,
  pickRecentL2, formatL2Summary } from './alertHistory.js';
import { DETECTION_KINDS, isTechnicalKind, isDirectionalKind, detectionKindLabel } from '../core/detectionKinds.js';
import type { AlertEventPayload } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;  // placeholder so `db.close?.()` in summarize test is a harmless no-op

function payload(over: Partial<any> = {}): AlertEventPayload {
  return { symbol: 'NIY=F', symbolLabel: '日経225先物', changePercent: 0.3, windowSeconds: 60,
    detectionKind: 'slope', direction: 'up', triggeredAt: Date.UTC(2026, 5, 1, 1, 0), change15min: null,
    pa15min: null, range1h: null, zscore: 3.1, ...over };
}

describe('recordAlert', () => {
  it('payload と発火価格から alerts に1行入れ、session を付与', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    recordAlert(db, payload(), 67000);
    const r = getRecentAlerts(db, 1)[0]!;
    expect(r.price).toBe(67000);
    expect(r.direction).toBe('up');
    expect(r.window_seconds).toBe(60);
    expect(r.session).toBe('Day');           // 10:00 JST Monday = Day
    db.close();
  });
});

describe('followupTick', () => {
  it('+5/15/30分の bar close から発火価格比リターン%を埋める', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const t0 = Date.UTC(2026, 5, 1, 1, 0);   // fire time
    insertAlert(db, { symbol: 'NIY=F', triggeredAt: t0, direction: 'up', detectionKind: 'slope',
      windowSeconds: 60, changePercent: 0.3, price: 1000, sessionDate: '2026-06-01', session: 'Day' });
    const bar = (t: number, c: number) => db.prepare(
      'INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', '2026-06-01', 'Day', t, c, c, c, c);
    bar(t0 + 5 * 60_000, 1005);     // +5分 → +0.5%
    bar(t0 + 15 * 60_000, 1010);    // +15分 → +1.0%
    bar(t0 + 30 * 60_000, 990);     // +30分 → -1.0%
    followupTick(db, t0 + 31 * 60_000);
    const r = getRecentAlerts(db, 1)[0]!;
    expect(r.ret5).toBeCloseTo(0.5, 5);
    expect(r.ret15).toBeCloseTo(1.0, 5);
    expect(r.ret30).toBeCloseTo(-1.0, 5);
    db.close();
  });

  it('まだ30分経過していなければ対象外(ret は null のまま)', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const t0 = Date.UTC(2026, 5, 1, 1, 0);
    insertAlert(db, { symbol: 'NIY=F', triggeredAt: t0, direction: 'up', detectionKind: 'slope',
      windowSeconds: 60, changePercent: 0.3, price: 1000, sessionDate: '2026-06-01', session: 'Day' });
    followupTick(db, t0 + 10 * 60_000);
    expect(getRecentAlerts(db, 1)[0]!.ret30).toBeNull();
    db.close();
  });
});

describe('shouldPersistInMonitor', () => {
  it('collector 非稼働なら全種別を monitor が記録', () => {
    for (const k of ['slope', 'shock', 'granville', 'dtb', 'break']) {
      expect(shouldPersistInMonitor(k, false)).toBe(true);
    }
  });
  // ★旧テストはここで break/double/level_sr/pivot/dtb/swingdtb を「collector 非検知」として
  //   true に固定していた。STEP6 で collector が runLevelDetectors を回すようになった時点で
  //   その前提は事実と食い違っており、テストが二重記録を「正しい挙動」として守っていた。
  it('collector 稼働中に monitor が記録するのは monitor 専用種別(slope)だけ', () => {
    // monitor 専用 = collector が検知経路を持たない(tickDetector は priceLoop 由来 = monitor のみ)
    expect(shouldPersistInMonitor('slope', true)).toBe(true);
    // collector が検知・記録する種別 → 二重書き込み防止のため monitor は記録しない
    // (bar 検知)
    for (const k of ['shock', 'trend', 'ma_sr', 'granville', 'ma']) {
      expect(shouldPersistInMonitor(k, true)).toBe(false);
    }
    // (level 検知: STEP6 で collector も回すようになった = 二重記録の真因だった種別)
    for (const k of ['break', 'double', 'level_sr', 'pivot', 'dailyband', 'nwave']) {
      expect(shouldPersistInMonitor(k, true)).toBe(false);
    }
    // crash は collector も検知(独自シード)→ collector が authoritative
    expect(shouldPersistInMonitor('crash', true)).toBe(false);
    // null / legacy(dtb/swingdtb/magnitude)も monitor 専用集合外 → collector 稼働中は記録しない
    for (const k of [null, 'dtb', 'swingdtb', 'magnitude']) {
      expect(shouldPersistInMonitor(k, true)).toBe(false);
    }
  });
});

describe('rowKind', () => {
  it('検知種別ごとの専用ラベル', () => {
    expect(rowKind('granville', null)).toBe('グランビル');
    expect(rowKind('shock', null)).toBe('急変');
    expect(rowKind('dtb', null)).toBe('Wトップ/ボトム');
    expect(rowKind('break', null)).toBe('水準ブレイク');
    expect(rowKind('ma', null)).toBe('MA抜け');
    expect(rowKind('swingdtb', null)).toBe('ダブル(大)');
    expect(rowKind('crash', null)).toBe('暴落');
    expect(rowKind('nwave', null)).toBe('N波動');
    expect(rowKind('dailyband', null)).toBe('日足バンド');
    expect(rowKind('slope', 60)).toBe('短期');   // 専用ラベル無し → 窓秒基準
  });

  // 種別を足してラベルを決め忘れると、履歴一覧に「短期」等が混ざって別種別と区別できなくなる。
  it('固有ラベルを持つ全種別が窓秒フォールバックに落ちない', () => {
    for (const k of DETECTION_KINDS) {
      const label = detectionKindLabel(k);
      if (label === null) continue;
      expect(rowKind(k, 60), k).toBe(label);
      expect(rowKind(k, 60), k).not.toBe(kindLabel(60));
    }
  });
});

describe('pickRecentL2(AI へ渡す「直近の状況」)', () => {
  const row = (over: Partial<AlertRow>): AlertRow => ({
    id: 1, symbol: 'NIY=F', triggered_at: 1000, direction: 'up', detection_kind: 'break',
    window_seconds: 60, change_percent: 0, price: 67455, session_date: '2026-06-05', session: 'Day',
    ret5: null, ret15: null, ret30: null, reference_kind: null, reference_price: null,
    ...over,
  } as AlertRow);

  // ★実害(v0.9.36〜v0.9.48): 手書きの L2_KINDS 集合に nwave / dailyband が入っておらず、
  //   N波動/日足バンドのアラートは AI へ渡す「直近の状況」から永久に脱落していた(画面には出ない無言の欠落)。
  it('L2 種別を全て拾う(nwave / dailyband を含む)', () => {
    for (const k of DETECTION_KINDS.filter(isTechnicalKind)) {
      expect(pickRecentL2([row({ detection_kind: k })], 1000, 60_000)?.detection_kind, k).toBe(k);
    }
  });

  it('L1(価格変化)種別は拾わない — 「直近のテクニカル状況」の母集団ではない', () => {
    for (const k of DETECTION_KINDS.filter(k => !isTechnicalKind(k))) {
      expect(pickRecentL2([row({ detection_kind: k })], 1000, 60_000), k).toBeNull();
    }
  });

  it('窓(withinMs)より古い行は拾わない / 要約は「{種別} {価格} ▲」', () => {
    const nw = row({ detection_kind: 'nwave', triggered_at: 1000, price: 67455 });
    expect(pickRecentL2([nw], 1000 + 61_000, 60_000)).toBeNull();
    expect(formatL2Summary(nw)).toBe('N波動 67,455 ▲');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  方向を持たない検知(squeeze/bulge)に ▲ を付けていた欠陥
  // ═══════════════════════════════════════════════════════════════════════════════════
  //
  // ★実害: alerts.direction は必須列なので、方向の概念が無い squeeze/bulge にも 'up' が入っている
  //   (server/detect/registry.ts が便宜上そう積む)。formatL2Summary はそれを無条件に ▲ にしていたので、
  //   AI へ渡る「直近の状況」に **「スクイーズ 62,490 ▲」** と入っていた。BB幅の収縮に上向きの意味は無く、
  //   これは無い方向を AI に主張する無言の嘘。的中率の方向内訳も同様に無意味になる。
  //
  // ★旧実装(git show HEAD:server/alertHistory.ts の formatL2Summary をそのまま写したもの)。
  //   方向を持つ種別では新実装がこれと **1バイトも変わらない** ことをこの写しで固定する。
  const legacyFormatL2Summary = (r: AlertRow): string => {
    const arrow = r.direction === 'up' ? '▲' : '▼';
    return `${rowKind(r.detection_kind, r.window_seconds)} ${Math.round(r.price ?? 0).toLocaleString('ja-JP')} ${arrow}`;
  };

  it('★不変: 方向を持つ全種別 × up/down で旧実装と byte 一致(今回の修正で他種別は1文字も変わらない)', () => {
    for (const k of DETECTION_KINDS.filter(isDirectionalKind)) {
      for (const d of ['up', 'down'] as const) {
        const r = row({ detection_kind: k, direction: d, price: 62_490 });
        expect(formatL2Summary(r), `${k}/${d}`).toBe(legacyFormatL2Summary(r));
      }
    }
    // 代表例を実文字列でも固定(写しが壊れたら共倒れしないように)。
    expect(formatL2Summary(row({ detection_kind: 'break', direction: 'down', price: 67_470 })))
      .toBe('水準ブレイク 67,470 ▼');
    expect(formatL2Summary(row({ detection_kind: 'bandwalk', direction: 'up', price: 62_490 })))
      .toBe('バンドウォーク 62,490 ▲');
  });

  it('★スクイーズ/バルジは矢印を出さない(価格で終わる) — 旧実装とは必ず異なる', () => {
    const sq = row({ detection_kind: 'squeeze', direction: 'up', price: 62_490 });
    expect(formatL2Summary(sq)).toBe('スクイーズ 62,490');
    expect(formatL2Summary(sq)).not.toBe(legacyFormatL2Summary(sq));   // 否定対照: 旧実装は '… ▲'
    expect(legacyFormatL2Summary(sq)).toBe('スクイーズ 62,490 ▲');     // 直した中身(嘘の現物)

    const bg = row({ detection_kind: 'bulge', direction: 'up', price: 62_490 });
    expect(formatL2Summary(bg)).toBe('バルジ 62,490');
    // direction が何であっても方向は出さない(記録に 'down' が混じっても表示は不変)。
    expect(formatL2Summary(row({ detection_kind: 'bulge', direction: 'down', price: 62_490 })))
      .toBe('バルジ 62,490');
  });

  it('方向を持たない種別の要約に方向記号が一切含まれない(表示の網羅チェック)', () => {
    for (const k of DETECTION_KINDS.filter(k => !isDirectionalKind(k))) {
      for (const d of ['up', 'down'] as const) {
        const s = formatL2Summary(row({ detection_kind: k, direction: d, price: 62_490 }));
        expect(s, `${k}/${d}`).not.toMatch(/[▲▼]/);
        expect(s.endsWith(' '), `${k}/${d}: 末尾に余分な空白を残さない`).toBe(false);
      }
    }
  });
});

describe('summarize / kindLabel', () => {
  it('種別ラベル(windowSeconds基準)', () => {
    expect(kindLabel(8)).toBe('超短期');
    expect(kindLabel(60)).toBe('短期');
    expect(kindLabel(300)).toBe('長期');
  });
  it('種別ごとの的中率(15分基準, HIT=0.1%)と平均retを集計', () => {
    const rows: AlertRow[] = [
      { id: 1, symbol: 'NIY=F', triggered_at: 1, direction: 'up', detection_kind: 'slope', window_seconds: 60,
        change_percent: 0.3, price: 1000, session_date: null, session: null, ret5: 0.2, ret15: 0.5, ret30: 0.4,
        reference_kind: null, reference_price: null },
      { id: 2, symbol: 'NIY=F', triggered_at: 2, direction: 'up', detection_kind: 'slope', window_seconds: 60,
        change_percent: 0.3, price: 1000, session_date: null, session: null, ret5: -0.2, ret15: -0.3, ret30: 0,
        reference_kind: null, reference_price: null },
    ];
    const s = summarize(rows);
    const shortStat = s.find(x => x.label === '短期')!;
    expect(shortStat.count).toBe(2);
    expect(shortStat.hitRate).toBeCloseTo(0.5, 5);     // up: 順行ret15>=0.1 が1/2(継続)
    expect(shortStat.revertRate).toBeCloseTo(0.5, 5);  // 逆行 -0.3 が1/2(戻り)
    expect(shortStat.avgRet15).toBeCloseTo(0.1, 5);    // 順行平均 (0.5 + -0.3)/2
    db?.close?.();
  });

  it('down方向は順行正規化される(下げ継続=hit・順行+、上げ戻り=revert・順行−)', () => {
    const base = { symbol: 'NIY=F', triggered_at: 1, detection_kind: 'slope', window_seconds: 60,
      change_percent: 0.3, price: 1000, session_date: null, session: null,
      reference_kind: null, reference_price: null } as const;
    const rows: AlertRow[] = [
      { ...base, id: 1, direction: 'down', ret5: -0.5, ret15: -0.5, ret30: -0.5 },   // 下げ継続
      { ...base, id: 2, direction: 'down', ret5: 0.4, ret15: 0.4, ret30: 0.4 },       // 上げ戻り
    ];
    const st = summarize(rows).find(x => x.label === '短期')!;
    expect(st.hitRate).toBeCloseTo(0.5, 5);      // 下げ継続 1/2
    expect(st.revertRate).toBeCloseTo(0.5, 5);   // 戻り 1/2
    expect(st.avgRet15).toBeCloseTo(0.05, 5);    // favor: (+0.5 + -0.4)/2
  });
});
