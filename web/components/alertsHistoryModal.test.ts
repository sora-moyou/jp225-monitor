import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirCell } from './alertsHistoryModal.js';
import { DETECTION_KINDS, isDirectionalKind } from '../../core/detectionKinds.js';

// ═══════════════════════════════════════════════════════════════════════════════════════
//  履歴モーダル「方向」列 — 方向を持たない検知に方向を主張していた欠陥
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// ★実害: alerts.direction は必須列なので、方向の概念が無い squeeze/bulge にも 'up' が入る
//   (server/detect/registry.ts が便宜上そう積む)。履歴表はそれを無条件に ▲ + `.up`(緑)にしていた。
//   BB幅の収縮に上向きの意味は無く、記号も色も無い方向の主張だった(的中率の方向内訳も同様に無意味)。
//
// ★旧実装(git show HEAD:web/components/alertsHistoryModal.ts の 39 行目の方向セル部分をそのまま
//   写したもの)。方向を持つ種別では新実装がこれと **1バイトも変わらない** ことをこの写しで固定する。
const legacyDirCell = (direction: string): string =>
  `<td class="${direction === 'up' ? 'up' : 'down'}">${direction === 'up' ? '▲' : '▼'}</td>`;

const row = (detection_kind: string | null, direction: 'up' | 'down') => ({ detection_kind, direction });

describe('履歴モーダルの方向セル', () => {
  it('★不変: 方向を持つ全種別 × up/down で旧実装と byte 一致(他種別の表示は1文字も変わらない)', () => {
    for (const k of DETECTION_KINDS.filter(isDirectionalKind)) {
      for (const d of ['up', 'down'] as const) {
        expect(dirCell(row(k, d)), `${k}/${d}`).toBe(legacyDirCell(d));
      }
    }
    // 代表例を実文字列でも固定(写しが壊れたら共倒れしないように)。
    expect(dirCell(row('break', 'up'))).toBe('<td class="up">▲</td>');
    expect(dirCell(row('shock', 'down'))).toBe('<td class="down">▼</td>');
  });

  it('★スクイーズ/バルジは矢印も色クラスも付けない(欠測表記「—」)', () => {
    for (const k of ['squeeze', 'bulge'] as const) {
      for (const d of ['up', 'down'] as const) {
        expect(dirCell(row(k, d)), `${k}/${d}`).toBe('<td>—</td>');
        expect(dirCell(row(k, d))).not.toBe(legacyDirCell(d));   // 否定対照: 旧実装は ▲ + .up
      }
    }
  });

  it('方向を持たない種別のセルに矢印・up/down クラスが混じらない(網羅チェック)', () => {
    for (const k of DETECTION_KINDS.filter(k => !isDirectionalKind(k))) {
      for (const d of ['up', 'down'] as const) {
        const html = dirCell(row(k, d));
        expect(html, `${k}/${d}`).not.toMatch(/[▲▼]/);
        expect(html, `${k}/${d}`).not.toMatch(/class="(up|down)"/);
      }
    }
  });

  it('未知の種別 / detection_kind 欠落(古い応答)は従来どおり方向ありで描く', () => {
    expect(dirCell(row('someFutureKind', 'up'))).toBe(legacyDirCell('up'));
    expect(dirCell(row(null, 'down'))).toBe(legacyDirCell('down'));
  });

  // ★class を落とすだけで中立になるのはこの表の CSS 事情に依存する。バナー(.alert)は既定が赤なので
  //   同じ手は使えなかった(そちらは .nodir を足してある)。前提が消えたら気づけるように実 CSS を見る。
  it('.ah-table td は色クラスを付けたときだけ色が付く(既定色を持たない)', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.ah-table td\.up \{ color/);
    expect(css).toMatch(/\.ah-table td\.down \{ color/);
    // .ah-table th, .ah-table td の共通規則に color 指定が無いこと(あると「無色」が別の色になる)。
    const shared = css.match(/\.ah-table th, \.ah-table td \{[^}]*\}/)?.[0] ?? '';
    expect(shared).not.toMatch(/(^|[^-])color:/);
  });
});
