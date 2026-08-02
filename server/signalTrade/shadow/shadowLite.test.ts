import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowSim } from './sim.js';
import { openShadowDb } from '../../db/shadowStore.js';

// ─── 公開版(lite)では影の決済模擬の **入口が閉じている** ─────────────────────────
//
// 影(決済パラメータを振った模擬)は分析専用。現時点で取引経路からは未配線なので lite が今日
// 壊れることは無い。将来うっかり配線されたときに、公開版で黙って専用 DB が増え続けるより
// 開発中に大きな音で落ちる方が良い(このプロジェクトの「無音の失敗は欠陥」に従う)。
//
// ★否定対照(修正前の shadow/sim.ts・db/shadowStore.ts): lite でも構築でき DB も開ける → 本ファイルが赤。
//   実証手順: git show HEAD:<path> でファイルを差し替えて実行。

describe('影の決済模擬 — lite では入口が閉じている', () => {
  const saved = process.env.MONITOR_VARIANT;
  beforeEach(() => { delete process.env.MONITOR_VARIANT; });
  afterEach(() => {
    if (saved === undefined) delete process.env.MONITOR_VARIANT;
    else process.env.MONITOR_VARIANT = saved;
  });

  it('lite: ShadowSim は構築できない', () => {
    process.env.MONITOR_VARIANT = 'lite';
    expect(() => new ShadowSim({ ladder: () => ({ epoch: 'none', specs: [] }) })).toThrow(/分析専用/);
  });

  it('lite: 影の記録 DB は開けない(専用ファイルを作らない)', () => {
    process.env.MONITOR_VARIANT = 'lite';
    expect(() => openShadowDb(':memory:')).toThrow(/分析専用/);
  });

  it('★full(未設定): 従来どおり構築でき、DB も開ける', () => {
    delete process.env.MONITOR_VARIANT;
    const sim = new ShadowSim({ ladder: () => ({ epoch: 'none', specs: [] }), log: () => { /* 静かに */ } });
    expect(sim.openShadows).toBe(0);
    const db = openShadowDb(':memory:');
    expect(db).toBeDefined();
    db.close();
  });
});
