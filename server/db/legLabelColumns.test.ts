import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSchema, getMeta, setLegLabelSemanticsMeta, insertSignalPlan,
  COLUMN_SEMANTICS_LEG_LABEL_KEY, COLUMN_SEMANTICS_LEG_LABEL_NOTE,
} from './store.js';
import { buildSignalPlanInsert } from '../signalTrade/planLedger.js';
import { entryLabel } from '../../core/entryLabel.js';

// ★記録専用(ADD-ONLY・2026-08-31): 脚の名札の2列 と、その意味論の meta 1行。
//
// ■ 経緯(ユーザー指示・逐語)
//   「シグナル最後の行の指値押し目買い等の文字列は、こちら側の文字例なので、
//     表示しないようにして、記録のみにしてください。」
//   = 画面から名札を消し、**同じ文字列を台帳へ移す**(消したのではない)。
//
// ■ ★なぜ列を足すのか(「後から再計算できる」を採らない理由)
//   名札は direction × 脚の種別 × trend_dir から再計算できる **ように見える**。
//   ★その規則は既に一度変わっている(core/entryLabel.ts:20 — 初版は脚の種別だけで
//     順張り/逆張りを決めており、誤りだった)。再計算に頼ると、規則が変わった日に
//     **過去行の名札が新しい規則で書き換わる**(歴史が黙って変わる)。
//   ⇒ 「そのときそう呼んだ」という事実を、そのときの文字列で残す。
//
// ■ このテストが固定する不変条件
//   ① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない)
//   ② 旧行は NULL のまま(= 欠測期間として読める)
//   ③ ★実ファイル SQLite の end-to-end で値が入る(行ビルダー → INSERT → SELECT)
//   ④ ★脚が無い側は NULL(空文字ではない)/ トレンドが取れない回は脚の型の語だけ
//   ⑤ ★値の出所は core/entryLabel.ts ひとつ(再実装していない)
//   ⑥ ★meta に「AI の言葉ではない」「途中の版から」「NULL の意味」が届く
// ★決済ロジック・採否・価格・veto・SSE には一切関与しない(列が増えるだけ)。

let dir = '';
afterEach(() => {
  if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 残骸は無害 */ } }
  dir = '';
});
const cols = (db: DatabaseSync, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);

const LABEL_COLS = ['leg_label_limit', 'leg_label_stop'] as const;

/** 名札の列を持たない(= 導入前の)DB を手で作る。 */
function oldDb(): DatabaseSync {
  dir = mkdtempSync(join(tmpdir(), 'jp225-leglabelcols-'));
  const db = new DatabaseSync(join(dir, 'jp225.db'));
  db.exec(`
    CREATE TABLE signal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, system TEXT NOT NULL,
      direction TEXT, none_reason TEXT, ref_price REAL, rationale TEXT
    );
  `);
  db.prepare('INSERT INTO signal_plans (t, system, direction) VALUES (?,?,?)').run(1, 'A', 'buy');
  return db;
}

describe('★脚の名札の記録列(実ファイル SQLite)', () => {
  it('① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない)', () => {
    const db = oldDb();
    for (const c of LABEL_COLS) expect(cols(db, 'signal_plans')).not.toContain(c);
    initSchema(db);
    initSchema(db);
    for (const c of LABEL_COLS) expect(cols(db, 'signal_plans')).toContain(c);
    db.close();
  });

  it('② 旧行は NULL のまま(欠測期間として読める・過去を捏造しない)', () => {
    const db = oldDb();
    initSchema(db);
    const p = db.prepare('SELECT leg_label_limit a, leg_label_stop b FROM signal_plans')
      .get() as Record<string, unknown>;
    expect([p.a, p.b]).toEqual([null, null]);
    db.close();
  });
});

// ═══ ★書き込みの配線(★実ファイル SQLite の end-to-end) ═════════════════════
//   ■ ★列の存在を確かめるだけの検査は「列は足したが誰も書かない」状態を緑にしてしまう。
//     だから行ビルダー(buildSignalPlanInsert)から INSERT を通し、SELECT で読み戻す。
describe('★脚の名札の書き込み(実ファイル SQLite の end-to-end)', () => {
  const openReal = (): DatabaseSync => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-leglabele2e-'));
    const db = new DatabaseSync(join(dir, 'jp225.db'));   // ★実ファイル(:memory: ではない)
    initSchema(db);
    return db;
  };

  /** 1件分の入力。plan と result の追加フィールドだけを差し替える。 */
  const input = (plan: Record<string, unknown>, result: Record<string, unknown> = {}): never =>
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
        ...result,
      },
    }) as never;

  const writeAndRead = (db: DatabaseSync, i: never): Record<string, unknown> => {
    insertSignalPlan(db, buildSignalPlanInsert(i));
    return db.prepare('SELECT * FROM signal_plans ORDER BY id DESC LIMIT 1').all()[0] as Record<string, unknown>;
  };

  it('★① 両脚あり・トレンドあり → 2列に名札が入る(順張り/逆張りが付く)', () => {
    const db = openReal();
    const r = writeAndRead(db, input({}, { trendDir: 'up' }));
    expect(r.leg_label_limit).toBe('押し目買い・順張り');
    expect(r.leg_label_stop).toBe('ブレイク新規・順張り');
    // 上昇トレンドで売れば、同じ2脚が逆張りになる(名札は脚の種別だけでは決まらない)。
    const r2 = writeAndRead(db, input({ direction: 'sell' }, { trendDir: 'up' }));
    expect(r2.leg_label_limit).toBe('戻り売り・逆張り');
    expect(r2.leg_label_stop).toBe('ブレイク新規・逆張り');
    db.close();
  });

  it('★② トレンドが取れない回 → 脚の型の語だけ(順張り/逆張りが付かない)', () => {
    const db = openReal();
    // ★NULL にはしない: その回も画面では「押し目買い」と呼んでいたので、事実として残す。
    for (const trendDir of ['flat', 'conflict', 'stale']) {
      const r = writeAndRead(db, input({}, { trendDir }));
      expect(r.leg_label_limit).toBe('押し目買い');
      expect(r.leg_label_stop).toBe('ブレイク新規');
    }
    // trendDir が測れなかった回(そもそも来ない)も同じ。
    const r = writeAndRead(db, input({}));
    expect(r.leg_label_limit).toBe('押し目買い');
    expect(r.leg_label_stop).toBe('ブレイク新規');
    db.close();
  });

  it('★③ 片脚だけの回 → 無い側は NULL(★空文字ではない)', () => {
    const db = openReal();
    const onlyLimit = writeAndRead(db, input({ stopEntry: undefined, stopLossForStop: undefined }, { trendDir: 'up' }));
    expect(onlyLimit.leg_label_limit).toBe('押し目買い・順張り');
    expect(onlyLimit.leg_label_stop).toBeNull();
    expect(onlyLimit.leg_label_stop).not.toBe('');          // ★「無い」と「空」を混ぜない
    const onlyStop = writeAndRead(db, input({ limitEntry: undefined, stopLossForLimit: undefined }, { trendDir: 'up' }));
    expect(onlyStop.leg_label_limit).toBeNull();
    expect(onlyStop.leg_label_stop).toBe('ブレイク新規・順張り');
    db.close();
  });

  it('★④ 脚が立たない回(見送り none / レンジ / 計画が出なかった回)は両方 NULL', () => {
    const db = openReal();
    const none = writeAndRead(db, input({ direction: 'none', limitEntry: undefined, stopEntry: undefined }));
    expect([none.leg_label_limit, none.leg_label_stop]).toEqual([null, null]);
    const range = writeAndRead(db, input({ direction: 'range', limitEntry: undefined, stopEntry: undefined }));
    expect([range.leg_label_limit, range.leg_label_stop]).toEqual([null, null]);
    insertSignalPlan(db, buildSignalPlanInsert({ t: 2, system: 'A', result: { ok: false, error: 'LLM 失敗' } } as never));
    const failed = db.prepare('SELECT * FROM signal_plans ORDER BY id DESC LIMIT 1').all()[0] as Record<string, unknown>;
    expect([failed.leg_label_limit, failed.leg_label_stop]).toEqual([null, null]);
    db.close();
  });

  it('★⑤ 値の出所は core/entryLabel.ts ひとつ(名札を再実装していない)', () => {
    const db = openReal();
    for (const direction of ['buy', 'sell'] as const) {
      for (const trendDir of [undefined, 'up', 'down', 'flat', 'conflict', 'stale'] as const) {
        const r = writeAndRead(db, input({ direction }, trendDir ? { trendDir } : {}));
        expect(r.leg_label_limit).toBe(entryLabel(direction, 'limit', trendDir).text);
        expect(r.leg_label_stop).toBe(entryLabel(direction, 'stop', trendDir).text);
      }
    }
    db.close();
  });
});

// ═══ ★DB を開いた人に読み方を届ける(column_vocab / lc_audit / tp と同じ流儀) ═══════
describe('★脚の名札の意味論が meta から読める', () => {
  const open = (): DatabaseSync => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-leglabelmeta-'));
    const db = new DatabaseSync(join(dir, 'jp225.db'));
    initSchema(db);
    return db;
  };

  it('★① 実ファイルの meta に1行入る(書く前は無い=この検査は恒真でない)', () => {
    const db = open();
    expect(getMeta(db, COLUMN_SEMANTICS_LEG_LABEL_KEY)).toBeNull();
    setLegLabelSemanticsMeta(db);
    expect(getMeta(db, COLUMN_SEMANTICS_LEG_LABEL_KEY)).toBe(COLUMN_SEMANTICS_LEG_LABEL_NOTE);
    db.close();
  });

  it('★② 中身に「AI の言葉ではない」「途中の版から」「画面には出していない」が揃っている', () => {
    const db = open();
    setLegLabelSemanticsMeta(db);
    const note = getMeta(db, COLUMN_SEMANTICS_LEG_LABEL_KEY)!;
    expect(note).toContain('AI の言葉ではありません');       // ★出所(コードが付けた名札)
    expect(note).toContain('trend_dir');
    expect(note).toContain('v0.9.105');                      // ★どの版より後に入ったか
    expect(note).toContain('NULL');                          // ★欠測期間 と 脚が無い回
    expect(note).toContain('空文字は入れていません');
    expect(note).toContain('画面には出していません');         // ★記録専用であること
    expect(note).toContain('規則が変わった証拠');             // ★再計算に頼らない理由
    db.close();
  });

  it('★③ 冪等(2回書いても1行のまま・内容も同じ)', () => {
    const db = open();
    setLegLabelSemanticsMeta(db);
    setLegLabelSemanticsMeta(db);
    const rows = db.prepare('SELECT value FROM meta WHERE key = ?').all(COLUMN_SEMANTICS_LEG_LABEL_KEY);
    expect(rows).toHaveLength(1);
    expect(getMeta(db, COLUMN_SEMANTICS_LEG_LABEL_KEY)).toBe(COLUMN_SEMANTICS_LEG_LABEL_NOTE);
    db.close();
  });

  it('★④ まだ実データに現れていない版番号を焼いていない(column_vocab / tp と同じ作法)', () => {
    const db = open();
    setLegLabelSemanticsMeta(db);
    const note = getMeta(db, COLUMN_SEMANTICS_LEG_LABEL_KEY)!;
    // ★名乗ってよいのは「v0.9.105 より **後**」だけ。出荷版が何番になるかは確定していない。
    const versions = [...new Set(note.match(/[0-9]+[.][0-9]+[.][0-9]+/g) ?? [])];
    expect(versions).toEqual(['0.9.105']);
    for (const v of ['0.9.106', '0.9.107', '1.0.0']) expect(note).not.toContain(v);
    db.close();
  });
});
