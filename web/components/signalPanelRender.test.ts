import { describe, it, expect } from 'vitest';

// ═══ ★2026-08-31: **描画関数を実際に通す** 1本 ═══════════════════════════════
//
// ■ なぜ要るか(エバリュエーターの発見・実測)
//   ★リポジトリの全テストのうち `renderSignalPanel` / `paintPanel` / `paintSections` を通るものは
//     **0件** だった。テストは全て純関数(buildSignalView / buildSignalSections)で止まっており、
//     「組み立てた文字列を **画面へ渡す配線**」は誰も踏んでいなかった。
//   ★この穴で実際に事故が出ている: TP の値は組み立てられていたのに描画側が描いておらず、
//     「TP が画面に出ない版」を出荷した(v0.9.105 で修正)。純関数のテストは全部緑のままだった。
//
// ■ ★このテストが引き受ける範囲(網羅はしない)
//   **「描画関数を通る道が在る」ことだけ** を固定する:
//     renderSignalPanel → paintPanel → paintSections → DOM のテキストに
//     ★メイン行(価格)と ★AI の理由 が載っていること。
//   ★スタイル・順序・クラス名の網羅はここでは見ない(純関数側のテストが持っている)。
//
// ■ ★依存は増やさない(jsdom を入れない)
//   paintPanel/paintSections が実際に触る API は5つだけ:
//     document.createElement / element.className / element.textContent /
//     element.appendChild / element.replaceChildren
//   renderSignalPanel はさらに localStorage(音のON/OFF)を読む。AudioContext は
//   soundPlayer 側が未初期化なら何もしないので不要。→ **最小のシムで足りる**。

/** 最小 DOM シム(上の5つの API だけ)。 */
class El {
  tagName = 'DIV';
  className = '';
  children: El[] = [];
  private text = '';
  set textContent(v: string) { this.text = v; this.children = []; }
  get textContent(): string {
    return this.children.length ? this.children.map(c => c.textContent).join('\n') : this.text;
  }
  appendChild(c: El): El { this.children.push(c); return c; }
  replaceChildren(...cs: El[]): void { this.children = cs; this.text = ''; }
}
(globalThis as unknown as { document: unknown }).document = { createElement: (): El => new El() };
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (): string => '0',            // 音は鳴らさない(beep は ctx 未初期化で no-op だが念のため)
  setItem: (): void => { /* noop */ },
};

const { renderSignalPanel } = await import('./signalPanel.js');

describe('★描画関数を通す(renderSignalPanel → paintPanel → paintSections)', () => {
  it('★実際に描いた DOM のテキストに、メイン行(価格)と AI の理由が載っている', () => {
    const el = new El();
    renderSignalPanel(el as never, {
      phase: 'armed', updatedAt: 0,
      signal: {
        at: 10, direction: 'buy', refPrice: 65_500, trendDir: 'up',
        limitEntry: 65_395, stopLossForLimit: 65_345, tpTriggerForLimit: 65_465,
        stopEntry: 65_620, stopLossForStop: 65_560,
        rationale: '上昇トレンド中、押し目を拾う', strategy: 'トレンド押し目・戻り',
        directionWhy: '直近安値を切り上げた',
        entryWhyForLimit: '直近安値の外側に置く', lcWhyForLimit: '節目の内側に戻る幅',
        entryWhyForStop: '65,615 を抜けたら追随。',
      },
    } as never);

    const painted = el.textContent;
    // ★① 描画そのものが起きた(空でない・枠のクラスが付いた)。
    expect(el.className).toContain('signal-armed');
    expect(painted.length).toBeGreaterThan(0);
    // ★② メイン行(価格・LC・TP)が DOM に載っている。★前に落としたのはここ(TP)。
    expect(painted).toContain('🎯 買い 65,395 指値 (LC 65,345) (TP 65,465)');
    expect(painted).toContain('🎯 買い 65,620 逆指値 (LC 65,560)');
    // ★③ AI の理由が DOM に載っている(欄の中身が捨てられていない)。
    expect(painted).toContain('直近安値の外側に置く ／ LC: 節目の内側に戻る幅。');
    expect(painted).toContain('65,615 を抜けたら追随。');
    expect(painted).toContain('直近安値を切り上げた');
    // ★④ 欄の見出しも通っている(目線/上/下)。
    for (const head of ['目線', '上', '下']) expect(painted).toContain(head);
    // ★⑤ 2026-08-31 の依頼: 脚の名札は **描画を通しても出ない**(記録のみ)。
    expect(painted).not.toContain('指値 押し目買い・順張り');
    expect(painted).not.toContain('逆指値 ブレイク新規・順張り');
  });
});
