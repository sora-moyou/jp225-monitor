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
export type DescribeFn = () => string;

// ─── 決済仕様の「名前付き変種」 ──────────────────────────────────────────────
//
// 分析用の提案生成器は「同じ相場に、現行の決済仕様を教えた AI と 候補の決済仕様を教えた AI」を
// 並走させて提案の差を測る。そのとき **決済の数値を HTTP リクエストに載せてはならない**
// (リクエスト・アクセスログ・エラーメッセージに実数値が乗りうる)。
// だから外から渡すのは **名前だけ** にし、名前 → 実数値の解決は monitor プロセス内の
// 非公開定義(./private.ts, gitignored)が行う。数値はプロセス内に留まる。
//
// ★このファイル(公開)には名前と型だけを置く。実数値は書かない。
//   - 'current'     … 実運用の現行仕様(既定)。
//   - 'candidate-a' … 分析用の候補。利益ロックの **第1段** だけを「発動 60pt / 床 25pt」に置き換え、
//                     それ以外の段は現行のまま。(この2値は候補として指定されたもので、現行値ではない)

export type ExitVariant = 'current' | 'candidate-a';

/** 受理する変種名の一覧(順序は説明表示用・normalize の真実)。 */
export const EXIT_VARIANTS: readonly ExitVariant[] = ['current', 'candidate-a'];

/** 省略時の変種。既存の呼び出し元は必ずこれ(=従来の挙動)。 */
export const DEFAULT_EXIT_VARIANT: ExitVariant = 'current';

export type NormalizeExitVariantResult =
  | { ok: true; variant: ExitVariant }
  | { ok: false; error: string };

/** 外部入力(HTTP body/query)を ExitVariant へ正規化する純関数。
 *  - 未指定 / null / 空文字 → 'current'(★省略時は現行。既存呼び出し元は byte 不変)
 *  - 既知の変種名 → そのまま
 *  - それ以外 → **エラー(400)**。
 *
 *  ★未知の値を黙って 'current' に倒さない理由: 生成器②が変種名を打ち間違えた時にそれを現行として
 *    処理すると、「候補仕様で生成した」つもりの標本が実は現行仕様で、A/B の差が消える。
 *    実験が壊れたことに誰も気づけない=最悪の壊れ方。だから **失敗は声を出す**。 */
export function normalizeExitVariant(v: unknown): NormalizeExitVariantResult {
  if (v === undefined || v === null || v === '') return { ok: true, variant: DEFAULT_EXIT_VARIANT };
  if (typeof v === 'string' && (EXIT_VARIANTS as readonly string[]).includes(v)) {
    return { ok: true, variant: v as ExitVariant };
  }
  const got = typeof v === 'string' ? v.slice(0, 32) : typeof v;
  return { ok: false, error: `exitVariant は ${EXIT_VARIANTS.map(n => `'${n}'`).join(' | ')} のみ(受信: ${got})` };
}

/** 変種ごとの説明文(公開フォールバック・数値なし)。private が在れば実数値つきに差し替わる。
 *  既定('current')は describeExitLogicSimple() と byte 一致させる(既存プロンプトを変えない)。 */
export function describeExitLogicVariantSimple(variant: ExitVariant): string {
  if (variant === DEFAULT_EXIT_VARIANT) return describeExitLogicSimple();
  return `${describeExitLogicSimple()}\n※この計画は決済仕様の変種 "${variant}" を前提とする(段階/数値は非公開ビルドでのみ注入される)。`;
}

export type DescribeVariantFn = (variant: ExitVariant) => string;

/** 簡易フォールバック(公開・決定論): 初期LC固定。含み益に関わらず逆指値は初期のまま(ラチェット無し)。 */
export function computeExitStopSimple(s: ExitState): number | null {
  return Number.isFinite(s.initialStop) ? s.initialStop : null;
}

/** 決済ロジックの説明(公開フォールバック・数値なし・定性)。private が在れば実数値つき説明に差し替わる。
 *  ★このファイル(公開)には決済の具体的な段階/数値を書かない。実数値は private の describeExitLogicPrivate から
 *  実行時に注入される(公開リポには載らない)。AI(scalp-plan)へ決済ロジックを渡すために使う。 */
export function describeExitLogicSimple(): string {
  return '決済は「フェーズ式・利益ロックのラチェット床」: 含み益ピークが伸びるほど決済逆指値(床)を段階的に有利側へ引き上げ、積み上げた利益を床でロックする。ラチェットは有利側にのみ動き、初期LCより不利にはしない。※具体的な段階/数値は非公開ビルドでのみ注入される。';
}

// ─── 分析用「影」の決済仕様の一覧 ────────────────────────────────────────────
//
// 影(shadow)= 同じ提案(AiPlan)に対して、決済パラメータだけを変えた模擬を並走させ、
// 「決済設定を変えていたら各エントリーがどうなったか」を1年かけて溜めるための記録専用の模擬。
//
// ★ここ(公開)には **名前と分類だけ** を置く。どの発動/床を振るかという実数値は非公開側
//   (./private.ts, gitignored)が持ち、cfg を **束ねた純関数** の形でだけ渡ってくる。
//   記録(DB)に載るのも name(不透明な識別子)であって数値ではない。
// ★グローバル差し替えは使わない: 各 spec の exit は呼び出しごとに自分の cfg を閉じ込めた純関数で、
//   モジュール変数を読み書きしない(影の模擬と実建玉の算出が干渉しない)。

/** 影の決済仕様の分類。**集計時に混ぜてはいけない区別** なので型で持つ。
 *  - 'ratchet'    … ラチェット床(保有中に自分で決める水準)の変更。実弾でも実現可能だった。
 *  - 'initial-lc' … 初期LCの変更。初期LCはブラケットの一部として **業者に送られている** ので、
 *                   変えた注文は一度も存在しなかった=実現不可能な反実仮想。 */
export type ShadowParamClass = 'ratchet' | 'initial-lc';

/** 影1本ぶんの決済仕様。 */
export interface ShadowExitSpec {
  /** 記録に載る識別子。**数値を含めない**(DB/ログに決済の実数値を出さないため)。 */
  name: string;
  paramClass: ShadowParamClass;
  /** その仕様での決済逆指値(絶対価格)。private が cfg を引数で束ねた純関数
   *  (= computeExitStopWith(cfg, s))。実運用の computeExitStop とは独立。 */
  exit: ExitFn;
}

/** 変種名 → その変種と **全域一致** する影 spec の名前(不透明な識別子のみ・数値は含まない)。
 *
 *  ★なぜ記録するか: 生成器②は「候補の決済仕様を教えた AI」の提案を作り、影ラダーは「候補の決済仕様で
 *    測った結末」を作る。この2つを突き合わせるには「候補 = どの spec か」が要る。人間が覚える運用だと
 *    格子や候補が動いた瞬間に黙って嘘になるので、**引き当てた結果を epoch と一緒に記録に残す**
 *    (1年後の分析者が対応を再導出しなくて済む)。 */
export type VariantSpecMap = Readonly<Record<ExitVariant, string>>;

/** 影の決済仕様の一覧 + その一覧自体の版(epoch)。epoch が変われば name↔実数値の対応も変わりうる
 *  =記録には必ず epoch を添える(後から「sh07 は何だったか」を取り違えないため)。 */
export interface ShadowExitLadder {
  epoch: string;
  specs: readonly ShadowExitSpec[];
  /** 変種 ↔ spec の対応(不透明名のみ)。**影が1本も無い公開フォールバックでは存在しない**ので任意。
   *  private が在るときは必ず入る(非公開側が全域一致で引き当てる)。 */
  variantSpecs?: VariantSpecMap;
}

/** 公開フォールバック: **影を1本も作らない**。
 *  ★空にする理由: 公開ビルドには床の実数値が無く、ここで適当な代用値を入れると
 *    「振ったつもりの記録が実は別物」という最悪の壊れ方(静かに無意味なデータが溜まる)になる。 */
export const EMPTY_SHADOW_LADDER: ShadowExitLadder = { epoch: 'none', specs: [] };

let shadowLadder: ShadowExitLadder = EMPTY_SHADOW_LADDER;

/** 影の決済仕様の一覧(private が読み込まれていれば実体、無ければ空)。 */
export function getShadowExitLadder(): ShadowExitLadder {
  return shadowLadder;
}

let impl: ExitFn = computeExitStopSimple;
let describeImpl: DescribeFn = describeExitLogicSimple;
let describeVariantImpl: DescribeVariantFn = describeExitLogicVariantSimple;
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
    const mod = await import('./private.js') as {
      computeExitStopPrivate?: ExitFn;
      describeExitLogicPrivate?: DescribeFn;
      describeExitLogicVariantPrivate?: DescribeVariantFn;
      shadowExitLadderPrivate?: () => ShadowExitLadder;
    };
    // 分析用「影」の決済仕様(名前と純関数だけ受け取る。数値はこちらへ来ない)。無ければ空のまま=影を作らない。
    // ★ここだけ独立した try で囲う理由: 非公開側は「変種と格子が食い違う」等の規約違反で **意図的に throw** する。
    //   外側の catch へ抜けると impl の差し替え(=実運用の決済)まで巻き添えで簡易版に落ちる。
    //   影(記録専用)の不具合が実弾につながる決済を変えてはならないので、影の失敗は影だけで閉じる。
    try {
      if (typeof mod.shadowExitLadderPrivate === 'function') {
        const l = mod.shadowExitLadderPrivate();
        if (l && Array.isArray(l.specs)) {
          shadowLadder = { epoch: String(l.epoch), specs: l.specs, variantSpecs: l.variantSpecs };
        }
      }
    } catch (e) {
      // 影は作らない(空のまま)。無音にはしない=記録が止まっていることが分かるように必ず出す。
      console.warn(`[shadow] 決済ラダーを読み込めませんでした(影の記録は行いません): ${e instanceof Error ? e.message : String(e)}`);
    }
    // 実数値つきの決済ロジック説明も private から取り込む(AI へ完全なロジックを渡すため)。無ければ定性版のまま。
    if (typeof mod.describeExitLogicPrivate === 'function') describeImpl = mod.describeExitLogicPrivate;
    // 変種ごとの説明文(名前 → 非公開の実数値)。無ければ公開フォールバック(数値なし)のまま。
    if (typeof mod.describeExitLogicVariantPrivate === 'function') describeVariantImpl = mod.describeExitLogicVariantPrivate;
    if (typeof mod.computeExitStopPrivate === 'function') {
      impl = mod.computeExitStopPrivate;
      return 'private';
    }
  } catch {
    // private 不在(公開配布)→ 簡易版で継続。
  }
  return 'simple';
}

/** 決済ロジックの説明文(private が読み込まれていれば実数値つきの完全版、無ければ定性フォールバック)。
 *  scalp-plan が AI へ「決済がどう動くか」を定数込みで渡すために使う。公開リポには数値は載らない。 */
export function describeExitLogic(): string {
  return describeImpl();
}

/** 指定した変種の決済ロジック説明文。名前だけを受け取り、実数値は非公開側が解決する
 *  (数値は HTTP/ログ/DB に出ない)。'current' は describeExitLogic() と **byte 一致** する
 *  =変種を指定しない既存経路のプロンプトは1バイトも変わらない。 */
export function describeExitLogicVariant(variant: ExitVariant): string {
  return describeVariantImpl(variant);
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
