import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getMeta } from './store.js';
import {
  PRICE_FEED_HEARTBEAT_KEY, PRICE_FEED_STATUS_KEY, PRICE_FEED_HEARTBEAT_FRESH_MS,
  NIY_STALE_ALARM_MS, NiyStaleWatch,
  buildPriceFeedHeartbeat, formatPriceFeedStatus, writePriceFeedHeartbeat,
  readPriceFeedHeartbeat, describePriceFeed,
  publishPriceFeedHeartbeat, priceFeedApiState, resetPublishedPriceFeedHeartbeat,
} from './priceFeedHeartbeat.js';
import type { Price } from '../types.js';
import type { FeedFreezeState } from '../sources/ajaxCmePrice.js';

// ★このテストが守る契約(価格フィードの**常時**健全性指標・RECORD-ONLY):
//   ① 「提供元の時計が凍結した」が **1行** で分かる(2026-09-06 の事故の片側)。
//   ② ★「立会中なのに NIY=F が来ない」が異常として出る(2026-09-06 の損害の**本体**。
//      731/737 が生きたまま 136 だけ止まる形は、時計の凍結検知では捕まらない)。
//   ③ 清算中(全銘柄 liveFlag=0)・取引時間外は **正常**として区別する(週末に赤くすると指標が死ぬ)。
//   ④ 取得失敗と凍結を混同しない(旧ログはここを混同して読み手を誤誘導した)。
//   ⑤ 状態は共有DB(jp225.db)の meta に載る = 既存の VACUUM INTO 書き出しにそのまま乗る。
//   ⑥ ハートビート自体が止まったら読み手が `at` の古さで検出する(OK のまま凍らせない)。
//   ⑦ ★判定はこのモジュールだけが行う(画面は state/reason を表示するだけ)。

const JST = 9 * 60 * 60_000;
const jst = (y: number, m: number, d: number, hh: number, mm: number): number =>
  Date.UTC(y, m - 1, d, hh, mm, 0) - JST;

// 2026-09-08(火)。10:00 = 日中立会中 / 16:20 = 引け後の空白帯(取引時間外)。
const IN_SESSION = jst(2026, 9, 8, 10, 0);
const OFF_HOURS = jst(2026, 9, 8, 16, 20);

function px(symbol: Price['symbol'], price: number, stale: boolean): Price {
  return { symbol, price, changePercent: 0, timestamp: IN_SESSION, stale };
}
const feed = (clock: string | null, frozen: boolean, frozenMs: number): FeedFreezeState =>
  ({ clock, frozen, frozenMs });
const OK_FEED = feed('10:00', false, 20_000);

function sharedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}

describe('NiyStaleWatch — ★立会中に NIY=F が来ない(損害の本体)', () => {
  const live = [px('NIY=F', 65190, false), px('YM=F', 53001.9, false)];
  const niyDead = [px('NIY=F', 65190, true), px('YM=F', 53001.9, false)];   // 136 だけ liveFlag=0

  it('立会中に NIY=F が来ていれば常に正常', () => {
    const w = new NiyStaleWatch();
    expect(w.observe(live, IN_SESSION)).toEqual({ staleMs: 0, alarm: false });
    expect(w.observe(live, IN_SESSION + 600_000)).toEqual({ staleMs: 0, alarm: false });
  });

  it('★立会中に NIY=F が stale のまま 3 分を超えたら alarm', () => {
    const w = new NiyStaleWatch();
    w.observe(niyDead, IN_SESSION);
    expect(w.observe(niyDead, IN_SESSION + NIY_STALE_ALARM_MS).alarm).toBe(false);
    expect(w.observe(niyDead, IN_SESSION + NIY_STALE_ALARM_MS + 1).alarm).toBe(true);
  });

  it('NIY=F の行が丸ごと無い(パース不能)も「来ていない」として数える', () => {
    const w = new NiyStaleWatch();
    w.observe([px('YM=F', 53001.9, false)], IN_SESSION);
    expect(w.observe([px('YM=F', 53001.9, false)], IN_SESSION + 600_000).alarm).toBe(true);
  });

  it('★立会外は数えない(引け後・夜間の stale は正常)', () => {
    const w = new NiyStaleWatch();
    expect(w.observe(niyDead, OFF_HOURS)).toEqual({ staleMs: null, alarm: false });
    expect(w.observe(niyDead, OFF_HOURS + 600_000)).toEqual({ staleMs: null, alarm: false });
  });

  // ★★この番人が **効いていること** を、変異で確かめられる形にしてある(2026-09-08 の指摘)。
  //   前の版はここで 15:46 → 15:56 を見ていたが、15:56 は inPollWindow も false なので
  //   `classifySession` を `!inPollWindow` に変異させても緑のまま = 宣言を検証していなかった。
  //   ★判定が分かれるのは **窓内(inPollWindow=true)かつ立会外(classifySession=null)** の帯、
  //     つまり引け 15:45 〜 15:55 の 10 分間 **だけ**。そこを閾値超えで踏むこと。
  it('★引け直後(15:45–15:55 = inPollWindow の後マージン)で誤報しない = classifySession で判定している', () => {
    const w = new NiyStaleWatch();
    const justClosed = jst(2026, 9, 8, 15, 46);   // 立会は終わっているが inPollWindow はまだ true
    w.observe(niyDead, justClosed);
    // 15:49:01 = 窓内・立会外・3分閾値超え。inPollWindow で判定していたらここで alarm=true になる。
    expect(w.observe(niyDead, justClosed + NIY_STALE_ALARM_MS + 1000).alarm).toBe(false);
  });

  it('引けの後マージンを抜けた後(15:56)も当然に誤報しない', () => {
    const w = new NiyStaleWatch();
    const justClosed = jst(2026, 9, 8, 15, 46);
    w.observe(niyDead, justClosed);
    expect(w.observe(niyDead, justClosed + 600_000).alarm).toBe(false);
  });

  it('一度復帰したら数え直す / reset() で初期状態に戻る', () => {
    const w = new NiyStaleWatch();
    w.observe(niyDead, IN_SESSION);
    w.observe(live, IN_SESSION + 200_000);                       // 復帰
    expect(w.observe(niyDead, IN_SESSION + 260_000).alarm).toBe(false);   // 数え直し
    w.reset();
    expect(w.state).toEqual({ staleMs: null, alarm: false });
  });
});

describe('buildPriceFeedHeartbeat — 状態を区別する', () => {
  it('新鮮(時計が進んでいる)= ok', () => {
    const hb = buildPriceFeedHeartbeat({
      now: IN_SESSION, prices: [px('YM=F', 53001.9, false), px('NIY=F', 65190, false)], feed: OK_FEED,
      niy: { staleMs: 0, alarm: false },
    });
    expect(hb.state).toBe('ok');
    expect(hb.inSession).toBe(true);
    expect(hb.symbols.map(s => s.symbol)).toEqual(['YM=F', 'NIY=F']);
  });

  it('★提供元の時計が凍結 = frozen(値は取れているのに更新が止まっている)', () => {
    const hb = buildPriceFeedHeartbeat({
      now: IN_SESSION, prices: [px('YM=F', 53241.2, true), px('NQ=F', 29561.6, true)],
      feed: feed('08:19', true, 8 * 60 * 60_000),
    });
    expect(hb.state).toBe('frozen');
    expect(hb.reason).toContain('08:19');
    expect(formatPriceFeedStatus(hb)).toContain('FEED-FROZEN');
  });

  it('★立会中に NIY=F だけ来ていない = stalled(2026-09-06 の損害の本体)', () => {
    const hb = buildPriceFeedHeartbeat({
      now: IN_SESSION,
      prices: [px('NIY=F', 65190, true), px('YM=F', 53001.9, false), px('NQ=F', 29580.9, false)],
      feed: OK_FEED,                                  // 731/737 は生きている = 時計は進んでいる
      niy: { staleMs: 4 * 60_000, alarm: true },
    });
    expect(hb.state).toBe('stalled');
    expect(hb.reason).toContain('NIY=F');
    expect(hb.niyStaleMs).toBe(4 * 60_000);
    // ★「立会中に NIY=F が来ない」と「ハートビート自体が止まった」を字面で区別する(取り違え防止)。
    expect(formatPriceFeedStatus(hb)).toContain('NIY-MISSING');
    expect(formatPriceFeedStatus(hb)).not.toContain('STALLED');
  });

  it('全銘柄が清算(liveFlag=0)= settled(正常。週末を赤くしない)', () => {
    const hb = buildPriceFeedHeartbeat({
      now: IN_SESSION, prices: [px('NIY=F', 65190, true)], feed: feed(null, false, 0),
    });
    expect(hb.state).toBe('settled');
  });

  it('1件も取れない = down(★凍結と混同しない)', () => {
    const hb = buildPriceFeedHeartbeat({ now: IN_SESSION, prices: [], feed: feed(null, false, 0) });
    expect(hb.state).toBe('down');
    expect(hb.reason).toContain('取得失敗');
  });

  it('★取引時間外は offhours(取りに行っていないのが正常。夜間に毎晩赤くしない)', () => {
    const hb = buildPriceFeedHeartbeat({ now: OFF_HOURS, prices: [], feed: feed(null, false, 0) });
    expect(hb.state).toBe('offhours');
    expect(hb.inSession).toBe(false);
  });
});

describe('meta への書き出し(既存の tick_archive_status と同じ流儀)', () => {
  it('JSON 本体と人が読む1行の2本を書き、読み戻せる', () => {
    const db = sharedDb();
    const hb = writePriceFeedHeartbeat(db, {
      now: IN_SESSION, prices: [px('YM=F', 53241.2, true)], feed: feed('08:19', true, 600_000),
    });
    expect(readPriceFeedHeartbeat(db)).toEqual(hb);
    const line = getMeta(db, PRICE_FEED_STATUS_KEY)!;
    expect(line).toContain('FEED-FROZEN');
    expect(line).toContain('YM=F=53241.2(stale)');
    expect(getMeta(db, PRICE_FEED_HEARTBEAT_KEY)).toContain('"frozen":true');
    db.close();
  });

  it('壊れた値は「無い」扱い(次のハートビートで上書きされる)', () => {
    const db = sharedDb();
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(PRICE_FEED_HEARTBEAT_KEY, '{壊れた');
    expect(readPriceFeedHeartbeat(db)).toBeNull();
    db.close();
  });
});

describe('★判定は1箇所(画面はサーバの結論を運ぶだけ)', () => {
  it('まだ測っていなければ null(画面は従来表示にフォールバックする)', () => {
    resetPublishedPriceFeedHeartbeat();
    expect(priceFeedApiState()).toBeNull();
  });

  it('publish した判定の state/reason がそのまま /api/status 用に出る', () => {
    resetPublishedPriceFeedHeartbeat();
    const hb = buildPriceFeedHeartbeat({
      now: IN_SESSION, prices: [px('NIY=F', 65190, true), px('YM=F', 53001.9, false)],
      feed: OK_FEED, niy: { staleMs: 5 * 60_000, alarm: true },
    });
    publishPriceFeedHeartbeat(hb);
    expect(priceFeedApiState()).toEqual({ state: 'stalled', reason: hb.reason, at: IN_SESSION });
    resetPublishedPriceFeedHeartbeat();
  });
});

describe('describePriceFeed — 読む時刻から見て評価する', () => {
  const okHb = () => buildPriceFeedHeartbeat({
    now: IN_SESSION, prices: [px('YM=F', 53001.9, false)], feed: OK_FEED,
  });

  it('ハートビートが無ければ missing', () => {
    expect(describePriceFeed(null, IN_SESSION).state).toBe('missing');
  });

  it('★ok のまま古くなったら stalled として出す(値が更新されない=正常 と誤読させない)', () => {
    const v = describePriceFeed(okHb(), IN_SESSION + PRICE_FEED_HEARTBEAT_FRESH_MS + 1);
    expect(v.state).toBe('down');
    expect(v.text).toContain('HEARTBEAT-LOST');
    expect(v.text).not.toContain('NIY-MISSING');   // 別物なので字面が衝突しない
  });

  it('新しいうちはその状態をそのまま返す', () => {
    expect(describePriceFeed(okHb(), IN_SESSION + 1000).state).toBe('ok');
  });
});
