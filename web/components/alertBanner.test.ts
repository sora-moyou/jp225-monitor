import { describe, it, expect } from 'vitest';
import { showKindTag, bannerKindLabel } from './alertBanner.js';
import { DETECTION_KINDS, isTechnicalKind, detectionKindLabel } from '../../core/detectionKinds.js';

// アラートバナーの種別表示。addBanner 本体は DOM 依存(jsdom 未導入)なので、
// 表示判断そのものを担う純関数 showKindTag / bannerKindLabel を検証する。
//
// ★実害(v0.9.36〜v0.9.48): バナー側だけ検知種別リストの手書きコピーが更新されず、
//   N波動(nwave)/日足バンド(dailyband)が「テクニカルでない」と判定されていた。結果、
//     - 種別タグが [トレンド] と誤表示される(N波動なのにトレンド転換に見える)
//     - LLM 説明を取りに行き、サーバ allowlist に弾かれて(HTTP 400)「説明取得失敗」になる
//   が同時に起きていた。v0.9.48 は server/web の別コピーだけを直し、ここを取りこぼした。

describe('バナーの種別タグ', () => {
  it('テクニカル(L2)種別はタグを出さない — 説明文「価格xxxで…」が種別を語るため', () => {
    for (const k of DETECTION_KINDS.filter(isTechnicalKind)) {
      expect(showKindTag(k), `${k} はテクニカルなのでタグ不要`).toBe(false);
    }
  });

  it('★N波動/日足バンドは「[トレンド]」と表示されない(v0.9.36 からの誤表示)', () => {
    expect(showKindTag('nwave')).toBe(false);
    expect(showKindTag('dailyband')).toBe(false);
    // 万一タグを出す設定に戻しても、文言は「トレンド」ではなく固有名になる。
    expect(bannerKindLabel('nwave')).toBe('N波動');
    expect(bannerKindLabel('dailyband')).toBe('日足バンド');
  });

  it('タグが出るのは暴落(crash)と旧仕様(magnitude)だけ — 急変/超短期は note で伝わるので出さない', () => {
    expect(DETECTION_KINDS.filter(showKindTag)).toEqual(['magnitude', 'crash']);
    expect(bannerKindLabel('crash')).toBe('暴落');       // ★以前は else に落ちて「トレンド」だった
    expect(bannerKindLabel('magnitude')).toBe('トレンド'); // 固有名を持たない旧 z-score 系
  });

  it('タグ文言は SSOT のラベルと一致する(バナー独自の言い換えを持たない)', () => {
    for (const k of DETECTION_KINDS) {
      const label = detectionKindLabel(k);
      if (label !== null) expect(bannerKindLabel(k)).toBe(label);
    }
  });

  it('未知の種別(古い localStorage 由来など)はタグ「トレンド」で表示だけはできる', () => {
    expect(showKindTag('someFutureKind')).toBe(true);
    expect(bannerKindLabel('someFutureKind')).toBe('トレンド');
  });
});
