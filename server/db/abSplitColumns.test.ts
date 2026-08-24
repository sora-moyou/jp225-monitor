import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, insertSignalPlan, getSignalPlans } from './store.js';
import { pickNoneReason, legDropReasonText, type NoneReason } from '../llm/scalpPlan.js';

// ★記録専用(ADD-ONLY・v0.9.97): signal_plans の A/B 分割用8列 + none_reason の2語彙。
//
// ■ なぜ **分割より先に** 列を入れるか
//   いま「取引しなかった」は none_reason='ai'(実測 33.9%)に4つの別ものが潰れている:
//     ① AI が目線を見つけられなかった / ② こちらの設定でレンジを取引しない /
//     ③ AI が「置けない」と理由つきで言った / ④ AI は答えたがコードの検証で落ちた。
//   ★分割してから列を足すと、分割の前後で同じ土俵の比較ができない(測定の断絶)。
//
// ■ このテストが固定する不変条件
//   ① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない) / ② 旧行は NULL のまま
//   ③ 値が実際に入る / ④ ★'none' と NULL を分ける(呼ばないと決めた ≠ この列を持たない版)
//   ⑤ ★0 と NULL を分ける(数えて0回 ≠ 数えていない)
//   ⑥ ★squeeze_unavailable が無いと「測れなかった」が「スクイーズでなかった」に化ける
//   ⑦ ★aFailed / aiSilent は 'ai' に潰れない(故障が「相場が悪かった」に化けない)
//   ⑧ ★設計の芯: ①②③④ が別々の列/値で数えられる
// ★検知・採否・価格・veto・決済には一切関与しない(列が増えるだけ)。

let dir = '';
afterEach(() => {
  // ★Windows: 失敗で db.close() を飛ばした回に EPERM が出て、本来の失敗が隠れる。
  //   後片付けの失敗でテストを落とさない(片付けは検査対象ではない)。
  if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 一時ディレクトリの残骸は無害 */ } }
  dir = '';
});
const cols = (db: DatabaseSync, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);

const NEW_COLS = [
  'a_direction', 'a_why', 'b_variant', 'squeeze_state',
  'squeeze_unavailable', 'b_strategy', 'ai_why', 'tool_calls',
] as const;

// ★段5: A/B それぞれを答えたプロバイダ/モデルと、それぞれのプロンプトの型の指紋(6列)。
const STAGE5_COLS = [
  'a_provider', 'a_provider_model', 'b_provider', 'b_provider_model',
  'a_prompt_build', 'b_prompt_build',
] as const;

/** v0.9.96 相当(= 新8列を持たない)signal_plans を手で作る。 */
function oldDb(): DatabaseSync {
  dir = mkdtempSync(join(tmpdir(), 'jp225-absplit-'));
  const db = new DatabaseSync(join(dir, 'jp225.db'));
  db.exec(`
    CREATE TABLE signal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, system TEXT NOT NULL,
      signal_id INTEGER, direction TEXT, none_reason TEXT, veto_fired INTEGER, ref_price REAL,
      regime TEXT, confidence REAL, limit_entry REAL, stop_entry REAL,
      stop_loss_for_limit REAL, stop_loss_for_stop REAL, leg_drops_json TEXT, settings_json TEXT,
      rationale TEXT, error TEXT, drift_yen REAL, stale_legs INTEGER
    );
  `);
  db.prepare('INSERT INTO signal_plans (t, system, direction, none_reason) VALUES (?,?,?,?)')
    .run(1, 'A', 'none', 'ai');
  return db;
}

describe('signal_plans: A/B 分割の測定台8列(実ファイル SQLite)', () => {
  it('① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない)', () => {
    const db = oldDb();
    for (const c of NEW_COLS) expect(cols(db, 'signal_plans')).not.toContain(c);
    initSchema(db);
    initSchema(db);   // ★2回目=冪等
    for (const c of NEW_COLS) expect(cols(db, 'signal_plans')).toContain(c);
    db.close();
  });

  it('★新規DB(CREATE 経路)にも同じ8列がある(ALTER 経路と食い違わない)', () => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-absplit-new-'));
    const db = new DatabaseSync(join(dir, 'fresh.db'));
    initSchema(db);
    for (const c of NEW_COLS) expect(cols(db, 'signal_plans')).toContain(c);
    db.close();
  });

  it('②③ 旧行は NULL のまま / 新しい行には実際に値が入る', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, {
      t: 2, system: 'A', direction: 'buy',
      aDirection: 'buy', aWhy: '高値切り上げが3本続いている',
      bVariant: 'buy', squeezeState: null, squeezeUnavailable: null,
      bStrategy: '押し目を節目手前で拾う', aiWhy: null, toolCalls: 0,
    });
    const rows = db.prepare(
      `SELECT ${NEW_COLS.join(', ')} FROM signal_plans ORDER BY id`,
    ).all() as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      a_direction: null, a_why: null, b_variant: null, squeeze_state: null,
      squeeze_unavailable: null, b_strategy: null, ai_why: null, tool_calls: null,
    });
    expect(rows[1]).toEqual({
      a_direction: 'buy', a_why: '高値切り上げが3本続いている', b_variant: 'buy',
      squeeze_state: null, squeeze_unavailable: null,
      b_strategy: '押し目を節目手前で拾う', ai_why: null, tool_calls: 0,
    });
    db.close();
  });

  it("④ ★b_variant の 'none'(呼ばないと決めた) と NULL(この列を持たない版) が別物として残る", () => {
    const db = oldDb();
    initSchema(db);
    // レンジ不許可で注文側を呼ばなかった回
    insertSignalPlan(db, { t: 2, system: 'A', aDirection: 'range', bVariant: 'none', noneReason: 'rangeDisabled' });
    // 列を持たない版で記録された回(=未指定)
    insertSignalPlan(db, { t: 3, system: 'A' });
    const rows = db.prepare('SELECT b_variant FROM signal_plans WHERE t >= 2 ORDER BY t')
      .all() as Array<{ b_variant: string | null }>;
    expect(rows.map(r => r.b_variant)).toEqual(['none', null]);
    // ★SQL で区別できること(これが目的)
    const n = (db.prepare("SELECT COUNT(*) c FROM signal_plans WHERE b_variant = 'none'").get() as { c: number }).c;
    expect(n).toBe(1);
    db.close();
  });

  it('⑤ ★tool_calls の 0(数えて0回) と NULL(数えていない) が別物として残る', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 2, system: 'A', toolCalls: 0 });
    insertSignalPlan(db, { t: 3, system: 'A' });                       // 未指定
    insertSignalPlan(db, { t: 4, system: 'A', toolCalls: Number.NaN }); // 非有限
    insertSignalPlan(db, { t: 5, system: 'A', toolCalls: 3 });
    const v = (db.prepare('SELECT tool_calls FROM signal_plans WHERE t >= 2 ORDER BY t')
      .all() as Array<{ tool_calls: number | null }>).map(r => r.tool_calls);
    expect(v).toEqual([0, null, null, 3]);
    db.close();
  });

  it('⑥ ★「測れなかった」と「スクイーズでなかった」が区別できる', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 2, system: 'A', bVariant: 'range-breakout', squeezeState: 'squeeze' });
    insertSignalPlan(db, { t: 3, system: 'A', bVariant: 'range-fade', squeezeState: 'bulge' });
    insertSignalPlan(db, { t: 4, system: 'A', bVariant: 'range-fade' });                                   // どちらでもない
    insertSignalPlan(db, { t: 5, system: 'A', bVariant: 'range-fade', squeezeUnavailable: 'ready_false' }); // 測れなかった
    insertSignalPlan(db, { t: 6, system: 'A', bVariant: 'range-fade', squeezeUnavailable: 'closed' });
    insertSignalPlan(db, { t: 7, system: 'A', bVariant: 'range-fade', squeezeUnavailable: 'disabled' });
    const rows = db.prepare('SELECT squeeze_state, squeeze_unavailable FROM signal_plans WHERE t >= 2 ORDER BY t')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { squeeze_state: 'squeeze', squeeze_unavailable: null },
      { squeeze_state: 'bulge', squeeze_unavailable: null },
      { squeeze_state: null, squeeze_unavailable: null },          // ★スクイーズでなかった
      { squeeze_state: null, squeeze_unavailable: 'ready_false' }, // ★測れなかった
      { squeeze_state: null, squeeze_unavailable: 'closed' },
      { squeeze_state: null, squeeze_unavailable: 'disabled' },
    ]);
    // ★fade を渡した5回のうち、理由が 'bulge' と読めたのは1回だけ。
    //   残り4回は squeeze_state が NULL = 「bulge でなかった」のか「測れなかった」のかは
    //   ★squeeze_unavailable を見ないと分からない(この列が無いと3回の測定不能が消える)。
    const fadeNoState = (db.prepare(
      "SELECT COUNT(*) c FROM signal_plans WHERE b_variant = 'range-fade' AND squeeze_state IS NULL",
    ).get() as { c: number }).c;
    expect(fadeNoState).toBe(4);
    const fadeUnavailable = (db.prepare(
      "SELECT COUNT(*) c FROM signal_plans WHERE b_variant = 'range-fade' AND squeeze_unavailable IS NOT NULL",
    ).get() as { c: number }).c;
    expect(fadeUnavailable).toBe(3);
    db.close();
  });

  it('★ai_why / b_strategy は自由文をそのまま残す(改行も落とさない)', () => {
    const db = oldDb();
    initSchema(db);
    const why = 'あ) 上に置ける節目が無い\nい) 下は本日安値まで遠すぎる';
    insertSignalPlan(db, { t: 2, system: 'A', direction: 'none', noneReason: 'ai', aiWhy: why });
    const r = db.prepare('SELECT ai_why FROM signal_plans WHERE t = 2').get() as { ai_why: string };
    expect(r.ai_why).toBe(why);
    db.close();
  });

  it('★getSignalPlans(SELECT *)から新列が読める(読み出し経路も通っている)', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 9, system: 'A', aDirection: 'sell', bVariant: 'sell', toolCalls: 2 });
    const [row] = getSignalPlans(db, 1, 'A');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.a_direction).toBe('sell');
    expect(row.b_variant).toBe('sell');
    expect(row.tool_calls).toBe(2);
    expect(row.a_why).toBeNull();
    db.close();
  });

  it('⑧ ★設計の芯: ①②③④ が別々に数えられる', () => {
    const db = oldDb();
    initSchema(db);
    // ① 目線がレンジ(2回)・うち ② 呼ばなかった(1回)
    insertSignalPlan(db, { t: 2, system: 'A', aDirection: 'range', bVariant: 'none', noneReason: 'rangeDisabled' });
    insertSignalPlan(db, { t: 3, system: 'A', aDirection: 'range', bVariant: 'range-fade' });
    // ③ 理由つきの見送り
    insertSignalPlan(db, { t: 4, system: 'A', aDirection: 'buy', bVariant: 'buy', noneReason: 'ai', aiWhy: '節目が遠い' });
    // ④ コードの検証で落ちた
    insertSignalPlan(db, { t: 5, system: 'A', aDirection: 'buy', bVariant: 'buy', noneReason: 'geometry' });
    // 故障
    insertSignalPlan(db, { t: 6, system: 'A', noneReason: 'aFailed' });
    insertSignalPlan(db, { t: 7, system: 'A', aDirection: 'buy', bVariant: 'buy', noneReason: 'aiSilent' });
    const c = (sql: string) => (db.prepare(`SELECT COUNT(*) c FROM signal_plans WHERE ${sql}`).get() as { c: number }).c;
    expect(c("a_direction = 'range'")).toBe(2);                                                   // ①
    expect(c("a_direction = 'range' AND b_variant = 'none'")).toBe(1);                            // ②
    expect(c("none_reason = 'ai' AND ai_why IS NOT NULL")).toBe(1);                               // ③
    expect(c("none_reason IN ('geometry','lcWidthInvalid','stopSide','lc','lcFloor')")).toBe(1);  // ④
    expect(c("none_reason IN ('aFailed','aiSilent')")).toBe(2);                                   // 故障
    // ★旧行(none_reason='ai' で ai_why が無い)は ③ に数えられない=版で切る必要がある
    expect(c("none_reason = 'ai'")).toBe(2);
    db.close();
  });
});

describe('signal_plans: ★段5の測定台6列(A/B それぞれのプロバイダ・プロンプトの型・実ファイル SQLite)', () => {
  it('① 旧スキーマ(段1より前・段5の6列を持たない)に冪等 ALTER が通る(2回走らせても壊れない)', () => {
    const db = oldDb();
    for (const c of STAGE5_COLS) expect(cols(db, 'signal_plans')).not.toContain(c);
    initSchema(db);
    initSchema(db);   // ★2回目=冪等
    for (const c of STAGE5_COLS) expect(cols(db, 'signal_plans')).toContain(c);
    db.close();
  });

  it('★新規DB(CREATE 経路)にも同じ6列がある(ALTER 経路と食い違わない)', () => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-absplit-stage5-'));
    const db = new DatabaseSync(join(dir, 'fresh.db'));
    initSchema(db);
    for (const c of STAGE5_COLS) expect(cols(db, 'signal_plans')).toContain(c);
    db.close();
  });

  it('②③ 旧行は NULL のまま / 新しい行には A と B で別々のプロバイダ・プロンプト型が入る', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, {
      t: 2, system: 'A', direction: 'buy',
      aDirection: 'buy', bVariant: 'buy',
      aProvider: 'gemini', aProviderModel: 'gemini-flash',
      bProvider: 'groq', bProviderModel: 'llama-70b',
      aPromptBuild: 'pb1:aaaaaaaaaaaaaaaa', bPromptBuild: 'pb1:bbbbbbbbbbbbbbbb',
    });
    const rows = db.prepare(
      `SELECT ${STAGE5_COLS.join(', ')} FROM signal_plans ORDER BY id`,
    ).all() as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      a_provider: null, a_provider_model: null, b_provider: null, b_provider_model: null,
      a_prompt_build: null, b_prompt_build: null,
    });
    // ★これが設計の芯: A と B が別プロバイダ/別の指紋で答えても、片方に潰れず両方が別列に残る。
    expect(rows[1]).toEqual({
      a_provider: 'gemini', a_provider_model: 'gemini-flash',
      b_provider: 'groq', b_provider_model: 'llama-70b',
      a_prompt_build: 'pb1:aaaaaaaaaaaaaaaa', b_prompt_build: 'pb1:bbbbbbbbbbbbbbbb',
    });
    db.close();
  });

  it("★b_variant='none'(B を呼ばなかった)回は b_provider/b_prompt_build が NULL のまま", () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, {
      t: 2, system: 'A', aDirection: 'range', bVariant: 'none',
      aProvider: 'gemini', aProviderModel: 'gemini-flash', aPromptBuild: 'pb1:aaaaaaaaaaaaaaaa',
    });
    const r = db.prepare(
      'SELECT a_provider, b_provider, a_prompt_build, b_prompt_build FROM signal_plans WHERE t = 2',
    ).get() as Record<string, unknown>;
    expect(r).toEqual({
      a_provider: 'gemini', b_provider: null,
      a_prompt_build: 'pb1:aaaaaaaaaaaaaaaa', b_prompt_build: null,
    });
    db.close();
  });

  it('★SQL で「A と B が違うプロバイダだった回」を数えられる(設計の芯そのもの)', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 2, system: 'A', bVariant: 'buy', aProvider: 'gemini', bProvider: 'groq' });
    insertSignalPlan(db, { t: 3, system: 'A', bVariant: 'sell', aProvider: 'gemini', bProvider: 'gemini' });
    insertSignalPlan(db, { t: 4, system: 'A', bVariant: 'none', aProvider: 'gemini' });   // B 無し
    const n = (db.prepare(
      "SELECT COUNT(*) c FROM signal_plans WHERE a_provider IS NOT NULL AND b_provider IS NOT NULL AND a_provider != b_provider",
    ).get() as { c: number }).c;
    expect(n).toBe(1);
    db.close();
  });

  it('★getSignalPlans(SELECT *)から6列とも読める(読み出し経路も通っている)', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, {
      t: 9, system: 'A', aProvider: 'gemini', aProviderModel: 'gemini-flash',
      bProvider: 'groq', bProviderModel: 'llama-70b',
      aPromptBuild: 'pb1:aaaaaaaaaaaaaaaa', bPromptBuild: 'pb1:bbbbbbbbbbbbbbbb',
    });
    const [row] = getSignalPlans(db, 1, 'A');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.a_provider).toBe('gemini');
    expect(row.a_provider_model).toBe('gemini-flash');
    expect(row.b_provider).toBe('groq');
    expect(row.b_provider_model).toBe('llama-70b');
    expect(row.a_prompt_build).toBe('pb1:aaaaaaaaaaaaaaaa');
    expect(row.b_prompt_build).toBe('pb1:bbbbbbbbbbbbbbbb');
    db.close();
  });
});

describe('none_reason の語彙: aFailed / aiSilent', () => {
  it("⑦ ★'ai' に潰れない(故障が「相場が悪かった」に化けない)", () => {
    // pickNoneReason は2レッグの理由から1つ選ぶ。★別の語なので互いに吸収されない。
    expect(pickNoneReason('aFailed', 'ai')).toBe('aFailed');       // 故障は最上流
    expect(pickNoneReason('ai', 'aiSilent')).toBe('ai');           // 文で言った方を優先
    expect(pickNoneReason('aiSilent', null)).toBe('aiSilent');
    expect(pickNoneReason('aFailed', 'trend')).toBe('aFailed');    // 目線が無いので下流は成立しない
  });

  it('★表示文が用意されている(画面に undefined を出さない)', () => {
    for (const r of ['aFailed', 'aiSilent'] as NoneReason[]) {
      const t = legDropReasonText(r);
      expect(t).not.toBe('理由不明');
      expect(t.length).toBeGreaterThan(0);
    }
  });

  it('★既存の語彙の順序を壊していない(旧記録の代表理由が変わらない)', () => {
    // v0.9.96 までの並びで効いていた優先関係をそのまま固定する。
    expect(pickNoneReason('trend', 'ai')).toBe('trend');
    expect(pickNoneReason('lc', 'stopSide')).toBe('lc');
    expect(pickNoneReason('geometry', 'lcWidthInvalid')).toBe('geometry');
    expect(pickNoneReason('missing', 'rangeDisabled')).toBe('missing');
    expect(pickNoneReason('ai', 'stale')).toBe('ai');
  });
});
