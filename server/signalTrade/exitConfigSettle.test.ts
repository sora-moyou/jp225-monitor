import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../db/store.js';
import {
  loadExitImpl, exitImplLoadPending, exitImplStatus,
  computeExitStop, computeExitStopSimple, _setExitImpl, type ExitState,
} from './exit/index.js';
import {
  exitConfigHashOrNull, exitConfigStamp, warmExitConfigHash, computeExitConfigHash,
  computeExitConfigHashWith, publicFallbackExitConfigHash, resolveExitConfigVersion,
  lookupExitConfigVersion, markFallbackExitConfigVersion, _resetExitConfigHashCache,
} from './exitConfigVersion.js';

// ★何を守っているか(実運用で起きた事故そのもの)
//
//   server/index.ts の起動は
//     ① void loadExitImpl()      … **完了を待たない**(非公開実装の import は in-flight)
//     ② void startSignalEngine() … engine.start() の `await loadExitImpl()` は
//                                  「2人目は待たせない」早期 return で **'simple' を即受領**
//     ③ engine.start() が warmExitConfigHash() を呼ぶ
//   という順序で、③ が **公開フォールバックの指紋** をキャッシュに焼き付けていた。焼き付いた値は
//   プロセスの寿命のあいだ返り続けるので、① が非公開実装を読み終えた後も、版台帳の採番・取引に刻む版・
//   /api/status・生成器の runs が **全部その嘘の指紋** になる(1年ぶんの標本が別ラベルで積まれる)。
//
//   → 「実装が確定するまで指紋を確定させない」。未確定のあいだは **答えない・焼かない・刻まない**。
//
// ★このファイルは公開リポにも載る。決済の実数値は一切書かない・一切 assert しない。

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}

// ─── ①〜③ をこのファイルの先頭で **実際に** 再現する(窓は一度きりなので観測もここで取る) ───
const windowDb = memDb();
const loading = loadExitImpl();                        // ① 待たない
const inWindow = {
  pending: exitImplLoadPending(),
  kindSeenByEngine: exitImplStatus(),                  // ② engine が待たずに受け取る「実態」
  hash: exitConfigHashOrNull(),
  stamp: exitConfigStamp(windowDb, 1000),
};
warmExitConfigHash();                                  // ③ 従来はここで焼き付いた
const stampAfterWarm = exitConfigStamp(windowDb, 1001);
const kind = await loading;                            // settle(実装が確定)
const settledHash = exitConfigHashOrNull();

describe('★決済設定の指紋は「実装が確定するまで」確定させない', () => {
  it('ロードが in-flight のあいだは未確定 = 値を返さない(嘘の指紋を作らない)', () => {
    expect(inWindow.pending).toBe(true);
    // ★engine が受け取る実態は 'simple'。待たされないので **当てにならない**(これが事故の入口)。
    expect(inWindow.kindSeenByEngine).toBe('simple');
    expect(inWindow.hash).toBeNull();
  });

  it('未確定のあいだは取引に版を刻まない(誤った版を記録するより記録しない)', () => {
    expect(inWindow.stamp).toBeNull();
    expect(stampAfterWarm).toBeNull();
  });

  it('未確定のあいだの warm は台帳に採番しない(公開フォールバックの版を作らない)', () => {
    expect(lookupExitConfigVersion(windowDb, publicFallbackExitConfigHash())).toBeNull();
  });

  it('settle 後は、その実装で試打した指紋を返す', () => {
    expect(settledHash).toMatch(/^[0-9a-f]{16}$/);
    expect(settledHash).toBe(computeExitConfigHash());
  });

  it('★焼き付き検知: 公開フォールバックの指紋が返るのは「非公開実装が無いとき」だけ', () => {
    // 非公開実装が在るビルドでは両者は必ず別物。公開ビルド(private 不在)では一致するのが正しい。
    expect(settledHash === publicFallbackExitConfigHash()).toBe(kind !== 'private');
  });

  it('settle 後は従来どおり刻める(初出は版1)', () => {
    const db = memDb();
    const stamp = exitConfigStamp(db, 2000);
    expect(stamp).not.toBeNull();
    expect(stamp!.hash).toBe(settledHash);
    expect(stamp!.version).toBe(1);
  });

  it('公開フォールバックの指紋は、現在の実装に触れずに計算できる(試打が決済を汚さない)', () => {
    const probe: ExitState = { direction: 'buy', entryPrice: 38000, initialStop: 37950, peakProfit: 120 };
    const before = computeExitStop(probe);
    const fb = publicFallbackExitConfigHash();
    expect(computeExitStop(probe)).toBe(before);
    expect(fb).toBe(computeExitConfigHashWith(computeExitStopSimple));
  });
});

describe('★誤って採番された版に印をつける(追記のみ・過去の行は書き換えない)', () => {
  afterEach(() => { _setExitImpl(null); _resetExitConfigHashCache(); });

  /** 実装種別を 'private' にする(印の条件は種別だけ。値は問わないので簡易版と同じ振る舞いで十分)。 */
  const asPrivate = (): void => { _setExitImpl(s => s.initialStop); };

  it('非公開実装のプロセスに公開フォールバックの版が居たら印が付く(冪等)', () => {
    const db = memDb();
    const fb = publicFallbackExitConfigHash();
    // 事故後の台帳を再現: 版1=正しい指紋 / 版2=公開フォールバックの指紋(確定前に採番されたもの)
    resolveExitConfigVersion(db, 'e01d0000e01d0000', 100);
    expect(resolveExitConfigVersion(db, fb, 200)).toBe(2);

    asPrivate();
    expect(markFallbackExitConfigVersion(db, 5000)).toEqual({ hash: fb, version: 2 });
    expect(markFallbackExitConfigVersion(db, 6000)).toEqual({ hash: fb, version: 2 });   // 冪等

    const notes = db.prepare('SELECT hash, version, note, noted_at FROM exit_config_version_notes').all();
    expect(notes).toEqual([{ hash: fb, version: 2, note: 'public-fallback-fingerprint', noted_at: 5000 }]);
  });

  it('★台帳そのものは1行も書き換えない(採番も first_seen も動かさない)', () => {
    const db = memDb();
    const fb = publicFallbackExitConfigHash();
    resolveExitConfigVersion(db, 'e01d0000e01d0000', 100);
    resolveExitConfigVersion(db, fb, 200);
    const before = db.prepare('SELECT hash, version, first_seen FROM exit_config_versions ORDER BY version').all();

    asPrivate();
    markFallbackExitConfigVersion(db, 5000);

    expect(db.prepare('SELECT hash, version, first_seen FROM exit_config_versions ORDER BY version').all())
      .toEqual(before);
  });

  it('公開ビルド(実装が非公開実装でない)では印を付けない — そこではその版が正しい', () => {
    const db = memDb();
    resolveExitConfigVersion(db, publicFallbackExitConfigHash(), 100);
    _setExitImpl(null);
    expect(markFallbackExitConfigVersion(db, 5000)).toBeNull();
  });

  it('汚染が無ければ何もしない(表も作らない)', () => {
    const db = memDb();
    resolveExitConfigVersion(db, 'aaaaaaaaaaaaaaaa', 100);
    asPrivate();
    expect(markFallbackExitConfigVersion(db, 5000)).toBeNull();
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='exit_config_version_notes'").all();
    expect(t).toEqual([]);
  });
});
