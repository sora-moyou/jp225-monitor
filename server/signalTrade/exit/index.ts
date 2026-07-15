// トレードシグナルの「決済逆指値(resting stop)」算出の公開インターフェイス。
//
// エントリーは AI(scalp-plan)、決済はフェーズ式のラチェット床。ただし実運用の床ルール/数値は
// 非公開(./private.ts, gitignored)。private が在れば起動時に読み込んで差し替え、無ければ
// 簡易フォールバック(初期LC固定・ラチェット無し)で公開リポ単体でもビルド・動作する(劣化)。
//
// ★このファイル(公開)には決済の具体的な数値・段階ルールを書かない。

export interface ExitState {
  direction: 'buy' | 'sell';
  entryPrice: number;   // 建値(実約定価格)
  initialStop: number;  // 初期LC(絶対価格)。約定レッグの損切り逆指値。
  peakProfit: number;   // 含み益ピーク(pt, >=0)。ここまでに達した最大の含み益。
}

export type ExitFn = (s: ExitState) => number | null;

/** 簡易フォールバック(公開・決定論): 初期LC固定。含み益に関わらず逆指値は初期のまま(ラチェット無し)。 */
export function computeExitStopSimple(s: ExitState): number | null {
  return Number.isFinite(s.initialStop) ? s.initialStop : null;
}

let impl: ExitFn = computeExitStopSimple;
let loadAttempted = false;

/** 起動時に一度だけ ./private.js を optional dynamic import する。
 *  在れば computeExitStopPrivate に差し替え('private')、無ければ簡易版のまま('simple')。 */
export async function loadExitImpl(): Promise<'private' | 'simple'> {
  if (loadAttempted) return impl === computeExitStopSimple ? 'simple' : 'private';
  loadAttempted = true;
  try {
    // 公開リポには private.ts が無い(gitignored)。string リテラル指定子は esbuild が
    // 静的解決して private を同梱できる(署名ビルドの runtime を不変に保つ)ため残し、
    // private 不在の公開リポで tsc が TS2307 を出すのだけを @ts-ignore で抑止する。
    // ★@ts-expect-error は private 在時に「抑止対象なし(TS2578)」で落ちるので不可。@ts-ignore を使う。
    // @ts-ignore optional private module (absent in public repo)
    const mod = await import('./private.js') as { computeExitStopPrivate?: ExitFn };
    if (typeof mod.computeExitStopPrivate === 'function') {
      impl = mod.computeExitStopPrivate;
      return 'private';
    }
  } catch {
    // private 不在(公開配布)→ 簡易版で継続。
  }
  return 'simple';
}

/** 現在の決済逆指値(resting stop の絶対価格)を返す。private が読み込まれていればラチェット床、
 *  無ければ初期LC固定。null は「有効な逆指値なし」(初期LC が非有限などの異常時)。 */
export function computeExitStop(s: ExitState): number | null {
  return impl(s);
}

/** テスト用: 実装を明示的に差し替え/リセット(null で簡易版へ戻す)。公開テストは簡易版のみ検証する。 */
export function _setExitImpl(fn: ExitFn | null): void {
  impl = fn ?? computeExitStopSimple;
}
