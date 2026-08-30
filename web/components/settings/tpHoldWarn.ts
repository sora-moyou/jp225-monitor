// ★保有中に「手動TP幅」を変えたとき、何が起きるかを設定画面にその場で出す。
//
// ■ なぜ要るか(この画面だけ他の設定と性質が違う)
//   他の設定(初期LC下限・最大初期LC・目線 …)は **次のエントリーから** 効く。
//   手動TP幅だけは違う: 決済エンジンが毎tick この値を引き直すので、いま持っている建玉に
//   **次の値動きから** 効く。したがって、いまの含み益より小さい幅に変えると、
//   保存した直後にその建玉が成行で決済される。
//   ★押した本人が「保存しただけなのに決済された」と驚かないよう、その場で予告する。
//
// ■ 何をしない(ユーザー指示)
//   ・保存は一切止めない。警告を出すだけ。
//   ・保有していないときは何も出さない(枠ごと hidden)。
//   ・専門用語を使わない。「即座に決済されます」と分かる日本語で書く。

import type { KnobSource, SettingsElements } from './types.js';

/** 予告の材料になる建玉。SSE(SignalTradeState.position)の写し。
 *  ★unrealized は **1枚あたりの含み損益[円]**(server の unrealizedPt = 建値との差)。
 *    TP幅も1枚あたりの幅なので、この2つはそのまま比較してよい(枚数を掛けない)。 */
export interface TpHoldPosition {
  direction: 'buy' | 'sell';
  entryPrice: number;
  unrealized: number;
}

/** 予告を出すかどうかを決める入力。position=null は「保有していない」。 */
export interface TpWarnInput {
  enabled: boolean;               // TPを使う設定か(scalpTpEnabled)
  source: KnobSource;             // 幅の出所(scalpTpWidthSource)
  widthYen: number | null;        // 画面に入っている手動幅[円](空欄は null)
  position: TpHoldPosition | null;
}

/** 建玉の向きを日本語にする(専門用語を出さない)。 */
function dirLabel(d: 'buy' | 'sell'): string {
  return d === 'buy' ? '買い' : '売り';
}

/** 円の表示(整数・プラス記号つき)。 */
function yen(n: number): string {
  const v = Math.round(n);
  return `${v >= 0 ? '+' : ''}${v}円`;
}

/** ★予告の文言(純関数)。出さないときは '' を返す。
 *
 *  出す条件は **4つとも** 成立したときだけ:
 *   ① 保有している(position がある)      … 保有していなければ何も起きない
 *   ② TPを使う設定になっている            … 使わない設定なら幅を変えても効かない
 *   ③ 幅の出所が「手動」                  … AI委任なら画面の数値は使われない
 *   ④ 幅が正の有限値                      … 空欄/0/負は「幅なし」= 何も起きない
 *
 *  さらに、いまの含み益に **もう届いているか** で文言を変える:
 *   ・届いている → 「保存するとすぐに成行で決済されます」(いちばん驚くケース)
 *   ・まだ届いていない → 「あと何円で決済されるか」 */
export function tpHoldWarningText(input: TpWarnInput): string {
  const { enabled, source, widthYen, position } = input;
  if (!position) return '';
  if (!enabled) return '';
  if (source !== 'manual') return '';
  if (widthYen == null || !Number.isFinite(widthYen) || widthYen <= 0) return '';
  if (!Number.isFinite(position.unrealized) || !Number.isFinite(position.entryPrice)) return '';

  const head = `いま${dirLabel(position.direction)}の建玉を持っています`
    + `(建値 ${Math.round(position.entryPrice)} / いまの損益 ${yen(position.unrealized)})。`;
  const w = Math.round(widthYen);
  if (widthYen <= position.unrealized) {
    return head
      + `この幅(${w}円)には、もう届いています。`
      + `保存すると、この建玉は次に値段が動いた時点で、すぐに成行で決済されます。`;
  }
  const remain = Math.round(widthYen - position.unrealized);
  return head
    + `保存すると、この幅(${w}円)は次に値段が動いた時点から効きます`
    + `(いまの損益からあと ${remain}円 利益が伸びたところで、成行で決済されます)。`;
}

/** 予告を枠に描く。文言が空なら枠ごと隠す(保有していないときは何も出ない)。
 *  ★文字列は textContent で入れる(装飾もリンクも作らない)。 */
export function renderTpHoldWarning(el: HTMLElement | null | undefined, input: TpWarnInput): void {
  if (!el) return;
  const text = tpHoldWarningText(input);
  el.textContent = text;
  el.hidden = text === '';
}

/** いま画面に入っている TP の3項目を読む(予告の判定材料)。
 *  ★buildSavePayload と同じ読み方をする(空欄=null / 'manual' 以外は 'ai')。
 *    読み方が食い違うと「保存される値」と「予告した値」がずれる。 */
export function readTpWarnInput(el: SettingsElements, position: TpHoldPosition | null): TpWarnInput {
  const raw = el.inputScalpTpWidth.value.trim();
  return {
    enabled: el.checkScalpTpEnabled.checked,
    source: el.selectTpWidthMode.value === 'manual' ? 'manual' : 'ai',
    widthYen: raw === '' ? null : Number(raw),
    position,
  };
}

/** 画面の現在値 + 建玉から予告を描き直す(設定画面の配線が呼ぶ入口)。 */
export function syncTpHoldWarning(el: SettingsElements, position: TpHoldPosition | null): void {
  renderTpHoldWarning(el.tpHoldWarn, readTpWarnInput(el, position));
}

/** SSE の建玉状態から予告の材料を取り出す。保有中(phase='filled' かつ position あり)でなければ null。
 *  ★引数は web/components/signalPanel.ts の SignalTradeState をそのまま渡せる形にしてある
 *    (settings が signalPanel を import すると循環するので、必要な形だけを構造的に受ける)。 */
export function positionFromSignalState(
  s: { phase?: string; position?: { direction: 'buy' | 'sell'; entryPrice: number; unrealized: number } | null } | null | undefined,
): TpHoldPosition | null {
  if (!s || s.phase !== 'filled' || !s.position) return null;
  const p = s.position;
  return { direction: p.direction, entryPrice: p.entryPrice, unrealized: p.unrealized };
}
