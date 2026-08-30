import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSchema, getMeta, setTpSemanticsMeta, setLcAuditSemanticsMeta, setColumnVocabMeta,
  insertSignalPlan,
  COLUMN_SEMANTICS_TP_KEY, COLUMN_SEMANTICS_TP_NOTE,
  COLUMN_SEMANTICS_LC_AUDIT_KEY, COLUMN_VOCAB_KEY,
} from './store.js';
import { buildSignalPlanInsert } from '../signalTrade/planLedger.js';

// ★記録専用(ADD-ONLY・2026-08-30): TP(利確の成行決済)の6列 と、その意味論の meta 1行。
//
// ■ なぜ記録が本体か
//   一律TP は実測(shadow_exits 501,330行)で **どの幅でも成績を悪化させた**。それでも入れるのは
//   「AI が1件ごとに選ぶTP」のデータが1件も無いため。★記録が貯まらなければ何も学べない。
//
// ■ このテストが固定する不変条件
//   ① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない)
//   ② 旧行は NULL のまま(= 欠測期間として読める)
//   ③ 値が実際に入る(型も含めて)
//   ④ ★meta に「AI委任/手動の層別」「5円ずらしで詰まりうる」「途中の版から入った」が届く
//      (★ソースのコメントは DB を開いた分析者に1文字も届かない = column_vocab と同じ理由)
//   ⑤ ★まだ実データに出ていない版番号を焼かない
// ★決済ロジック・採否・価格・veto には一切関与しない(列が増えるだけ)。

let dir = '';
afterEach(() => {
  if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 残骸は無害 */ } }
  dir = '';
});
const cols = (db: DatabaseSync, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);

const PLAN_COLS = ['tp_width_for_limit', 'tp_width_for_stop', 'tp_why', 'tp_source'] as const;
const TRADE_COLS = ['tp_width', 'tp_trigger'] as const;

/** TP の列を持たない(= TP 導入前の)DB を手で作る。 */
function oldDb(): DatabaseSync {
  dir = mkdtempSync(join(tmpdir(), 'jp225-tpcols-'));
  const db = new DatabaseSync(join(dir, 'jp225.db'));
  db.exec(`
    CREATE TABLE signal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, system TEXT NOT NULL,
      direction TEXT, none_reason TEXT, ref_price REAL, rationale TEXT
    );
    CREATE TABLE signal_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entry_t INTEGER NOT NULL, entry_price REAL NOT NULL,
      dir TEXT NOT NULL, exit_t INTEGER NOT NULL, exit_price REAL NOT NULL,
      pnl REAL NOT NULL, qty INTEGER NOT NULL, exit_reason TEXT
    );
  `);
  db.prepare('INSERT INTO signal_plans (t, system, direction) VALUES (?,?,?)').run(1, 'A', 'buy');
  db.prepare(`INSERT INTO signal_trades (entry_t, entry_price, dir, exit_t, exit_price, pnl, qty)
              VALUES (?,?,?,?,?,?,?)`).run(1, 100, 'buy', 2, 110, 10, 1);
  return db;
}

describe('★TP の記録列(実ファイル SQLite)', () => {
  it('① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない)', () => {
    const db = oldDb();
    for (const c of PLAN_COLS) expect(cols(db, 'signal_plans')).not.toContain(c);
    for (const c of TRADE_COLS) expect(cols(db, 'signal_trades')).not.toContain(c);
    initSchema(db);
    initSchema(db);
    for (const c of PLAN_COLS) expect(cols(db, 'signal_plans')).toContain(c);
    for (const c of TRADE_COLS) expect(cols(db, 'signal_trades')).toContain(c);
    db.close();
  });

  it('② 旧行は NULL のまま(欠測期間として読める・過去を捏造しない)', () => {
    const db = oldDb();
    initSchema(db);
    const p = db.prepare('SELECT tp_width_for_limit a, tp_width_for_stop b, tp_why c, tp_source d FROM signal_plans')
      .get() as Record<string, unknown>;
    expect([p.a, p.b, p.c, p.d]).toEqual([null, null, null, null]);
    const t = db.prepare('SELECT tp_width a, tp_trigger b FROM signal_trades').get() as Record<string, unknown>;
    expect([t.a, t.b]).toEqual([null, null]);
    db.close();
  });

  it('③ 値が入る(幅は数値・source は層別キーの文字列)', () => {
    const db = oldDb();
    initSchema(db);
    db.prepare(`UPDATE signal_plans SET tp_width_for_limit=?, tp_width_for_stop=?, tp_why=?, tp_source=?`)
      .run(115, 85, '直近高値まで', 'ai');
    const p = db.prepare('SELECT tp_width_for_limit a, tp_width_for_stop b, tp_why c, tp_source d FROM signal_plans')
      .get() as Record<string, unknown>;
    expect([p.a, p.b, p.c, p.d]).toEqual([115, 85, '直近高値まで', 'ai']);
    db.prepare('UPDATE signal_trades SET tp_width=?, tp_trigger=?, exit_reason=?').run(115, 65_715, 'take_profit');
    const t = db.prepare('SELECT tp_width a, tp_trigger b, exit_reason c FROM signal_trades')
      .get() as Record<string, unknown>;
    expect([t.a, t.b, t.c]).toEqual([115, 65_715, 'take_profit']);
    db.close();
  });
});

// ★DB を開いた人に「TP列の読み方」を届ける(column_vocab / column_semantics_lc_audit と同じ流儀)。
describe('★TP列の意味論が meta から読める', () => {
  const open = (): DatabaseSync => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-tpmeta-'));
    const db = new DatabaseSync(join(dir, 'jp225.db'));
    initSchema(db);
    return db;
  };

  it('④-1 実ファイルの meta に1行入る(書く前は無い=この検査は恒真でない)', () => {
    const db = open();
    expect(getMeta(db, COLUMN_SEMANTICS_TP_KEY)).toBeNull();
    setTpSemanticsMeta(db);
    expect(getMeta(db, COLUMN_SEMANTICS_TP_KEY)).toBe(COLUMN_SEMANTICS_TP_NOTE);
    db.close();
  });

  it('④-2 中身に「途中の版から」「tp_source で層別」「5円ずらしで詰まりうる」が揃っている', () => {
    const db = open();
    setTpSemanticsMeta(db);
    const note = getMeta(db, COLUMN_SEMANTICS_TP_KEY)!;
    expect(note).toContain('v0.9.103');            // ★どの版より後に入ったか
    expect(note).toContain('NULL');                // ★欠測期間
    expect(note).toContain('tp_source');           // ★層別キー
    expect(note).toContain('層別');
    expect(note).toContain('5円');                 // ★ずらしで詰まりうる
    expect(note).toContain('詰められている');
    expect(note).toContain('申告そのものではありません');
    expect(note).toContain('take_profit');         // ★決済理由
    expect(note).toContain('range_tp');            // ★別物であること
    db.close();
  });

  it('④-3 冪等(2回書いても1行のまま)', () => {
    const db = open();
    setTpSemanticsMeta(db);
    setTpSemanticsMeta(db);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM meta WHERE key = ?').get(COLUMN_SEMANTICS_TP_KEY) as { n: number }).n;
    expect(n).toBe(1);
    db.close();
  });

  it('④-4 既存の2つの meta を1バイトも汚さない(別のキー・別の意味論)', () => {
    const db = open();
    setColumnVocabMeta(db);
    setLcAuditSemanticsMeta(db);
    const vocab = getMeta(db, COLUMN_VOCAB_KEY);
    const lc = getMeta(db, COLUMN_SEMANTICS_LC_AUDIT_KEY);
    setTpSemanticsMeta(db);
    expect(getMeta(db, COLUMN_VOCAB_KEY)).toBe(vocab);
    expect(getMeta(db, COLUMN_SEMANTICS_LC_AUDIT_KEY)).toBe(lc);
    expect(COLUMN_SEMANTICS_TP_KEY).not.toBe(COLUMN_VOCAB_KEY);
    expect(COLUMN_SEMANTICS_TP_KEY).not.toBe(COLUMN_SEMANTICS_LC_AUDIT_KEY);
    db.close();
  });

  // ★★…… 後から DB を開いた人が **必ず誤読する罠** を2つ、meta に届ける(宣言だけにしない)。
  //   罠(1) tp_source と signal_trades.tp_width は **別の時刻の別の事実**。
  //          手動TP幅は保有中でも変更できるので、tp_source=ai なのに tp_width は手動の値、
  //          という行が作れる。★片方だけを信じて層別すると間違える。
  //   罠(2) TP で閉じた回は「TP が無ければどこまで伸びたか」を残さない(peak_profit が止まる)。
  //          ★知らずに集計すると「TP は常に正しかった」という誤った結論が出る。
  it('★★⑥-1 罠(1): tp_source と signal_trades.tp_width が別の時刻の事実だと書いてある', () => {
    const db = open();
    setTpSemanticsMeta(db);
    const note = getMeta(db, COLUMN_SEMANTICS_TP_KEY)!;
    expect(note).toContain('signal_trades.tp_width');
    expect(note).toContain('別の時刻の別の事実');
    expect(note).toContain('保有中でも変更できる');   // ★不一致が起きる理由
    expect(note).toContain('仕様');                   // ★欠陥ではない
    expect(note).toContain('片方だけを信じないで');   // ★層別のしかた
    db.close();
  });

  it('★★⑥-2 罠(2): TP 発火回は「伸びしろ」を残さないと書いてある', () => {
    const db = open();
    setTpSemanticsMeta(db);
    const note = getMeta(db, COLUMN_SEMANTICS_TP_KEY)!;
    expect(note).toContain('peak_profit');
    expect(note).toContain('TP に届かなかった回');
    expect(note).toContain('TP は常に正しかった');    // ★出てしまう誤った結論
    expect(note).toContain('mfe');                    // ★反事実の見方
    db.close();
  });

  // ★★罠(3): 「TP を切っていた期間」は tp_source では特定できない(manual に3つが混ざる)。
  //   ★手がかりは settings_json の3キーだけ。★これが meta に無いと、記録は在るのに誰も辿り着けない
  //   (この案件が繰り返している型: 宣言だけ残る / 取得経路が消える / 記録は在るが誰も知らない)。
  it('★★⑥-3 罠(3): TP を切っていた期間の探し方(settings_json)が書いてある', () => {
    const db = open();
    setTpSemanticsMeta(db);
    const note = getMeta(db, COLUMN_SEMANTICS_TP_KEY)!;
    expect(note).toContain('settings_json');
    expect(note).toContain('scalpTpEnabled');
    expect(note).toContain('scalpTpWidthSource');
    expect(note).toContain('scalpTpWidthYen');
    expect(note).toContain('tp_source では特定できません');
    expect(note).toContain('json_extract');
    // ★source=ai でも設定値が載る=単独で読むと誤る、の警告。
    expect(note).toContain('必ず scalpTpWidthSource と一緒に読んでください');
    db.close();
  });

  it('★⑤ まだ実データに現れていない版番号を焼いていない(column_vocab / lc_audit と同じ作法)', () => {
    const db = open();
    setTpSemanticsMeta(db);
    const note = getMeta(db, COLUMN_SEMANTICS_TP_KEY)!;
    // ★名乗ってよいのは「5円ずらしが入った版(v0.9.103)より **後**」だけ。
    //   TP がどの版で出るかは出荷まで確定しないので、番号を1つも書かない。
    expect([...new Set(note.match(/\d+\.\d+\.\d+/g) ?? [])]).toEqual(['0.9.103']);
    for (const v of ['0.9.104', '0.9.105', '1.0.0']) expect(note).not.toContain(v);
    db.close();
  });
});

// ═══ ★書き込みの配線(★実ファイル SQLite の end-to-end) ═════════════════════
//
//   ■ ★なぜここまでやるか
//     前の版では「列は足したが、値を書き込むコードがどこにも無い」状態だった
//     (= 記録は永久に NULL)。★**列の存在を確かめるだけの検査は、その状態を緑にしてしまう**。
//     だから行ビルダー(buildSignalPlanInsert)から INSERT を通し、SELECT で読み戻す。
//   ■ ★tp_source は **設定ではなく SplitRecord.bAskTp(実測)** から導く。
//     'ai' / 'manual' / NULL の3値に意味がある(NULL = B を呼んでいない)。
describe('★TP 列への書き込み(実ファイル SQLite の end-to-end)', () => {
  const TP_COLS = ['tp_width_for_limit', 'tp_width_for_stop', 'tp_why', 'tp_source', 'tp_read_issue'] as const;

  const openReal = (): DatabaseSync => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-tpe2e-'));
    const db = new DatabaseSync(join(dir, 'jp225.db'));   // ★実ファイル(:memory: ではない)
    initSchema(db);
    return db;
  };

  /** 1件分の入力。plan / splitRecord だけを差し替える。 */
  const input = (plan: Record<string, unknown>, splitRecord?: Record<string, unknown>): never =>
    ({
      t: 1_700_000_000_000, system: 'A',
      result: {
        ok: true,
        plan: {
          direction: 'buy', rationale: '節目抜けを狙う', refPrice: 65_700,
          limitEntry: 65_605, stopLossForLimit: 65_540,
          stopEntry: 65_805, stopLossForStop: 65_740,
          ...plan,
        },
        ...(splitRecord ? { splitRecord: { squeezeState: null, ...splitRecord } } : {}),
      },
    }) as never;

  const writeAndRead = (db: DatabaseSync, i: never): Record<string, unknown> => {
    insertSignalPlan(db, buildSignalPlanInsert(i));
    const rows = db.prepare('SELECT * FROM signal_plans ORDER BY id DESC LIMIT 1').all();
    return rows[0] as Record<string, unknown>;
  };

  it('★① AI委任(bAskTp=true)→ tp_source="ai" と TP幅が実ファイルDB に入る', () => {
    const db = openReal();
    const r = writeAndRead(db, input(
      { tpWidthForLimit: 115, tpWidthForStop: 85 }, { bVariant: 'buy', bAskTp: true }));
    expect(r.tp_source).toBe('ai');
    expect(r.tp_width_for_limit).toBe(115);
    expect(r.tp_width_for_stop).toBe(85);
    db.close();
  });

  it('★② 手動/TP無効(bAskTp=false)→ tp_source="manual" で 幅は NULL', () => {
    const db = openReal();
    const r = writeAndRead(db, input({}, { bVariant: 'buy', bAskTp: false }));
    expect(r.tp_source).toBe('manual');
    expect(r.tp_width_for_limit).toBeNull();
    expect(r.tp_width_for_stop).toBeNull();
    db.close();
  });

  it('★③ B を呼ばなかった回(bVariant="none")→ tp_source は NULL', () => {
    const db = openReal();
    const r = writeAndRead(db, input({}, { bVariant: 'none' }));
    expect(r.tp_source).toBeNull();
    // ★'manual' で埋めない: 「尋ねたかどうか」という事実自体が存在しない回。
    expect(r.b_variant).toBe('none');
    db.close();
  });

  it('★④ TP幅を読めなかった脚 → tp_read_issue に残る(★脚は落とさない)', () => {
    const db = openReal();
    const r = writeAndRead(db, input(
      { tpWidthForStop: 120 },
      { bVariant: 'buy', bAskTp: true, tpReadIssue: '「指値買い」TP幅を読めなかった(ラベル付きの記述が無い)' }));
    expect(String(r.tp_read_issue)).toContain('TP幅を読めなかった');
    expect(r.tp_width_for_stop).toBe(120);      // ★読めた方の脚は入る
    expect(r.tp_width_for_limit).toBeNull();
    expect(r.limit_entry).toBe(65_605);         // ★★脚は落ちていない
    expect(r.leg_drops_json).toBeNull();
    db.close();
  });

  it('★tp_why は常に NULL(裁定2・意図して設定していない)だが、配線は通っている', () => {
    const db = openReal();
    expect(writeAndRead(db, input({ tpWidthForLimit: 115 }, { bVariant: 'buy', bAskTp: true })).tp_why).toBeNull();
    // ★恒真でない対照: plan.tpWhy を持つ経路が来たら、そのまま入る(書き忘れの経路を作らない)。
    expect(writeAndRead(db, input(
      { tpWidthForLimit: 115, tpWhy: '直近高値まで' }, { bVariant: 'buy', bAskTp: true })).tp_why)
      .toBe('直近高値まで');
    db.close();
  });

  it('★★TP を使わない設定の行は、TP の5列以外が AI委任の行と完全に同じ', () => {
    // ★「TP を足しても、使わなければ台帳の他の列は1バイトも動かない」の確認。
    const db = openReal();
    const manual = writeAndRead(db, input({}, { bVariant: 'buy', bAskTp: false }));
    const ai = writeAndRead(db, input(
      { tpWidthForLimit: 115, tpWidthForStop: 85 }, { bVariant: 'buy', bAskTp: true }));
    const keys = Object.keys(manual).filter(k => k !== 'id' && !(TP_COLS as readonly string[]).includes(k));
    const diffs = keys.filter(k => JSON.stringify(manual[k]) !== JSON.stringify(ai[k]));
    expect(diffs).toEqual([]);
    expect(keys.length).toBeGreaterThan(50);   // ★比べた列が少なすぎないこと
    // ★恒真でない対照: TP の5列には差がある。
    expect(TP_COLS.filter(c => JSON.stringify(manual[c]) !== JSON.stringify(ai[c])))
      .toEqual(['tp_width_for_limit', 'tp_width_for_stop', 'tp_source']);
    db.close();
  });
});
