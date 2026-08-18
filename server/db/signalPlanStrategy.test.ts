import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, insertSignalPlan, insertSignalTrade, getSignalPlans } from './store.js';
import { buildSignalPlanInsert } from '../signalTrade/planLedger.js';
import { parseScalpPlan } from '../llm/scalpPlan.js';

// ★記録専用(ADD-ONLY・v0.9.84): signal_plans.strategy / strategy_why = その計画の **狙い**(相場の読み)。
//
// ■ なぜ本線の台帳に要るか(ここが無いと目的が達成できない)
//   このプロジェクトの本体は ④AI が理由と共に提示 →⑤結果を正確に記録 →⑥それを AI に返す のループ。
//   ⑥を作る buildScalpTradeHistory(server/llm/scalpContext.ts)が読むのは **signal_trades だけ**で、
//   そこには pnl はあっても狙いが無い。分析用の台帳(generator の proposals.plan_json)には狙いが
//   入るが、あちらに pnl は無い。**この2列が無いと「押し目 12件 勝率33%」は1行も作れない**。
//
// ■ 何を守るテストか
//   ① 新規DBに列が在る(冪等)/② 型が TEXT
//   ③ ★列を持たない既存DBへ ALTER が走り、既存行が1バイトも壊れない
//   ④ planLedger が AiPlan の値をこの列へ運ぶ(未知ラベルも丸めない・欠落は NULL)
//   ⑤ ★**signal_trades と結合して戦略別の勝率が出せる**(これが目的なので実データで示す)
//
// ★否定対照: git show HEAD~1:server/db/store.ts の signal_plans に strategy 列は無く、
//   git show HEAD~1:server/signalTrade/planLedger.ts はこの2つをどこにも書かない(=このファイルは全件赤)。
// ★検知・採否・価格・決済には一切関与しない(列が増えるだけ)。

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function fileDb(): { db: DatabaseSync; path: string } {
  dir = mkdtempSync(join(tmpdir(), 'jp225-plan-strategy-'));
  const path = join(dir, 'jp225.db');
  return { db: new DatabaseSync(path), path };
}

describe('signal_plans.strategy / strategy_why(計画の狙い)', () => {
  it('新規DBに両列が在る(initSchema を何回呼んでも冪等)', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    initSchema(db);
    initSchema(db);
    const cols = (db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('strategy');
    expect(cols).toContain('strategy_why');
    db.close();
  });

  it('両列とも TEXT(語をそのまま入れる。番号化も enum 化もしない)', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    const info = db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string; type: string }>;
    expect(info.find(c => c.name === 'strategy')?.type).toBe('TEXT');
    expect(info.find(c => c.name === 'strategy_why')?.type).toBe('TEXT');
    db.close();
  });

  it('★実ファイル: 列を持たない既存DBへ後付け ALTER が走り、既存行は壊れない', () => {
    const { db, path } = fileDb();
    // ── 旧版のスキーマを手で作る(この2列を持たない signal_plans)。既存行も1件入れておく。
    db.exec(`
      CREATE TABLE signal_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        t INTEGER NOT NULL, system TEXT NOT NULL, signal_id INTEGER,
        direction TEXT, none_reason TEXT, veto_fired INTEGER, ref_price REAL,
        regime TEXT, confidence REAL,
        limit_entry REAL, stop_entry REAL, stop_loss_for_limit REAL, stop_loss_for_stop REAL,
        leg_drops_json TEXT, settings_json TEXT, rationale TEXT, error TEXT,
        context_at INTEGER, prompt_fp TEXT, provider TEXT, provider_model TEXT
      );
    `);
    db.prepare(`INSERT INTO signal_plans (t, system, direction, ref_price, rationale, prompt_fp)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(1000, 'A', 'buy', 38250, '旧版で記録した行', 'sp1:0123456789abcdef');
    const before = db.prepare('SELECT * FROM signal_plans').all() as Array<Record<string, unknown>>;
    db.close();

    // ── 新版で開き直す(= 起動時の initSchema)。
    const db2 = new DatabaseSync(path);
    initSchema(db2);
    const cols = (db2.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('strategy');
    expect(cols).toContain('strategy_why');

    // ★既存行は1バイトも壊れない(新列は NULL で埋まるだけ)。
    const after = db2.prepare('SELECT * FROM signal_plans').all() as Array<Record<string, unknown>>;
    expect(after).toHaveLength(1);
    for (const [k, v] of Object.entries(before[0]!)) expect(after[0]![k]).toEqual(v);
    expect(after[0]!.strategy).toBeNull();
    expect(after[0]!.strategy_why).toBeNull();

    // ★冪等: もう一度 initSchema しても落ちない(duplicate column にならない)。
    initSchema(db2);
    expect((db2.prepare('SELECT COUNT(*) c FROM signal_plans').get() as { c: number }).c).toBe(1);

    // 新しい行は新列に値が入る=旧行と新行が同じ表で共存できる。
    insertSignalPlan(db2, {
      t: 2000, system: 'A', direction: 'buy', refPrice: 38300,
      strategy: 'トレンド押し目・戻り', strategyWhy: '上昇トレンド中、S1まで引きつけて反発を取る',
    });
    const rows = getSignalPlans(db2);
    expect(rows.find(r => r.t === 2000)!.strategy).toBe('トレンド押し目・戻り');
    expect(rows.find(r => r.t === 2000)!.strategy_why).toBe('上昇トレンド中、S1まで引きつけて反発を取る');
    db2.close();
  });
});

describe('planLedger → signal_plans: 狙いを台帳へ運ぶ', () => {
  const rawPlan = (extra: Record<string, unknown>) => JSON.stringify({
    direction: 'buy', limitEntry: 38200, stopEntry: 38350,
    lcWidthForLimit: 55, lcWidthForStop: 60,
    rationale: '押し目。指値レッグ: 38200-38145=55円。ブレイク新規レッグ: 38350-38290=60円。',
    refPrice: 38250, ...extra,
  });

  it('★実ファイル SQLite: AI が出したラベルが strategy / strategy_why 列に入る', () => {
    const result = parseScalpPlan(rawPlan({ strategy: 'ブレイク順張り', strategyWhy: 'R1を実体で抜けた' }), 38250);
    const insert = buildSignalPlanInsert({ t: 5000, system: 'A', result, signalId: 7 });
    expect(insert.strategy).toBe('ブレイク順張り');
    const { db } = fileDb();
    initSchema(db);
    insertSignalPlan(db, insert);
    const row = getSignalPlans(db)[0]!;
    expect(row.strategy).toBe('ブレイク順張り');
    expect(row.strategy_why).toBe('R1を実体で抜けた');
    expect(row.signal_id).toBe(7);
    // 既存の列は不変(記録専用の追加が既存の写しを壊していない)。
    expect(row.direction).toBe('buy');
    expect(row.limit_entry).toBe(38200);
    db.close();
  });

  it('★一覧外のラベルも丸めずそのまま列に入る(リストが現実と合っていない証拠を消さない)', () => {
    const result = parseScalpPlan(rawPlan({ strategy: '寄り天の売り' }), 38250);
    const insert = buildSignalPlanInsert({ t: 5001, system: 'A', result });
    const { db } = fileDb();
    initSchema(db);
    insertSignalPlan(db, insert);
    expect(getSignalPlans(db)[0]!.strategy).toBe('寄り天の売り');
    db.close();
  });

  it('AI が書かなかった/壊れていた回は NULL(欠測が形から読める)', () => {
    for (const extra of [{}, { strategy: 42 }, { strategy: '   ' }]) {
      const result = parseScalpPlan(rawPlan(extra), 38250);
      const insert = buildSignalPlanInsert({ t: 5002, system: 'A', result });
      expect(insert.strategy).toBeUndefined();
      const { db } = fileDb();
      initSchema(db);
      insertSignalPlan(db, insert);
      const row = getSignalPlans(db)[0]!;
      expect(row.strategy).toBeNull();
      // ★計画そのものは落ちていない(記録専用)。
      expect(row.direction).toBe('buy');
      db.close();
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });
});

// ─── ★これが目的: 戦略別の成績を作れること ────────────────────────────────
describe('★signal_plans × signal_trades: 戦略別の勝率を作れる(⑥が返す材料)', () => {
  /** ★結合キーは (system, signal_id) の **対**。signal_id 単独では結合キーにならない:
   *  A と B は別々のカウンタ(signal_meta の system キー)で采番するので番号が重なる。
   *  さらに signal_trades.system は A のとき NULL がありうる後方互換規約なので COALESCE で正規化する。 */
  const SQL = `
    SELECT sp.strategy AS strategy,
           COUNT(*) AS n,
           SUM(CASE WHEN st.pnl > 0 THEN 1 ELSE 0 END) AS wins
      FROM signal_trades st
      JOIN signal_plans sp
        ON sp.signal_id = st.signal_id
       AND sp.system = COALESCE(st.system, 'A')
     WHERE sp.strategy IS NOT NULL
     GROUP BY sp.strategy
     ORDER BY n DESC, strategy
  `;

  it('実ファイル SQLite で「押し目 3件 勝率33%」の形が SQL 1本で出る', () => {
    const { db } = fileDb();
    initSchema(db);
    // 押し目3件(勝ち1・負け2=勝率33%)/ ブレイク2件(勝ち2=勝率100%)。
    const rows: Array<[number, string, number]> = [
      [1, 'トレンド押し目・戻り', +40],
      [2, 'トレンド押し目・戻り', -55],
      [3, 'トレンド押し目・戻り', -55],
      [4, 'ブレイク順張り', +80],
      [5, 'ブレイク順張り', +30],
    ];
    for (const [signalId, strategy, pnl] of rows) {
      insertSignalPlan(db, {
        t: 1000 + signalId, system: 'A', signalId, direction: 'buy', refPrice: 38250,
        strategy, strategyWhy: 'テスト',
      });
      insertSignalTrade(db, {
        entryT: 2000 + signalId, entryPrice: 38200, dir: 'buy',
        exitT: 3000 + signalId, exitPrice: 38200 + pnl, pnl, qty: 1,
        system: 'A', signalId,
      });
    }
    const got = db.prepare(SQL).all() as Array<{ strategy: string; n: number; wins: number }>;
    expect(got).toEqual([
      { strategy: 'トレンド押し目・戻り', n: 3, wins: 1 },
      { strategy: 'ブレイク順張り', n: 2, wins: 2 },
    ]);
    // ⑥が返す文字列そのもの(「押し目 3件 勝率33%」)まで作れることを示す。
    const line = got.map(r => `${r.strategy} ${r.n}件 勝率${Math.round((r.wins / r.n) * 100)}%`);
    expect(line).toEqual(['トレンド押し目・戻り 3件 勝率33%', 'ブレイク順張り 2件 勝率100%']);
    db.close();
  });

  it('★A と B は同じ signal_id を持ちうる: system を含めないと戦略が混ざる(結合キーの実証)', () => {
    const { db } = fileDb();
    initSchema(db);
    // 同じ signal_id=1 を A と B が別々に持つ(采番カウンタが系統別だから起こる)。
    insertSignalPlan(db, { t: 1, system: 'A', signalId: 1, strategy: 'トレンド押し目・戻り' });
    insertSignalPlan(db, { t: 2, system: 'B', signalId: 1, strategy: '節目の逆張り' });
    // A の trade は system=NULL(後方互換規約)で入りうる。
    insertSignalTrade(db, { entryT: 10, entryPrice: 1, dir: 'buy', exitT: 11, exitPrice: 2, pnl: +10, qty: 1, signalId: 1 });
    const ok = db.prepare(SQL).all() as Array<{ strategy: string; n: number; wins: number }>;
    expect(ok).toEqual([{ strategy: 'トレンド押し目・戻り', n: 1, wins: 1 }]);
    // signal_id だけで結合すると B の計画まで拾って件数が倍になる(=これが既知の罠)。
    const naive = db.prepare(
      'SELECT COUNT(*) AS n FROM signal_trades st JOIN signal_plans sp ON sp.signal_id = st.signal_id',
    ).get() as { n: number };
    expect(naive.n).toBe(2);
    db.close();
  });
});
