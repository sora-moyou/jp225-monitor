// AI へ実際に送ったプロンプトの **指紋**(記録専用・純関数)。
//
// ■ なぜ要るか(実測で分かった穴)
//   計画サイクルの入力(足・節目・アラート・設定)を凍結してオフラインで再生する検証で、
//   「凍結した入力から組み立てた文脈が、その時刻に **実際に** AI へ渡ったものと同じか」を
//   突き合わせる手段が1つも無かった。プロンプトはどこにも残っていないので、サーバログの行を
//   時刻の真値の代わりに使うしかなく、誤差(秒オーダー)が残り、1件は1分足が隣にずれた。
//   → 送った本文そのものではなく **一方向の指紋** を1個だけ残せば、この突合は原理的に成立する。
//
// ■ ★本文は絶対に保存しない
//   system プロンプトには非公開の決済仕様(describeExitLogic 由来の実数値)が入る。記録は
//   同期フォルダ経由で機外へ出るので、DB にもログにも本文は1バイトも書かない。指紋だけ。
//   sha256 の先頭16桁は一方向で、本文の復元にも部分一致の推定にも使えない
//   (signal_trades.exit_cfg_hash と同じ粒度・同じ作法)。
//
// ■ ★指紋に何を含めたか(= 後から「同じ指紋なら同じ入力」と言える範囲)
//   含める:
//     ① system プロンプト全文 … 戦略仕様・委任状態・市場文脈・ニュース・技術ブロックの全部が入る
//     ② user プロンプト全文   … question / 画像の有無で変わる注記 / JSON 出力指示。
//        ★②を含める理由: 下限/上限/レンジ許可/LC 上限の提示は **①と②の両方** に印字される。
//        ①だけの指紋では「question 側だけが変わった版」を同じ指紋と誤認する。
//     ③ 範囲タグ(PROMPT_FP_SCOPE) … この定義自体が変わったことを後から見分けるための版。
//        ★①②の連結の仕方を変える/含めるものを増やすときは **必ずこのタグを上げる**
//          (上げないと、別の定義で取った古い指紋と新しい指紋が同じ土俵に乗ってしまう)。
//   含めない(意図的):
//     ・モデル名/プロバイダ名 … 指紋はプロバイダのフォールバックが起きる **前** に取る。
//       応答した実プロバイダを混ぜると、同じ入力から作った同じプロンプトが「誰が答えたか」で
//       違う指紋になり、"同じ入力 ⇒ 同じ指紋" という肝心の性質が壊れる。
//     ・チャート画像のバイト列 … 毎回別物なので混ぜると指紋が毎回ユニークになり無意味になる。
//       どの1枚を見たかは別途 chartShot(識別子・齢・由来)が記録する。
//     ・ツール定義(data tools / web_search)… 本文ではない。web_search の有無はキー設定に従う。
//
// ■ 突合の仕方(1年後の分析者へ)
//   再生側は凍結した入力から同じ関数でプロンプトを組み直し、この関数に食わせて突き合わせる。
//   プロンプト先頭の【市場の現状 …】は **秒** まで印字されるので、記録した文脈構築時刻から
//   数秒ぶんの候補を総当たりすれば、指紋が一致した候補が「実際に組み立てられた秒」になる
//   (= 指紋は突合の道具であると同時に、時刻の残差を潰す錨でもある)。

import { createHash } from 'node:crypto';

/** 指紋の定義の版タグ。**含める範囲を変えたら必ず上げる**(上の■を参照)。 */
export const PROMPT_FP_SCOPE = 'sp1';

/** 記録する hex の桁数(sha256 の先頭)。 */
export const PROMPT_FP_HEX_CHARS = 16;

/** system + user プロンプトの指紋(`sp1:<16桁hex>`)。**本文はどこにも出さない**。
 *  長さを前置してから本文を食わせる = 片方の末尾ともう片方の先頭がずれただけの
 *  2つの入力が同じ指紋にならない(境界の曖昧さを消す)。 */
export function promptFingerprint(systemPrompt: string, userPrompt: string): string {
  const h = createHash('sha256');
  h.update(`${PROMPT_FP_SCOPE}\n`, 'utf8');
  h.update(`${Buffer.byteLength(systemPrompt, 'utf8')}\n`, 'utf8');
  h.update(systemPrompt, 'utf8');
  h.update(`\n${Buffer.byteLength(userPrompt, 'utf8')}\n`, 'utf8');
  h.update(userPrompt, 'utf8');
  return `${PROMPT_FP_SCOPE}:${h.digest('hex').slice(0, PROMPT_FP_HEX_CHARS)}`;
}

/** 記録された値が指紋の形をしているか(台帳の検証・再生側の入口チェック用)。 */
export function isPromptFingerprint(v: unknown): v is string {
  return typeof v === 'string' && new RegExp(`^${PROMPT_FP_SCOPE}:[0-9a-f]{${PROMPT_FP_HEX_CHARS}}$`).test(v);
}

// ─── ★pb1: 「その版が持っているプロンプトの型」の指紋(sp1 とは別物・混ぜない) ───────────────
//
// ■ なぜ sp1 では版を識別できないか(★この誤解が実際に解析を誤らせた)
//   sp1 は **実際に送った全文** の指紋なので、refPrice・時刻(【市場の現状 …】は秒まで印字)・足・
//   ニュース・画像の有無で **呼び出しごとに変わる**。層別キーには使えない。
//   (上の説明どおり sp1 は「凍結入力からの再生が実際に渡ったものと一致するか」の突合の道具であって、
//    版の識別子ではない。ここを取り違えると、版の切り替わりを台帳から読めないまま解析することになる。)
//
// ■ pb1 が答える問い: 「この行を書いた版のプロンプトの **文面** は何だったか」
//   固定の合成コンテキストで組み立てたプロンプト(=データを一切含まない)のダイジェスト。
//     ・データ(現在値・時刻・足・ニュース・画像)が変わっても **動かない**
//     ・文面(テンプレート)が1文字でも変われば **必ず動く**
//     ・腕(質問文の変種)ごとに違う値になる(v1 と v1f は別の指紋)
//   ⇒ 「chore リリースでプロンプトは不変」と「プロンプトが変わった」を、版番号と独立に区別できる。
//
// ■ ★本文は絶対に入れない(sp1 と同じ規約)
//   合成コンテキストの組み立ては server/llm/promptBuild.ts が持ち、**非公開の決済仕様は固定の
//   プレースホルダに差し替えてから** 食わせる(=私的な数値はダイジェストに1バイトも入らない)。
export const PROMPT_BUILD_FP_SCOPE = 'pb1';

/** 固定合成プロンプトの断片列から「プロンプトの型」の指紋(`pb1:<16桁hex>`)を作る。★本文は出さない。
 *  各断片の **長さを前置** してから食わせる = ある断片の末尾と次の断片の先頭がずれただけの
 *  2つの入力が同じ指紋にならない(sp1 と同じ作法・境界の曖昧さを消す)。 */
export function promptBuildFingerprint(parts: readonly string[]): string {
  const h = createHash('sha256');
  h.update(PROMPT_BUILD_FP_SCOPE, 'utf8');
  h.update('\n', 'utf8');
  for (const part of parts) {
    h.update(String(Buffer.byteLength(part, 'utf8')), 'utf8');
    h.update('\n', 'utf8');
    h.update(part, 'utf8');
  }
  return `${PROMPT_BUILD_FP_SCOPE}:${h.digest('hex').slice(0, PROMPT_FP_HEX_CHARS)}`;
}

/** 記録された値が pb1 指紋の形をしているか(台帳の検証用)。 */
export function isPromptBuildFingerprint(v: unknown): v is string {
  return typeof v === 'string'
    && new RegExp(`^${PROMPT_BUILD_FP_SCOPE}:[0-9a-f]{${PROMPT_FP_HEX_CHARS}}$`).test(v);
}
