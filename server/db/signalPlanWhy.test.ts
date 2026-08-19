import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, insertSignalPlan, getSignalPlans } from './store.js';
import { buildSignalPlanInsert, PLAN_RATIONALE_MAX_CHARS, PLAN_RATIONALE_TRUNCATED_MARK } from '../signalTrade/planLedger.js';
import { parseScalpPlan } from '../llm/scalpPlan.js';

// ★記録専用(ADD-ONLY・v0.9.88): signal_plans の **レッグごとの理由** 5列。
//
// ■ なぜ列を分けるか
//   この追加の目的は **理由の量を測ること**。`length(entry_why_for_limit)` がそのまま書ける形にする。
//   1列の JSON にすると測定のたびに json_extract を挟むことになり、既存の
//   strategy_why / limit_level(意味のある値は列にする)の作法からも外れる。
//
// ■ ★長さの上限(v0.9.88 の途中で方針を変えた。理由を残す)
//   当初この5列には上限を掛けなかった(「理由の量を測るのが目的だから削らない」)。
//   これは **正常な出力しか想定していなかった** 誤り。上限が守っているのは LLM の暴走出力
//   (同じ文の反復・プロンプトの丸写し)であり、上限が無いと台帳が無制限に膨らみ、
//   画面には 5,000字が1行として描かれる。
//   ⇒ rationale と **同じ安全弁**(trimRationale / PLAN_RATIONALE_MAX_CHARS=2000 + 切詰の印)を通す。
//   実測の根拠文の最長は 319字 なので 2000 は桁で余裕があり、正常な理由には事実上効かない
//   = 測定対象は削られない。切られた回は末尾の印で分かる(無言で削らない)。
//
// ★検知・採否・価格・決済には一切関与しない(列が増えるだけ)。

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function fileDb(): { db: DatabaseSync; path: string } {
  dir = mkdtempSync(join(tmpdir(), 'jp225-plan-why-'));
  return { db: new DatabaseSync(join(dir, 'jp225.db')), path: join(dir, 'jp225.db') };
}

const COLS = [
  'direction_why', 'entry_why_for_limit', 'entry_why_for_stop', 'lc_why_for_limit', 'lc_why_for_stop',
] as const;

const REF = 68_700;
const rawPlan = (extra: Record<string, unknown>): string => JSON.stringify({
  direction: 'buy',
  limitEntry: 68_675, lcWidthForLimit: 60,
  stopEntry: 68_780, lcWidthForStop: 60,
  rationale: '押し目を拾う', refPrice: REF, ...extra,
});

describe('signal_plans: レッグごとの理由の5列', () => {
  it('新規DBに5列が在り、型は TEXT', () => {
    const { db } = fileDb();
    initSchema(db);
    const cols = db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string; type: string }>;
    for (const c of COLS) {
      const col = cols.find(x => x.name === c);
      expect(col, `${c} 列が無い`).toBeTruthy();
      expect(col!.type).toBe('TEXT');
    }
    db.close();
  });

  it('★5列を持たない既存DBへ ALTER が走り、既存行が1バイトも壊れない', () => {
    const { db } = fileDb();
    // v0.9.87 相当(5列が無い)の表を手で作り、行を1つ入れてから initSchema を当てる。
    db.exec(`CREATE TABLE signal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, system TEXT NOT NULL,
      rationale TEXT, strategy_why TEXT
    )`);
    db.prepare('INSERT INTO signal_plans (t, system, rationale, strategy_why) VALUES (?, ?, ?, ?)')
      .run(1, 'A', '既存の根拠文', '既存の読み');
    initSchema(db);
    const cols = (db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    for (const c of COLS) expect(cols).toContain(c);
    const row = db.prepare('SELECT * FROM signal_plans WHERE t = 1').get() as Record<string, unknown>;
    expect(row.rationale).toBe('既存の根拠文');
    expect(row.strategy_why).toBe('既存の読み');
    for (const c of COLS) expect(row[c], `${c} が旧行に値を持っている`).toBeNull();
    db.close();
  });

  it('★実ファイルSQLite: AI が書いた5つの理由が台帳へ入り、読み戻せる', () => {
    const { db } = fileDb();
    initSchema(db);
    const result = parseScalpPlan(rawPlan({
      directionWhy: '直近安値を切り上げ、21日線を上抜けた',
      entryWhyForLimit: '68,650 の支持帯まで引きつける',
      entryWhyForStop: '68,775 を抜けたら勢いに乗る',
      lcWhyForLimit: '直近安値の外側に置いた',
      lcWhyForStop: '節目の内側に戻る幅',
    }), REF);
    expect(result.ok).toBe(true);
    insertSignalPlan(db, buildSignalPlanInsert({ t: 10, system: 'A', result }));
    const [row] = getSignalPlans(db, 10) as unknown as Array<Record<string, unknown>>;
    expect(row!.direction_why).toBe('直近安値を切り上げ、21日線を上抜けた');
    expect(row!.entry_why_for_limit).toBe('68,650 の支持帯まで引きつける');
    expect(row!.entry_why_for_stop).toBe('68,775 を抜けたら勢いに乗る');
    expect(row!.lc_why_for_limit).toBe('直近安値の外側に置いた');
    expect(row!.lc_why_for_stop).toBe('節目の内側に戻る幅');
    // ★rationale は従来どおり別物として残る(消していない・意味も変えていない)。
    expect(row!.rationale).toBe('押し目を拾う');
    db.close();
  });

  it('★書かれなかった枠は NULL(「欠測」が形から読める。空文字を捏造しない)', () => {
    const { db } = fileDb();
    initSchema(db);
    const result = parseScalpPlan(rawPlan({ directionWhy: '上昇継続' }), REF);
    insertSignalPlan(db, buildSignalPlanInsert({ t: 11, system: 'A', result }));
    const [row] = getSignalPlans(db, 10) as unknown as Array<Record<string, unknown>>;
    expect(row!.direction_why).toBe('上昇継続');
    for (const c of ['entry_why_for_limit', 'entry_why_for_stop', 'lc_why_for_limit', 'lc_why_for_stop']) {
      expect(row![c], `${c} は NULL であるべき`).toBeNull();
    }
    db.close();
  });

  it('★暴走出力は上限で切られ、切ったことが分かる印が付く(無言で削らない)', () => {
    const { db } = fileDb();
    initSchema(db);
    const long = 'あ'.repeat(PLAN_RATIONALE_MAX_CHARS + 3_000);   // 5,000字
    const result = parseScalpPlan(rawPlan({ entryWhyForLimit: long }), REF);
    insertSignalPlan(db, buildSignalPlanInsert({ t: 12, system: 'A', result }));
    const [row] = getSignalPlans(db, 10) as unknown as Array<Record<string, unknown>>;
    const got = row!.entry_why_for_limit as string;
    expect(got.length).toBe(PLAN_RATIONALE_MAX_CHARS);          // 印を含めて上限に収まる
    expect(got.endsWith(PLAN_RATIONALE_TRUNCATED_MARK)).toBe(true);
    // ★rationale と同じ安全弁・同じ印(2つの上限が別々に育たないよう1つの関数を共有している)。
    const r2 = parseScalpPlan(rawPlan({ rationale: 'い'.repeat(PLAN_RATIONALE_MAX_CHARS + 500) }), REF);
    insertSignalPlan(db, buildSignalPlanInsert({ t: 13, system: 'A', result: r2 }));
    const [newest] = getSignalPlans(db, 1) as unknown as Array<Record<string, unknown>>;
    expect((newest!.rationale as string).endsWith(PLAN_RATIONALE_TRUNCATED_MARK)).toBe(true);
    db.close();
  });

  it('★正常な長さの理由には上限が効かない(測定対象を削っていない)', () => {
    const { db } = fileDb();
    initSchema(db);
    // 実測の根拠文の最長は 319字。実験値の 107字/脚 も当然この下。
    const normal = 'あ'.repeat(319);
    insertSignalPlan(db, buildSignalPlanInsert({
      t: 14, system: 'A', result: parseScalpPlan(rawPlan({ entryWhyForLimit: normal }), REF),
    }));
    const [row] = getSignalPlans(db, 1) as unknown as Array<Record<string, unknown>>;
    expect(row!.entry_why_for_limit).toBe(normal);
    expect((row!.entry_why_for_limit as string).includes(PLAN_RATIONALE_TRUNCATED_MARK)).toBe(false);
    db.close();
  });

  // ★v0.9.88: 画面の「順張り/逆張り」を決めた値も記録する。
  //   これが無いと、理由5列は残るのに **ラベルを決めた入力だけが消える**=
  //   「画面が何と言ったか」を後から復元できない。
  it('★trend_dir: コードが測ったトレンドの向きが台帳に残る(旧行/測れなかった回は NULL)', () => {
    const { db } = fileDb();
    initSchema(db);
    const cols = (db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string; type: string }>);
    expect(cols.find(c => c.name === 'trend_dir')?.type).toBe('TEXT');
    const result = parseScalpPlan(rawPlan({}), REF);
    insertSignalPlan(db, buildSignalPlanInsert({ t: 15, system: 'A', result: { ...result, trendDir: 'up' } as typeof result }));
    insertSignalPlan(db, buildSignalPlanInsert({ t: 16, system: 'A', result }));   // 測れなかった回
    const rows = db.prepare('SELECT t, trend_dir FROM signal_plans ORDER BY t').all() as Array<Record<string, unknown>>;
    expect(rows[0]!.trend_dir).toBe('up');
    expect(rows[1]!.trend_dir).toBeNull();
    db.close();
  });

  it('★理由の量を SQL で数えられる(この追加の目的そのもの)', () => {
    const { db } = fileDb();
    initSchema(db);
    for (const [t, why] of [[20, 'あ'.repeat(59)], [21, 'い'.repeat(107)]] as const) {
      insertSignalPlan(db, buildSignalPlanInsert({
        t, system: 'A', result: parseScalpPlan(rawPlan({ entryWhyForLimit: why }), REF),
      }));
    }
    const rows = db.prepare(
      'SELECT length(entry_why_for_limit) AS n FROM signal_plans ORDER BY t',
    ).all() as Array<{ n: number }>;
    expect(rows.map(r => r.n)).toEqual([59, 107]);
    db.close();
  });
});
