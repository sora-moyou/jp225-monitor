import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { showKindTag, bannerKindLabel, bannerArrow, bannerAlertClass } from './alertBanner.js';
import { DETECTION_KINDS, isTechnicalKind, isDirectionalKind, detectionKindLabel } from '../../core/detectionKinds.js';

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

// ═══════════════════════════════════════════════════════════════════════════════════════
//  バナーの方向記号 / 方向色 — 「方向を持たない検知に方向を主張していた」欠陥
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// ★実害: AlertEventPayload.direction は必須項目なので、方向の概念が無い squeeze/bulge にも 'up' が
//   入る(server/detect/registry.ts)。バナーはそれを無条件に ▲ + `.alert.up`(緑)にしていた。
//   「バンドが収縮した」に上向きの意味は無く、記号も色も無い方向の主張だった。
//
// ★旧実装(git show HEAD:web/components/alertBanner.ts の addBanner 内の2行をそのまま写したもの)。
//   方向を持つ種別では新しい純関数がこれと **1バイトも変わらない** ことをこの写しで固定する。
const legacyArrow = (direction: string): string => (direction === 'up' ? '▲' : '▼');
const legacyClass = (kind: string, direction: string): string =>
  `alert ${direction}${isTechnicalKind(kind) ? ' tech' : ''}`;

describe('バナーの方向記号/方向色', () => {
  it('★不変: 方向を持つ全種別 × up/down で旧実装と byte 一致(他種別の表示は1文字も変わらない)', () => {
    for (const k of DETECTION_KINDS.filter(isDirectionalKind)) {
      for (const d of ['up', 'down'] as const) {
        expect(bannerArrow(k, d), `${k}/${d}: 矢印`).toBe(legacyArrow(d));
        expect(bannerAlertClass(k, d), `${k}/${d}: class`).toBe(legacyClass(k, d));
      }
    }
    // 代表例を実文字列でも固定(写しが壊れたら共倒れしないように)。
    expect(bannerAlertClass('break', 'up')).toBe('alert up tech');    // L2 = tech 付き
    expect(bannerAlertClass('shock', 'down')).toBe('alert down');     // L1 = tech なし
    expect(bannerArrow('shock', 'down')).toBe('▼');
  });

  it('★スクイーズ/バルジは矢印を出さず、方向クラスも付けない', () => {
    for (const k of ['squeeze', 'bulge'] as const) {
      for (const d of ['up', 'down'] as const) {
        expect(bannerArrow(k, d), `${k}/${d}`).toBe('');
        // 否定対照: 旧実装は '▲'/'alert up tech' を返していた。
        expect(bannerArrow(k, d)).not.toBe(legacyArrow(d));
        expect(bannerAlertClass(k, d)).not.toBe(legacyClass(k, d));
        // 方向クラスは 'nodir'(中立色)。★ただ落とすと .alert 既定の赤=下げ色を主張してしまう。
        expect(bannerAlertClass(k, d), `${k}/${d}`).toBe('alert nodir tech');
      }
    }
  });

  it('方向を持たない種別のバナーに up/down クラスが混じらない(色の網羅チェック)', () => {
    for (const k of DETECTION_KINDS.filter(k => !isDirectionalKind(k))) {
      for (const d of ['up', 'down'] as const) {
        const cls = bannerAlertClass(k, d).split(' ');
        expect(cls, `${k}/${d}`).not.toContain('up');
        expect(cls, `${k}/${d}`).not.toContain('down');
        expect(cls, `${k}/${d}`).toContain('nodir');
      }
    }
  });

  it('未知の種別(古い localStorage 由来など)は従来どおり方向ありで描く', () => {
    expect(bannerArrow('someFutureKind', 'up')).toBe('▲');
    expect(bannerAlertClass('someFutureKind', 'down')).toBe('alert down');
  });

  // ★class を付けただけでは色は中立にならない: styles.css の .alert 既定は赤(=下げ)なので、
  //   .alert.nodir の上書きが無いと「方向色を消したつもりで下げ色を出す」無言の失敗になる。
  //   クラス名は CSS 側と手で揃える関係なので、実ファイルに規則が在ることを確かめる。
  it('.alert.nodir の中立色が styles.css に実在する(クラスだけ付いて赤のまま、を防ぐ)', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.alert\.nodir\s*\{/);
    expect(bannerAlertClass('squeeze', 'up').split(' ')).toContain('nodir');
  });
});
