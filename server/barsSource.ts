import type { DatabaseSync } from 'node:sqlite';
import { getRecentBars } from './db/store.js';
import { getRealtimeOHLCBars } from './feedBars.js';
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

/** DBの1分足とメモリ内ライブ足を合成し、t 昇順・ユニークな OHLC 配列にする純関数。
 *  同一 t の重複は(時刻の新旧は比較せず)常に次の規則で合成する:
 *   ・c = 常にメモリ(ライブ)側で上書き。DB は collector の書き込み遅延ぶん古くなりうるため。
 *   ・o = DB 優先。メモリ足はモニタ起動やフィード再接続で分の途中から始まりうる。
 *   ・h/l = 両者の和集合(h=max・l=min)。どちらの実レンジも捨てない(ATR 等が過小にならない)。
 *  メモリ側にしか無い t はそのまま採用する(feedBars が分内の高安を積んでいる)。 */
export function mergeBars(dbBars: OHLCBar[], memBars: OHLCBar[]): OHLCBar[] {
  const m = new Map<number, OHLCBar>();
  for (const b of dbBars ?? []) {
    if (!Number.isFinite(b?.t)) continue;
    m.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  for (const b of memBars ?? []) {
    if (!Number.isFinite(b?.t)) continue;
    if (!Number.isFinite(b.c) || b.c <= 0) continue;   // 不正値はライブ源側の欠測として無視
    const e = m.get(b.t);
    if (!e) { m.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }); continue; }
    e.c = b.c;                        // c は常にメモリ(ライブ)側
    if (b.h > e.h) e.h = b.h;         // h/l は和集合
    if (b.l < e.l) e.l = b.l;
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/** 窓(sinceT 以降)の1分足を DB + メモリ内ライブ足から集める。DB ハンドルが無い/読めない場合も
 *  メモリ足だけで返る(collector 未稼働環境でも指標/AI文脈が動く)。 */
export function collectRecentBars(db: DatabaseSync | null, symbol: string, sinceT: number): OHLCBar[] {
  let dbBars: OHLCBar[] = [];
  if (db) {
    try { dbBars = getRecentBars(db, symbol, sinceT) as unknown as OHLCBar[]; }
    catch { dbBars = []; }
  }
  const mem = getRealtimeOHLCBars(symbol).filter(b => b.t >= sinceT);
  return mergeBars(dbBars, mem);
}
