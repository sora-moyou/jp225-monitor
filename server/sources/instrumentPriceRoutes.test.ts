import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Price, Symbol } from '../types.js';
import { INSTRUMENTS } from '../../core/instruments.js';
import { INSTRUMENT_KEYWORDS } from '../config.js';
import { AJAX_CME_CODE_SYMBOL, fetchAjaxCmePrices } from './ajaxCmePrice.js';
import { AJAX_FX_CODE_SYMBOL, fetchAjaxFxPrices } from './ajaxFxPrice.js';

// ─────────────────────────────────────────────────────────────────────────────
// 「宣言はあるのに、取りに行くコードが無い」を二度と作らないための番人。
//
// 事故(2026-06〜07): v0.7.18/0.7.19 で価格経路を公開 HTTP 2本に統一したとき、値がさ株7の取得経路
// (旧 Yahoo)だけが理由の記載なく消え、core/instruments.ts の INSTRUMENTS に**宣言だけ**が残った。
// 画面にもログにも何も出ないまま **2026-07-07 の大引け(15:30 JST)** を最後に無言で欠測し、
// 1か月以上気づけなかった。★この日付は **稼働機**(Documents/trade/prices_kabu.db)の実測。
// 開発機の %APPDATA% の DB は 2026-06-19 止まりだがそれは monitor を動かしていないだけ。詳細は
// core/instruments.ts の冒頭コメント(日付を直すときは必ず稼働機の DB で測ること)。
//
// この番人が赤にするもの:
//   ・銘柄を INSTRUMENTS に足したのに、取得経路を足し忘れた           → unrouted
//   ・取得経路を消したのに、INSTRUMENTS の宣言を消し忘れた(今回の形) → unrouted
//   ・取得経路にあるのに、INSTRUMENTS に宣言が無い                    → orphaned
//   ・2 つのコードが同じ銘柄を指し、銘柄数が水増しされている          → 生カウントの不一致
//
// ★恒真にしないための設計(ここが肝):
//   ①「期待値」を手で書き写さない。左辺は INSTRUMENTS、右辺は **実際に取得コードを走らせて返ってきた
//      symbol**。どちらも唯一の実体から導出するので、銘柄名がこのファイルに複製されない
//      (複製した瞬間に腐る = 写した表は必ず本体とズレる)。
//   ② 右辺を「経路テーブルを読むだけ」で作らない。fetch をスタブして **本物の fetchAjaxCmePrices() /
//      fetchAjaxFxPrices() を引数なし(=本番の既定)で呼ぶ**(本番 priceLoop / collector が呼ぶのと
//      同じ入口・同じ既定)。パース・コード解決・URL 組み立てまで本物が走る。
//   ③ 否定対照(下の describe)で、この検査が実際に落ちることを **実行して** 示す。
//      「宣言したものが当たる」形の検査は放っておくと恒真になるので、恒真でないことを常設で証明する。
//
// ★★この番人にできないこと(オフラインである以上の構造的限界。「塞いだ」と書かないこと):
//   限界F: 合成応答 BODY は **経路表そのもの** から作っている。したがってここで証明できるのは
//          「INSTRUMENTS ≡ 経路表(を本物のコードで走らせた結果)」までで、
//          **「≡ 上流(ajax_cme.js/ajax_fx.js)が実際に配信しているもの」ではない**。
//          例: 実在しないコード '12345' を経路表に書き、対応する銘柄を INSTRUMENTS にも足すと、
//          この番人は **緑のまま通る**(本番では取得できないのに)。上流との一致はネットワークに
//          出ないと確かめられないので、ここでは検出しない。実配信の確認は運用側の責務。
//   限界G(→ 直した): 2 つのコードが同じ銘柄にマップされる水増しは、Set で潰してから数えると
//          検出できなかった。dedupe 前の **生カウント** で比べるようにして検出できるようにした
//          (否定対照 ⑤)。
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => { vi.unstubAllGlobals(); });

type CodeSymbols = ReadonlyArray<readonly [string, Symbol]>;

/**
 * 価格の取得経路(本番の入口)の一覧。**ここが増えたら本番も増えている**という対応を保つ。
 * fetchAll は引数なしで呼ぶ = それぞれのモジュールが持つ既定のコード表(本番と同じ)が使われる。
 */
const PRICE_ROUTES = [
  { endpoint: 'ajax_cme.js', codeSymbols: AJAX_CME_CODE_SYMBOL, fetchAll: fetchAjaxCmePrices },
  { endpoint: 'ajax_fx.js', codeSymbols: AJAX_FX_CODE_SYMBOL, fetchAll: fetchAjaxFxPrices },
] as const satisfies ReadonlyArray<{
  endpoint: string;
  codeSymbols: CodeSymbols;
  fetchAll: (codeSymbols?: CodeSymbols) => Promise<Price[]>;
}>;

/** 否定対照でだけ使う予備コード。実在の経路表には無いので、本番の検査には一切影響しない。 */
const SPARE_CODE = '99999';

/** 上流フィードが「全コードを配信している」状態の合成応答。実際の行形式に合わせる。 */
function ajaxBody(codes: readonly string[]): string {
  return codes
    .map((c, i) => `A[${c}]="${10000 + i}.00_+1.00_+0.10_09:00_1_${10001 + i}.00_${9999 + i}.00";`)
    .join('\n');
}

const ALL_CODES = [...PRICE_ROUTES.flatMap(r => r.codeSymbols.map(([code]) => code)), SPARE_CODE];
const BODY = ajaxBody(ALL_CODES);

/** 取得コードを実際に走らせ、返ってきた symbol と、叩いた URL を集める(ネットワークはスタブ)。
 *  ★raw は **dedupe 前** の生の並び。ここを潰してから数えると「2 コードが同じ銘柄を指す」水増しを
 *    見逃す(限界G の実測)。symbols(一意)と raw(生)の両方を返し、数の検査は raw で行う。 */
async function runRoutes(
  runs: ReadonlyArray<() => Promise<Price[]>>,
): Promise<{ symbols: string[]; raw: string[]; urls: string[] }> {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    urls.push(String(url));
    return { ok: true, status: 200, text: async () => BODY };
  }));
  const raw: string[] = [];
  for (const run of runs) {
    for (const p of await run()) raw.push(p.symbol);
  }
  return { symbols: [...new Set(raw)], raw, urls };
}

/** 本番の既定どおり(引数なし)に全経路を走らせる。 */
const defaultRuns = () => PRICE_ROUTES.map(r => () => r.fetchAll());

/**
 * 宣言(declared)と実際に取れたもの(routed)のズレ。両方向を見る純関数。
 *   unrouted = 宣言はあるが取れない ← 今回の事故の形
 *   orphaned = 取れるが宣言が無い
 */
export function diffCoverage(
  declared: readonly string[],
  routed: readonly string[],
): { unrouted: string[]; orphaned: string[] } {
  const routedSet = new Set(routed);
  const declaredSet = new Set(declared);
  return {
    unrouted: declared.filter(s => !routedSet.has(s)),
    orphaned: routed.filter(s => !declaredSet.has(s)),
  };
}

const DECLARED = INSTRUMENTS.map(i => i.symbol as string);

describe('INSTRUMENTS の宣言と価格取得経路の一致(番人)', () => {
  it('宣言した全銘柄が、実際に取得コードを走らせて返ってくる(取り違え・取り残しゼロ)', async () => {
    const { symbols } = await runRoutes(defaultRuns());
    expect(diffCoverage(DECLARED, symbols)).toEqual({ unrouted: [], orphaned: [] });
  });

  it('経路は「表があるだけ」ではなく実際に HTTP GET を撃っている', async () => {
    const { urls } = await runRoutes(defaultRuns());
    for (const route of PRICE_ROUTES) {
      expect(urls.some(u => u.includes(route.endpoint))).toBe(true);
    }
  });

  it('宣言の数と取得できる銘柄の数が一致する(重複マッピングで水増しされていない)', async () => {
    const { raw } = await runRoutes(defaultRuns());
    // ★dedupe 前の生カウントで比べる。Set で潰してから数えると、2 コードが同じ銘柄を指していても
    //   一意集合は変わらないので気づけない(限界G)。生で数えれば 1 銘柄 1 経路が保証される。
    expect(raw.length).toBe(DECLARED.length);
    expect(new Set(raw).size).toBe(raw.length);             // 取得側に重複が無いこと
    expect(new Set(DECLARED).size).toBe(DECLARED.length);   // 宣言側に重複が無いこと
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 否定対照: 上の検査が恒真でないことの実証。**壊し方を実際に作って、赤になることを見る**。
// ここが緑のままなら、上の検査は「何も見ていない」ということになる。
// ─────────────────────────────────────────────────────────────────────────────
describe('否定対照(この番人が恒真でないことの実証)', () => {
  it('① 銘柄を足して取得経路を足し忘れると unrouted に出る', async () => {
    const { symbols } = await runRoutes(defaultRuns());
    const declaredPlusGhost = [...DECLARED, 'GHOST=X'];
    const diff = diffCoverage(declaredPlusGhost, symbols);
    expect(diff.unrouted).toEqual(['GHOST=X']);
    // 本検査と同じ形で書くと、確かに落ちる:
    expect(() => expect(diff).toEqual({ unrouted: [], orphaned: [] })).toThrow();
  });

  it('② 取得経路を1つ外すと(本物の fetch コードを走らせて)その銘柄が unrouted に出る', async () => {
    // 経路表から NIY=F(code 136)の対応だけを抜いた状態で、**本物の** fetchAjaxCmePrices を走らせる。
    // = v0.7.18/0.7.19 で値がさ株に起きたのと同じ「取りに行くコードが消えた」状況の再現。
    const crippled = AJAX_CME_CODE_SYMBOL.filter(([, sym]) => sym !== 'NIY=F');
    const { symbols } = await runRoutes([
      () => fetchAjaxCmePrices(crippled),
      () => fetchAjaxFxPrices(),
    ]);
    const diff = diffCoverage(DECLARED, symbols);
    expect(diff.unrouted).toEqual(['NIY=F']);
    expect(() => expect(diff).toEqual({ unrouted: [], orphaned: [] })).toThrow();
  });

  it('③ 経路だけあって宣言が無い銘柄は orphaned に出る', async () => {
    const extra: CodeSymbols = [...AJAX_CME_CODE_SYMBOL, [SPARE_CODE, 'GHOST=X' as Symbol]];
    const { symbols } = await runRoutes([
      () => fetchAjaxCmePrices(extra),
      () => fetchAjaxFxPrices(),
    ]);
    const diff = diffCoverage(DECLARED, symbols);
    expect(diff.orphaned).toEqual(['GHOST=X']);
    expect(() => expect(diff).toEqual({ unrouted: [], orphaned: [] })).toThrow();
  });

  it('④ 経路が全滅(上流が空)なら全銘柄が unrouted に出る(無言で緑にならない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })));
    const symbols: string[] = [];
    for (const route of PRICE_ROUTES) for (const p of await route.fetchAll()) symbols.push(p.symbol);
    expect(diffCoverage(DECLARED, symbols).unrouted).toEqual(DECLARED);
  });

  it('⑤ 2 つのコードが同じ銘柄を指す水増しは、生カウントで赤になる(限界G の修正の実証)', async () => {
    // 予備コードを **既存銘柄** NIY=F に二重マップする。集合としては何も増えないので
    // unrouted/orphaned は空のまま = 一致検査だけでは気づけない。生カウントなら気づく。
    const dup: CodeSymbols = [...AJAX_CME_CODE_SYMBOL, [SPARE_CODE, 'NIY=F']];
    const { symbols, raw } = await runRoutes([
      () => fetchAjaxCmePrices(dup),
      () => fetchAjaxFxPrices(),
    ]);
    // 集合ベースの検査は素通りしてしまう(=これが限界G だった):
    expect(diffCoverage(DECLARED, symbols)).toEqual({ unrouted: [], orphaned: [] });
    // 生カウントなら水増しを捉える:
    expect(raw.length).toBe(DECLARED.length + 1);
    expect(() => expect(raw.length).toBe(DECLARED.length)).toThrow();
    expect(new Set(raw).size).not.toBe(raw.length);
  });

  it('⑥ 限界F の明示: 上流に無い架空コードを経路表と宣言の両方に足すと、この番人は緑のまま通る', async () => {
    // BODY は経路表から作られるので、架空コードでも「配信されている」ことになってしまう。
    // = ここで証明できるのは「INSTRUMENTS ≡ 経路表」までで、上流の実配信とは一致を主張できない。
    // この事実を **テストとして固定** しておく(将来ここが赤くなったら、番人が上流も見るようになった証拠)。
    const ghostRoutes: CodeSymbols = [...AJAX_CME_CODE_SYMBOL, [SPARE_CODE, 'GHOST=X' as Symbol]];
    const { symbols } = await runRoutes([
      () => fetchAjaxCmePrices(ghostRoutes),
      () => fetchAjaxFxPrices(),
    ]);
    const declaredPlusGhost = [...DECLARED, 'GHOST=X'];
    expect(diffCoverage(declaredPlusGhost, symbols)).toEqual({ unrouted: [], orphaned: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 同じ腐り方をするもう1つの表: 銘柄別ニュースキーワード辞書。
// explain.ts が INSTRUMENT_KEYWORDS[アラートの symbol] で引くだけなので、INSTRUMENTS から
// 消えた銘柄の項目は「使われているつもり」のまま残る(実際、値がさ株7の項目がそうなっていた)。
// ─────────────────────────────────────────────────────────────────────────────
describe('INSTRUMENT_KEYWORDS のキーと INSTRUMENTS の一致', () => {
  it('全銘柄に辞書があり、宣言に無い銘柄の辞書は残っていない', () => {
    expect(diffCoverage(DECLARED, Object.keys(INSTRUMENT_KEYWORDS)))
      .toEqual({ unrouted: [], orphaned: [] });
  });

  it('否定対照: 宣言に無いキーを足すと orphaned に出る', () => {
    const keys = [...Object.keys(INSTRUMENT_KEYWORDS), 'GHOST=X'];
    expect(diffCoverage(DECLARED, keys).orphaned).toEqual(['GHOST=X']);
  });
});
