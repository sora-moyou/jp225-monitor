import { describe, it, expect } from 'vitest';
import { formatAlertLine } from './dataTools.js';
import { rowKind } from '../alertHistory.js';
import type { AlertRow } from '../db/store.js';
import { DETECTION_KINDS, isDirectionalKind } from '../../core/detectionKinds.js';

// ═══════════════════════════════════════════════════════════════════════════════════════
//  AI データツールのアラート行 — 「方向を持たない検知に方向を主張していた」欠陥
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// ★実害: alerts.direction は必須列なので、方向の概念が無い squeeze/bulge にも 'up' が入る
//   (server/detect/registry.ts が便宜上そう積む)。この行は
//     ① チャット system prompt の「■ 直近アラート(60分以内)」(buildMonitorContext)
//     ② ツール query_alerts の応答「直近アラート:」
//   の両方に入る = **AI が読んで売買方向の根拠にする文字列**。無条件に ▲ を付けていたので、
//   「スクイーズ 62,490 ▲」= バンド収縮に上向きの意味を足す無言の嘘を AI に渡していた。
//
// ★旧実装(git show HEAD:server/llm/dataTools.ts の 175-177 行 / 259-261 行 —— 2 箇所は同一)を
//   そのまま写したもの。方向を持つ種別では新実装がこれと **1バイトも変わらない** ことを固定する。
const legacyHhmm = (t: number): string =>
  new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const legacyAlertLine = (a: AlertRow): string => {
  const arrow = a.direction === 'up' ? '▲' : a.direction === 'down' ? '▼' : '';
  const price = a.price != null ? Math.round(a.price).toLocaleString('ja-JP') : '-';
  return `- ${legacyHhmm(a.triggered_at)} ${rowKind(a.detection_kind, a.window_seconds)} ${arrow} ${price}`;
};

const T = Date.UTC(2026, 7, 15, 1, 23, 0);   // 10:23 JST

function row(p: Partial<AlertRow> = {}): AlertRow {
  return {
    id: 1, symbol: 'NIY=F', triggered_at: T, direction: 'up',
    detection_kind: 'break', window_seconds: 300,
    change_percent: 0.5, price: 62_490,
    session_date: null, session: null,
    ret5: null, ret15: null, ret30: null,
    reference_kind: null, reference_price: null,
    ...p,
  };
}

describe('formatAlertLine(AI が読む直近アラート行)', () => {
  it('★不変: 方向を持つ全種別 × up/down で旧実装と byte 一致(他種別は1文字も変わらない)', () => {
    for (const k of DETECTION_KINDS.filter(isDirectionalKind)) {
      for (const d of ['up', 'down'] as const) {
        const r = row({ detection_kind: k, direction: d });
        expect(formatAlertLine(r), `${k}/${d}`).toBe(legacyAlertLine(r));
      }
    }
    // 代表例を実文字列でも固定(写しが壊れたら共倒れしないように)。
    expect(formatAlertLine(row({ detection_kind: 'break', direction: 'down', price: 67_470 })))
      .toBe('- 10:23 水準ブレイク ▼ 67,470');
    expect(formatAlertLine(row({ detection_kind: 'bandwalk', direction: 'up' })))
      .toBe('- 10:23 バンドウォーク ▲ 62,490');
  });

  it('★不変: 価格 null / direction が up|down でない記録も旧実装と byte 一致', () => {
    for (const r of [row({ price: null }), row({ direction: null }), row({ direction: 'flat' })]) {
      expect(formatAlertLine(r)).toBe(legacyAlertLine(r));
    }
    // direction が欠けた記録では旧実装が空矢印=空白2つを出す。方向あり種別なのでその挙動ごと維持。
    expect(formatAlertLine(row({ direction: null }))).toBe('- 10:23 水準ブレイク  62,490');
  });

  it('★スクイーズ/バルジは矢印を出さない(余分な空白も残さない) — 旧実装とは必ず異なる', () => {
    const sq = row({ detection_kind: 'squeeze', direction: 'up' });
    expect(formatAlertLine(sq)).toBe('- 10:23 スクイーズ 62,490');
    expect(formatAlertLine(sq)).not.toBe(legacyAlertLine(sq));   // 否定対照: 旧実装は '… ▲ …'
    expect(legacyAlertLine(sq)).toBe('- 10:23 スクイーズ ▲ 62,490');   // 直した中身(嘘の現物)

    // direction が何であっても方向は出さない(記録に 'down' が混じっても表示は不変)。
    expect(formatAlertLine(row({ detection_kind: 'bulge', direction: 'up' }))).toBe('- 10:23 バルジ 62,490');
    expect(formatAlertLine(row({ detection_kind: 'bulge', direction: 'down' }))).toBe('- 10:23 バルジ 62,490');
  });

  it('方向を持たない種別の行に方向記号が一切含まれない(網羅チェック)', () => {
    for (const k of DETECTION_KINDS.filter(k => !isDirectionalKind(k))) {
      for (const d of ['up', 'down'] as const) {
        const s = formatAlertLine(row({ detection_kind: k, direction: d }));
        expect(s, `${k}/${d}`).not.toMatch(/[▲▼]/);
        expect(s, `${k}/${d}: 空白が2つ並ばない`).not.toMatch(/ {2}/);
      }
    }
  });

  it('未知の種別(過去 DB の想定外文字列)は従来どおり方向ありで書く', () => {
    const r = row({ detection_kind: 'someFutureKind', direction: 'up' });
    expect(formatAlertLine(r)).toBe(legacyAlertLine(r));
    expect(formatAlertLine(r)).toContain('▲');
  });
});
