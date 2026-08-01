import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, insertSignalTrade, getSignalTrades } from '../db/store.js';
import { _setExitImpl, computeExitStop, type ExitState } from './exit/index.js';
import {
  computeExitConfigHash, resolveExitConfigVersion, exitConfigStamp, _resetExitConfigHashCache,
} from './exitConfigVersion.js';
import { buildSignalTradeInsert } from './persist.js';
import type { RecordedTrade } from './decisions.js';

// ★この記録が守る契約:
//   ① 決済設定の **値そのものは記録しない**(記録は同期フォルダ経由で機外に出る)。ハッシュだけ。
//   ② 単調増加の整数版番号をハッシュとは別に持つ(ハッシュだけでは順序が読めない)。
//   ③ 値が固定の今から記録を始める(今日から version=1)。後から始めると、それ以前の行が
//      「版が不明」なのか「版1」なのか区別できなくなる。

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}

afterEach(() => { _setExitImpl(null); _resetExitConfigHashCache(); });

describe('決済設定ハッシュ(振る舞い指紋)', () => {
  it('16桁の hex(同じ実装なら毎回同じ)', () => {
    const a = computeExitConfigHash();
    const b = computeExitConfigHash();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
  });

  it('決済関数の振る舞いが変わればハッシュも変わる', () => {
    const base = computeExitConfigHash();
    // ラダーを1段だけ変えた実装(=設定変更に相当)
    _setExitImpl((s: ExitState) => (s.peakProfit >= 77
      ? (s.direction === 'buy' ? s.entryPrice + 13 : s.entryPrice - 13)
      : s.initialStop));
    const changed = computeExitConfigHash();
    expect(changed).not.toBe(base);
    // 元に戻せばハッシュも戻る(同一設定は同一指紋)
    _setExitImpl(null);
    expect(computeExitConfigHash()).toBe(base);
  });

  it('試打は決済関数を汚さない(純粋な読み取りのみ・前後で出力が一致)', () => {
    const probe: ExitState = { direction: 'buy', entryPrice: 38000, initialStop: 37950, peakProfit: 120 };
    const before = computeExitStop(probe);
    computeExitConfigHash();
    expect(computeExitStop(probe)).toBe(before);
  });
});

describe('版番号(単調増加・ハッシュとは別)', () => {
  it('初出は 1、同じハッシュは同じ版、別ハッシュは +1、戻せば元の版', () => {
    const db = memDb();
    const now = 1_700_000_000_000;
    expect(resolveExitConfigVersion(db, 'aaaaaaaaaaaaaaaa', now)).toBe(1);
    expect(resolveExitConfigVersion(db, 'aaaaaaaaaaaaaaaa', now + 1)).toBe(1);
    expect(resolveExitConfigVersion(db, 'bbbbbbbbbbbbbbbb', now + 2)).toBe(2);
    expect(resolveExitConfigVersion(db, 'cccccccccccccccc', now + 3)).toBe(3);
    expect(resolveExitConfigVersion(db, 'aaaaaaaaaaaaaaaa', now + 4)).toBe(1);   // 設定を戻したら版も戻る
  });

  it('初出時刻(first_seen)を残す', () => {
    const db = memDb();
    resolveExitConfigVersion(db, 'aaaaaaaaaaaaaaaa', 12345);
    const row = db.prepare('SELECT version, first_seen FROM exit_config_versions WHERE hash = ?')
      .get('aaaaaaaaaaaaaaaa') as { version: number; first_seen: number };
    expect(row).toEqual({ version: 1, first_seen: 12345 });
  });

  it('exitConfigStamp は今日から version=1 を返す(値が固定の今から記録を始める)', () => {
    const db = memDb();
    const stamp = exitConfigStamp(db, 1_700_000_000_000);
    expect(stamp).not.toBeNull();
    expect(stamp!.version).toBe(1);
    expect(stamp!.hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('signal_trades への記録', () => {
  const rt = (): RecordedTrade => ({
    entryT: 1000, entryPrice: 38000, dir: 'buy', exitT: 2000, exitPrice: 38047,
    pnl: 47, qty: 1, rationale: 'x',
    exitReason: 'exit_stop', exitInitialStop: 37962, peakProfit: 61,
  } as unknown as RecordedTrade);

  it('exit_cfg_version / exit_cfg_hash 列が存在する(冪等マイグレーション)', () => {
    const db = memDb();
    initSchema(db);
    const cols = (db.prepare('PRAGMA table_info(signal_trades)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('exit_cfg_version');
    expect(cols).toContain('exit_cfg_hash');
  });

  it('版を渡すと2列に載る / 未指定は NULL(旧行と後方互換)', () => {
    const db = memDb();
    insertSignalTrade(db, buildSignalTradeInsert(rt(), null, 7, { version: 3, hash: 'deadbeefdeadbeef' }));
    insertSignalTrade(db, buildSignalTradeInsert({ ...rt(), entryT: 3000, exitT: 4000 } as RecordedTrade, null, 8));
    const rows = getSignalTrades(db).sort((a, b) => a.exit_t - b.exit_t);
    expect(rows[0]!.exit_cfg_version).toBe(3);
    expect(rows[0]!.exit_cfg_hash).toBe('deadbeefdeadbeef');
    expect(rows[1]!.exit_cfg_version).toBeNull();
    expect(rows[1]!.exit_cfg_hash).toBeNull();
  });

  it('★決済ラダーの実数値は1つも列に入らない(ハッシュと整数版番号だけ)', () => {
    const db = memDb();
    const stamp = exitConfigStamp(db, 5000)!;
    insertSignalTrade(db, buildSignalTradeInsert(rt(), null, 1, stamp));
    const row = getSignalTrades(db)[0]!;
    // 版番号は小さな連番、ハッシュは16桁hex。設定値らしき数値も文字列も混じらない。
    expect(row.exit_cfg_version).toBe(1);
    expect(row.exit_cfg_hash).toMatch(/^[0-9a-f]{16}$/);
    // 実際に private が読み込まれた環境でも、ラダーの実数値が hash に平文で現れない。
    // ハッシュは16桁hexなので、そもそも十進の設定値を含み得ない(この検査は形式で担保する)。
    expect(row.exit_cfg_hash!).not.toMatch(/[^0-9a-f]/);
  });
});
