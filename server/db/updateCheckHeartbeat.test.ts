import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getMeta } from './store.js';
import {
  UPDATE_CHECK_KEY, UPDATE_CHECK_STATUS_KEY,
  buildUpdateCheckHeartbeat, formatUpdateCheckStatus,
  writeUpdateCheckHeartbeat, readUpdateCheckHeartbeat, describeUpdateCheck,
  type BuildUpdateCheckInput,
} from './updateCheckHeartbeat.js';
import type { UpdaterProbe } from '../updater/probe.js';

// ★このテストが守る契約(更新チェックの結末の記録・RECORD-ONLY):
//   ① 「アプリは最新と言ったが、サーバから叩くと新しい版が返る」= 2026-09-09 の事故の形が
//      **1行を読むだけ** で分かる(mismatch)。
//   ② 失敗・更新あり・更新なし・Tauri 外 の4つが取り違えられない語彙で残る。
//   ③ 記録は共有DB(jp225.db)の meta の2本(JSON + 人が読む1行)= 既存の VACUUM INTO に乗る。
//   ④ 「最新」に裏が取れていない場合(probe 失敗)を「一致」と言わない。
//   ⑤ 読み手が「古い記録」を現在の状態と誤読しない(更新チェックは押したときだけ起きる)。

const JST = 9 * 60 * 60_000;
const AT = Date.UTC(2026, 8, 9, 12, 0, 0) - JST;          // 2026-09-09 12:00:00 JST
const URL_ = 'https://github.com/sora-moyou/jp225-monitor2-releases/releases/latest/download/latest.json';

const probeOk = (version: string): UpdaterProbe =>
  ({ url: URL_, ok: true, httpStatus: 200, version, error: null, ms: 300 });
const probeFail = (error: string, httpStatus: number | null = null): UpdaterProbe =>
  ({ url: URL_, ok: false, httpStatus, version: null, error, ms: 120 });

const base: BuildUpdateCheckInput = {
  now: AT, source: 'settings', appVersion: '0.9.109', clientVersion: '0.9.109',
  variant: 'full', verdict: 'latest', pluginVersion: null, message: null, probe: probeOk('0.9.109'),
};
const build = (o: Partial<BuildUpdateCheckInput>) => buildUpdateCheckHeartbeat({ ...base, ...o });

function sharedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}

describe('★食い違い(2026-09-09 の事故の形)', () => {
  it('アプリ「最新(0.9.109)」× サーバ probe 0.9.110 → mismatch=true・1行に両方が出る', () => {
    const hb = build({ probe: probeOk('0.9.110') });
    expect(hb.mismatch).toBe(true);
    const line = formatUpdateCheckStatus(hb);
    expect(line).toContain('★MISMATCH');
    expect(line).toContain('0.9.109');                    // アプリが名乗った版
    expect(line).toContain('0.9.110');                    // 配信側の版
    expect(line).toContain('HTTP 200');                   // ★webview からは取れない情報
    expect(line).toContain(URL_);                         // どの URL を叩いたか
  });

  it('画面が「確認失敗」でも、サーバから新しい版が見えていれば mismatch=true', () => {
    const hb = build({ verdict: 'error', message: 'Network Error', probe: probeOk('0.9.110') });
    expect(hb.mismatch).toBe(true);
    expect(formatUpdateCheckStatus(hb)).toContain('ネットワークではない');
  });

  it('★否定対照: 版が一致していれば mismatch=false(何でも赤くしていない)', () => {
    expect(build({ probe: probeOk('0.9.109') }).mismatch).toBe(false);
  });

  it('★否定対照: 配信側が古い版でも mismatch にしない(文字列比較の罠を踏まない)', () => {
    expect(build({ appVersion: '0.9.110', clientVersion: '0.9.110', probe: probeOk('0.9.9') }).mismatch).toBe(false);
  });

  it('画面が更新に気づいている(available)ときは食い違いではない', () => {
    const hb = build({ verdict: 'available', pluginVersion: '0.9.110', probe: probeOk('0.9.110') });
    expect(hb.mismatch).toBe(false);
    expect(formatUpdateCheckStatus(hb)).toContain('UPDATE-AVAILABLE');
  });

  it('★プラグインの版と配信側の版がズレていたらその旨が出る', () => {
    const hb = build({ verdict: 'available', pluginVersion: '0.9.110', probe: probeOk('0.9.111') });
    expect(formatUpdateCheckStatus(hb)).toContain('配信側は 0.9.111');
  });
});

describe('4つの判定が取り違えられない語彙で残る', () => {
  it('latest / available / error / unsupported が別ラベルになる', () => {
    const labels = ([
      build({}),
      build({ verdict: 'available', pluginVersion: '0.9.110', probe: probeOk('0.9.110') }),
      build({ verdict: 'error', message: 'boom', probe: probeFail('HTTP 403', 403) }),
      build({ verdict: 'unsupported', probe: probeOk('0.9.109') }),
    ]).map(h => formatUpdateCheckStatus(h).split(' ')[0]);
    expect(new Set(labels).size).toBe(4);
    expect(labels).toEqual(['LATEST', 'UPDATE-AVAILABLE', 'CHECK-FAILED', 'NOT-TAURI']);
  });

  it('★「最新」に裏が取れていない(probe 失敗)ことを一致と言わない', () => {
    const hb = build({ probe: probeFail('タイムアウト(10000ms): aborted') });
    expect(hb.mismatch).toBe(false);                     // 分からないものを食い違いとは言わない
    const line = formatUpdateCheckStatus(hb);
    expect(line).toContain('裏が取れていない');
    expect(line).toContain('probe=失敗');
  });

  it('チェック失敗 × サーバも届かない → ネットワーク側の疑いと書く', () => {
    const hb = build({ verdict: 'error', message: 'Network Error', probe: probeFail('getaddrinfo ENOTFOUND') });
    expect(hb.mismatch).toBe(false);
    expect(formatUpdateCheckStatus(hb)).toContain('ネットワーク側の疑い');
  });

  it('画面が名乗った版が実体と違えばそれも1行に出る', () => {
    expect(formatUpdateCheckStatus(build({ clientVersion: '0.9.108' }))).toContain('画面表示=0.9.108(★実体と不一致)');
  });

  it('source(startup / settings)が1行に出る = 片方だけ無音でないことが後から数えられる', () => {
    expect(formatUpdateCheckStatus(build({ source: 'startup' }))).toContain('source=startup');
    expect(formatUpdateCheckStatus(build({ source: 'settings' }))).toContain('source=settings');
  });
});

describe('meta への記録(既存の tick_archive_status / price_feed_status と同じ流儀)', () => {
  it('JSON 本体と人が読む1行の2本が書かれ、読み戻せる', () => {
    const db = sharedDb();
    const hb = writeUpdateCheckHeartbeat(db, build({ probe: probeOk('0.9.110') }));
    expect(getMeta(db, UPDATE_CHECK_STATUS_KEY)).toBe(formatUpdateCheckStatus(hb));
    expect(readUpdateCheckHeartbeat(db)).toEqual(hb);
    db.close();
  });

  it('壊れた JSON は「無い」扱い(次の記録で上書きされる)', () => {
    const db = sharedDb();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(UPDATE_CHECK_KEY, '{broken');
    expect(readUpdateCheckHeartbeat(db)).toBeNull();
    db.close();
  });

  it('一度も書いていなければ null(= 記録が始まっていない)', () => {
    const db = sharedDb();
    expect(readUpdateCheckHeartbeat(db)).toBeNull();
    expect(describeUpdateCheck(null, AT)).toContain('MISSING');
    db.close();
  });
});

describe('読み手側(★古い1件を現在の状態と誤読させない)', () => {
  it('鮮度で赤にはしないが、いつの1件かを必ず添える', () => {
    const text = describeUpdateCheck(build({}), AT + 3 * 24 * 3600_000);
    expect(text).toContain('3d0h前の1件');
    expect(text).toContain('押したときだけ起きる');
  });
});

describe('probe の所要時間(★秒丸めで「測っていない」に見せない)', () => {
  const withMs = (ms: number) => formatUpdateCheckStatus(build({ probe: { ...probeOk('0.9.109'), ms } }));
  it('1秒未満はミリ秒のまま出す', () => {
    expect(withMs(312)).toContain('(312ms)');
    expect(withMs(312)).not.toContain('(0s)');
  });
  it('1秒以上は既存の fmtDur と同じ表記', () => {
    expect(withMs(2400)).toContain('(2s)');
  });
});

describe('★probe 未実施(Tauri 外)= 「叩いて失敗した」と別物として残る', () => {
  const hb = build({ verdict: 'unsupported', probe: null });

  it('1行には「未実施」と出て、「失敗」とは書かない', () => {
    const line = formatUpdateCheckStatus(hb);
    expect(line).toContain('NOT-TAURI');
    expect(line).toContain('probe=未実施');
    expect(line).not.toContain('probe=失敗');
    expect(line).not.toContain('https://');       // 叩いていないので URL も出さない
  });

  it('probe が無くても mismatch 判定は成立しない(分からないものを食い違いと言わない)', () => {
    expect(hb.mismatch).toBe(false);
    expect(build({ verdict: 'latest', probe: null }).mismatch).toBe(false);
  });

  it('probe=null の記録も meta に書けて読み戻せる', () => {
    const db = sharedDb();
    writeUpdateCheckHeartbeat(db, hb);
    expect(readUpdateCheckHeartbeat(db)).toEqual(hb);
    db.close();
  });
})

describe('★「一致」と書けるのは実際に等しいときだけ(実測で一度嘘をついた行)', () => {
  it('app=0.9.111 / 配信側=0.9.110 のとき「一致」とは書かない', () => {
    const line = formatUpdateCheckStatus(build({ appVersion: '0.9.111', clientVersion: '0.9.111', probe: probeOk('0.9.110') }));
    expect(line).not.toContain('一致');
    expect(line).toContain('実行中のほうが新しい');
    expect(line).toContain('LATEST');                   // 結論は「最新」のままで矛盾しない
  });

  it('等しいときだけ「一致」と書く', () => {
    expect(formatUpdateCheckStatus(build({ probe: probeOk('0.9.109') }))).toContain('0.9.109 で一致');
  });
});
