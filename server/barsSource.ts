import type { DatabaseSync } from 'node:sqlite';
import { getRecentBars } from './db/store.js';
import { getRealtimeOHLCBars } from './feedBars.js';
import { isBaseBar } from '../core/barSource.js';
import type { OHLCBar } from './indicators.js';

// 「窓内の1分足」を DB とメモリ内ライブ足の両方から集める SSOT。
//
// 事故の経緯(v0.9.37 のテクニカル指標が永久に「蓄積中…」だった真因):
//   bars_1m へ「実行中に継続して」書くのは collector デーモン(collector/record.ts の recordTick)だけ。
//   モニタ本体も server/basedata.ts の upsertBar で bars_1m に書くが、それは起動時の基礎データ取込
//   (週次 xlsx 由来の過去分)であって、ライブの直近数時間を埋めるものではない。モニタ本体の
//   priceLoop は DB に書かず server/feedBars.ts のメモリ内足へ流している。
//   → 表示用のライブ機能(指標)を DB だけに繋いだため、collector 未稼働の環境では窓内0本になり、
//     何も計算されず無音だった。ライブ表示/AI 文脈は「DBの足 ∪ メモリ内のライブ足」を入力にする
//     (どちらか片方だけでも動く)。
//
// 純関数(mergeBars)と IO(collectRecentBars=DB読み+feedBars参照)を分け、合成規則を単体テストできるようにする。

/** DB から読んだ1分足(出所つき)。src は core/barSource.ts の値('base'/'live'/null=出所不明)。 */
export interface DbOHLCBar extends OHLCBar { src?: string | null }

/** 基礎データとライブが同じ分でこれ以上食い違ったら「どちらかが壊れている」とみなす閾値[円]。
 *
 *  ★実測で決めた値(2026-08-03〜08-13・同一分 10,392 本を突き合わせ)。基礎データとライブは同じ商品だが
 *    取得経路が違うため終値は普段からずれる: |差| の中央 5円 / p90 15円 / p99 40円 / p99.9 80円 / 最大 140円。
 *    10円だと 26.8%(4分に1回)、40円でも 1.2% の分が該当し、これは「壊れている」ではなく通常のサンプリング差。
 *    100円は観測全体の 0.04%(10,392分中4本 ≒ 2営業日に1回相当)で、平常のばらつきの外側にある。
 *    日付マッピングの取り違えや別商品の混入なら差は数百〜数千円になるので、この閾値で確実に捕まる。 */
export const BASE_LIVE_DIVERGENCE_WARN_YEN = 100;

/** 基礎データ足とライブ足が同じ分で食い違った量(最大の1件)。食い違いが無ければ null。 */
export interface MergeDivergence {
  /** 食い違いが最大だった分(epoch ms)。 */
  t: number;
  /** その分の基礎データ終値。 */
  baseC: number;
  /** その分のライブ終値。 */
  liveC: number;
  /** |ライブ − 基礎|[円]。 */
  diff: number;
  /** 基礎データ足とライブ足が両方あった分の本数(=突き合わせた母数)。 */
  overlap: number;
}

/** DBの1分足とメモリ内ライブ足を合成し、t 昇順・ユニークな OHLC 配列にする純関数。
 *
 *  ★出所の優先(v0.9.75): DB 側の行が **基礎データ(src='base')** なら、その分はメモリ内ライブ足で
 *    一切上書きしない(終値も高安も基礎データのまま)。基礎データは取引所の確定1分足で、ライブは
 *    約2秒間隔のポーリングを畳んだ近似(実測で高値は平均3.4円低く・安値は3.5円高い=レンジが狭い)。
 *    src が NULL(出所不明=この列より前に書かれた既存 DB の全行)や 'live' の行は **従来どおり** の
 *    合成規則のまま(挙動不変):
 *   ・c = 常にメモリ(ライブ)側で上書き。DB は collector の書き込み遅延ぶん古くなりうるため。
 *   ・o = DB 優先。メモリ足はモニタ起動やフィード再接続で分の途中から始まりうる。
 *   ・h/l = 両者の和集合(h=max・l=min)。どちらの実レンジも捨てない(ATR 等が過小にならない)。
 *  メモリ側にしか無い t はそのまま採用する(feedBars が分内の高安を積んでいる)。 */
export function mergeBars(dbBars: DbOHLCBar[], memBars: OHLCBar[]): OHLCBar[] {
  return mergeBarsWithDivergence(dbBars, memBars).bars;
}

/** mergeBars と同じ合成に加えて、基礎データとライブの食い違いを測って返す。
 *  ★警告は純関数の中では出さない(ログは IO)。呼び出し側(collectRecentBars)が閾値と回数を決める。 */
export function mergeBarsWithDivergence(
  dbBars: DbOHLCBar[], memBars: OHLCBar[],
): { bars: OHLCBar[]; divergence: MergeDivergence | null } {
  const m = new Map<number, OHLCBar>();
  const base = new Set<number>();          // 基礎データ由来の分(ライブで上書きしない)
  for (const b of dbBars ?? []) {
    if (!Number.isFinite(b?.t)) continue;
    m.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
    if (isBaseBar(b.src)) base.add(b.t); else base.delete(b.t);
  }
  let worst: MergeDivergence | null = null;
  let overlap = 0;
  for (const b of memBars ?? []) {
    if (!Number.isFinite(b?.t)) continue;
    if (!Number.isFinite(b.c) || b.c <= 0) continue;   // 不正値はライブ源側の欠測として無視
    const e = m.get(b.t);
    if (!e) { m.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }); continue; }
    if (base.has(b.t)) {
      // 基礎データ優先: 値は一切触らない。食い違いだけ測る(無音にしない)。
      overlap++;
      const diff = Math.abs(b.c - e.c);
      if (!worst || diff > worst.diff) worst = { t: b.t, baseC: e.c, liveC: b.c, diff, overlap: 0 };
      continue;
    }
    e.c = b.c;                        // c は常にメモリ(ライブ)側
    if (b.h > e.h) e.h = b.h;         // h/l は和集合
    if (b.l < e.l) e.l = b.l;
  }
  if (worst) worst.overlap = overlap;
  return { bars: [...m.values()].sort((a, b) => a.t - b.t), divergence: worst };
}

// 食い違い警告は「1回だけ」。毎分出すとログが埋まり、かえって読まれなくなる。
let divergenceWarned = false;

/** テスト用: 警告の「1回だけ」状態をリセットする。 */
export function _resetDivergenceWarning(): void { divergenceWarned = false; }

/** 窓(sinceT 以降)の1分足を DB + メモリ内ライブ足から集める。DB ハンドルが無い/読めない場合も
 *  メモリ足だけで返る(collector 未稼働環境でも指標/AI文脈が動く)。 */
export function collectRecentBars(db: DatabaseSync | null, symbol: string, sinceT: number): OHLCBar[] {
  let dbBars: DbOHLCBar[] = [];
  if (db) {
    try { dbBars = getRecentBars(db, symbol, sinceT) as unknown as DbOHLCBar[]; }
    catch { dbBars = []; }
  }
  const mem = getRealtimeOHLCBars(symbol).filter(b => b.t >= sinceT);
  const { bars, divergence } = mergeBarsWithDivergence(dbBars, mem);
  // ★無音にしない: 同じ商品の同じ分なのに大きくずれているなら、どちらかのデータが壊れている合図。
  //   キーやパスは出さない(このログは同期フォルダ経由で機外に出ることがある)。
  if (!divergenceWarned && divergence && divergence.diff >= BASE_LIVE_DIVERGENCE_WARN_YEN) {
    divergenceWarned = true;
    console.warn(`[barsSource] WARN: 基礎データとライブ足が同じ分で ${divergence.diff} 円 食い違っています`
      + `(基礎 ${divergence.baseC} / ライブ ${divergence.liveC} / ${new Date(divergence.t).toISOString()} `
      + `/ 突き合わせ ${divergence.overlap} 本)。基礎データを優先して計算していますが、どちらかのデータが`
      + `壊れている可能性があります(この警告は起動中1回だけ出します)。`);
  }
  return bars;
}
