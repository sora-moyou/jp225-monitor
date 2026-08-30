import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSchema, insertSignalPlan, getMeta, setColumnVocabMeta,
  COLUMN_VOCAB_KEY, COLUMN_VOCAB_NOTE,
  setLcAuditSemanticsMeta, COLUMN_SEMANTICS_LC_AUDIT_KEY, COLUMN_SEMANTICS_LC_AUDIT_NOTE,
} from './store.js';

// ★2026-08-25(エバリュエーター指摘③): **語彙の版境界を DB から読める場所に置く**。
//
// ■ 何が問題だったか(実測)
//   `a_direction` は ALTER TABLE で足した列なので、`sqlite_master` の CREATE TABLE 文に
//   注釈が1文字も入らない。★ソースのコメントは **DB を開いた分析者には届かない**。
//   そのまま `GROUP BY a_direction` すると bull/bear の行と buy/sell の行が別カテゴリで並び、
//   「目線の分布が激変した」と誤読する——★無言で語彙が変わるのが、この案件でいちばん高くつく形。
//
// ■ このテストが固定する不変条件
//   ① 実ファイルの meta に1行入る(新しい表は作らない)
//   ② 中身に **旧の語 / 新の語 / 版の境界 / 変換していないこと / 切り分けの手段** が全部書いてある
//   ③ 冪等(何度起動しても同じ1行)
//   ④ ★sqlite_master には a_direction の注釈が無いこと(=この meta が唯一の出所である根拠)

const ROOT = mkdtempSync(join(tmpdir(), 'jp225-vocab-meta-'));
let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(join(ROOT, `${Date.now()}-${Math.random()}.db`));
  initSchema(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });
afterEach(() => { /* ROOT はプロセス終了時に OS が掃除する(テスト間で消さない) */ });

describe('★語彙の版境界が meta から読める(DB だけで完結する)', () => {
  it('① 実ファイルの meta に1行入る', () => {
    expect(getMeta(db, COLUMN_VOCAB_KEY)).toBeNull();   // 書く前は無い(この検査が恒真でない)
    setColumnVocabMeta(db);
    expect(getMeta(db, COLUMN_VOCAB_KEY)).toBe(COLUMN_VOCAB_NOTE);
  });

  it('② 中身に 旧の語 / 新の語 / 境界 / 変換していないこと / 切り分けの手段 が揃っている', () => {
    setColumnVocabMeta(db);
    const note = getMeta(db, COLUMN_VOCAB_KEY)!;
    expect(note).toContain('signal_plans.a_direction');
    expect(note).toContain('bull / bear / range');      // 旧
    expect(note).toContain('buy / sell / range');       // 新
    expect(note).toContain('v0.9.98 まで');              // 境界(旧側)
    expect(note).toContain('v0.9.98 より後');             // 境界(新側)
    // ★★**まだ出していない版番号を DB に焼かない**(下の専用 it で全部数える)。
    expect(note).toContain('過去行は変換していません');
    expect(note).toContain('app_version');
    expect(note).toContain('a_prompt_build');
  });

  it('③ 冪等(2回書いても1行のまま・内容も同じ)', () => {
    setColumnVocabMeta(db);
    setColumnVocabMeta(db);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM meta WHERE key = ?').all(COLUMN_VOCAB_KEY) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
    expect(getMeta(db, COLUMN_VOCAB_KEY)).toBe(COLUMN_VOCAB_NOTE);
  });

  it('④ ★sqlite_master には a_direction の注釈が無い(=この meta が唯一の出所)', () => {
    const rows = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='signal_plans'",
    ).all() as Array<{ sql: string | null }>;
    const sql = rows[0]?.sql ?? '';
    expect(sql.length).toBeGreaterThan(0);
    // ★列そのものは在る(ALTER で足したので CREATE 文には出ないこともある)。注釈が無いことが要点。
    expect(sql).not.toContain('bull');
    expect(sql).not.toContain('v0.9.98');
  });

  it('⑤ 行が1件も無い日でも読める(meta は行数に依らない=そもそもの目的)', () => {
    setColumnVocabMeta(db);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM signal_plans').all() as Array<{ n: number }>)[0]!.n;
    expect(n).toBe(0);
    expect(getMeta(db, COLUMN_VOCAB_KEY)).toContain('a_direction');
  });

  it('⑥ 新しい語が実際に入った行と並べて読める(注釈と実データが噛み合う)', () => {
    setColumnVocabMeta(db);
    insertSignalPlan(db, { t: 1, system: 'A', direction: 'buy', aDirection: 'buy', bVariant: 'buy' });
    const rows = db.prepare('SELECT a_direction FROM signal_plans').all() as Array<{ a_direction: string | null }>;
    expect(rows[0]!.a_direction).toBe('buy');
    expect(getMeta(db, COLUMN_VOCAB_KEY)).toContain('buy / sell / range');
  });
});

// ═══ ★★② DB に焼く1行に「まだ出していない版番号」を入れない ═══════════════
//
// ■ ★なぜ厳しく数えるか(2026-08-25・リーダー裁定)
//   この文字列は **DB に焼かれ、後から直せない**。
//   ★同じ作業ツリーの中で版番号が3つに割れていた(v0.9.99 / v0.9.100 / v0.9.101)一方で、
//     版ファイル(package.json / tauri.conf / Cargo.toml)は 0.9.98 のままだった。
//   ★実DB の出荷実績も 0.9.92〜0.9.98 だけ。**0.9.99 も 0.9.100 も一度も走っていない**。
//   → 確定しているのは「bull/bear は v0.9.98 で終わり」だけ。それだけを書く。
//   ★「v0.9.98 より後」なら、出荷版が何番になっても嘘にならない。
describe('★★② 語彙の注記に 未出荷の版番号が1つも入っていない', () => {
  /** 注記に現れる版番号を全部拾う(x.y.z 形式)。 */
  const versionsIn = (s: string): string[] =>
    [...new Set((s.match(/\d+\.\d+\.\d+/g) ?? []))];

  it('★注記に出てくる版番号は v0.9.98 の1つだけ(=既に出荷済みの版)', () => {
    setColumnVocabMeta(db);
    const note = getMeta(db, COLUMN_VOCAB_KEY)!;
    expect(versionsIn(note)).toEqual(['0.9.98']);
  });

  it('★実ファイルの meta を読み直しても未出荷の版番号が入っていない(DB に焼かれる当のもの)', () => {
    setColumnVocabMeta(db);
    const note = getMeta(db, COLUMN_VOCAB_KEY)!;
    for (const v of ['0.9.99', '0.9.100', '0.9.101', '1.0.0']) {
      expect(note, `未出荷の版番号 ${v} が DB に焼かれている`).not.toContain(v);
    }
  });

  it('★境界は「v0.9.98 まで / v0.9.98 より後」の形(番号を名乗らない)', () => {
    setColumnVocabMeta(db);
    const note = getMeta(db, COLUMN_VOCAB_KEY)!;
    expect(note).toContain('v0.9.98 まで');
    expect(note).toContain('v0.9.98 より後');
    expect(note).not.toContain('以降(');   // 「vX 以降」で新番号を名乗る形に戻ったら赤
  });

  it('★この検査が恒真でない(版番号を1つ足したら捕まる)', () => {
    const fake = `${COLUMN_VOCAB_NOTE} なお v0.9.101 から有効です。`;
    expect(versionsIn(fake)).toContain('0.9.101');
  });
});

afterEach(() => { /* keep */ });
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

// ═══ ★2026-08-30: lc_audit_json の意味論も DB の中から読める ═══════════════════
//
// ■ 何を防ぐか
//   `lc_audit_json` は **ずらしの前** の生の申告に対して採るのに、`rationale` 列は
//   **ずらしの後** に幅の数字が書き換わりうる。この2列を突き合わせた分析者は
//   「監査が壊れている」と誤読する。★ソースのコメントは DB を開いた人に届かない。
// ■ もう1つ: v0.9.96〜v0.9.102 は配線漏れで **全行 NULL**。欠測を「AI が変わった」と読ませない。
describe('★lc_audit_json の意味論が meta から読める', () => {
  it('① 実ファイルの meta に1行入る(書く前は無い=この検査は恒真でない)', () => {
    expect(getMeta(db, COLUMN_SEMANTICS_LC_AUDIT_KEY)).toBeNull();
    setLcAuditSemanticsMeta(db);
    expect(getMeta(db, COLUMN_SEMANTICS_LC_AUDIT_KEY)).toBe(COLUMN_SEMANTICS_LC_AUDIT_NOTE);
  });

  it('② 中身に 採る時点 / rationale 列とのズレ / それが仕様であること / 欠測期間 が揃っている', () => {
    setLcAuditSemanticsMeta(db);
    const note = getMeta(db, COLUMN_SEMANTICS_LC_AUDIT_KEY)!;
    expect(note).toContain('signal_plans.lc_audit_json');
    expect(note).toContain('生の申告');
    expect(note).toContain('前');            // ★ずらしの「前」に採る
    expect(note).toContain('rationale');
    expect(note).toContain('書き換わっている場合があります');
    expect(note).toContain('仕様');          // ★食い違いは欠陥ではない
    expect(note).toContain('NULL');          // ★欠測期間
  });

  it('③ 冪等(2回書いても1行のまま)', () => {
    setLcAuditSemanticsMeta(db);
    setLcAuditSemanticsMeta(db);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM meta WHERE key = ?')
      .all(COLUMN_SEMANTICS_LC_AUDIT_KEY) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });

  it('④ ★column_vocab を1バイトも汚していない(別のキー・別の意味論)', () => {
    setColumnVocabMeta(db);
    setLcAuditSemanticsMeta(db);
    expect(getMeta(db, COLUMN_VOCAB_KEY)).toBe(COLUMN_VOCAB_NOTE);
    expect(COLUMN_SEMANTICS_LC_AUDIT_KEY).not.toBe(COLUMN_VOCAB_KEY);
  });

  it('★★⑤ まだ実データに現れていない版番号を焼いていない(column_vocab と同じ作法)', () => {
    setLcAuditSemanticsMeta(db);
    const note = getMeta(db, COLUMN_SEMANTICS_LC_AUDIT_KEY)!;
    const versions = [...new Set((note.match(/\d+\.\d+\.\d+/g) ?? []))].sort();
    // ★実DB(複製)に出ている版は 0.9.92〜0.9.102。それ以外は名乗らない。
    expect(versions).toEqual(['0.9.102', '0.9.96']);
    for (const v of ['0.9.103', '0.9.104', '1.0.0']) expect(note).not.toContain(v);
  });
});
