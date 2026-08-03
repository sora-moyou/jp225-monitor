import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTasklistRow, imageFromTasklist, isAliveAsImage, isAlive, ownImageName,
  probeProcessImage, acquirePidLock, releasePidLock, pidLockPath, inspectPidLock,
} from './pidLock.js';

// ─── ★pid の同一性検証(Rust 側と同じ考え方に揃える) ─────────────────────────────
//
// 何が危なかったか:
//   ・pid ファイルの解放は `finally` にしかなく、process.exit(0) でも taskkill でも通らない
//     → **stale pid が常態**。
//   ・その stale pid を OS が別プロセスに再利用すると、素の kill(pid,0) は「生きている」と答える
//     → 常駐プロセス(生成器)が「別インスタンスが居る」と誤認して二度と上がらない。
//   ・同じリリースの Rust 側(src-tauri/src/lib.rs の is_alive_with_image)は、まさにこの
//     pid 再利用対策に **イメージ名照合** を入れている。TS 側だけ素の kill(pid,0) = 二つの基準。
//
// ★否定対照: 修正前の server/pidLock.ts には isAliveAsImage / probeProcessImage が存在せず
//   (このファイルは import すら解決しない)、acquirePidLock の生存判定は kill(pid,0) 一本だった。
//   本ファイルの「素の kill(pid,0) では判別できない」ケースが、当時そのまま誤判定になっていた。

describe('tasklist の読み取り(純関数)', () => {
  it('CSV 行から イメージ名と pid を取る', () => {
    expect(parseTasklistRow('"jp225-generator.exe","1234","Console","1","50,000 K"'))
      .toEqual({ image: 'jp225-generator.exe', pid: 1234 });
  });

  it('★「該当なし」の文言はロケールに関係なく落ちる(英語/日本語)', () => {
    expect(parseTasklistRow('INFO: No tasks are running which match the specified criteria.')).toBeNull();
    expect(parseTasklistRow('情報: 指定された条件に一致するタスクは実行されていません。')).toBeNull();
    expect(parseTasklistRow('')).toBeNull();
  });

  it('pid が一致する行だけを採る(別プロセスの行に引きずられない)', () => {
    const out = [
      '"other.exe","111","Console","1","1,000 K"',
      '"jp225-collector.exe","222","Console","1","2,000 K"',
    ].join('\r\n');
    expect(imageFromTasklist(out, 222)).toBe('jp225-collector.exe');
    expect(imageFromTasklist(out, 333)).toBeNull();
  });
});

describe('生存判定(実プロセス)', () => {
  it('自分自身は pid でもイメージ名でも生きている', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAliveAsImage(process.pid, ownImageName())).toBe(true);
  });

  it('★イメージ名が違えば「別プロセスによる pid 再利用」= 生存扱いしない', () => {
    // 自分の pid は実在する(kill(pid,0) は true)が、名前が違う = 自分のロックの持ち主ではない。
    expect(isAlive(process.pid)).toBe(true);                                   // ← 修正前の基準
    expect(isAliveAsImage(process.pid, 'not-our-binary.exe')).toBe(false);     // ← 新しい基準
  });

  it('居ない pid は false(問い合わせは成功していて「居ない」と答える)', () => {
    const probe = probeProcessImage(999_999);
    if (probe.ok) expect(probe.image).toBeNull();     // Windows: 問い合わせできて「該当なし」
    expect(isAliveAsImage(999_999, ownImageName())).toBe(false);
  });
});

describe('ロックの解放は「自分のものだけ」', () => {
  const NAME = 'jp225-pidlock-image-test.pid';
  let saved: string | undefined;
  let dir: string;

  beforeEach(() => {
    saved = process.env.APPDATA;
    dir = mkdtempSync(join(tmpdir(), 'pidlock-img-'));
    process.env.APPDATA = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('自分のロックは消える(従来どおり)', () => {
    expect(acquirePidLock(NAME)).toBe(true);
    releasePidLock(NAME);
    expect(existsSync(pidLockPath(NAME))).toBe(false);
  });

  it('★他人のロックは消さない(取れずに待機していた2本目が終わっても保持者を壊さない)', () => {
    writeFileSync(pidLockPath(NAME), '4242', 'utf-8');
    releasePidLock(NAME);   // 自分の pid ではない
    expect(readFileSync(pidLockPath(NAME), 'utf-8')).toBe('4242');
  });

  it('生存判定は差し替えられる(既定は従来の kill(pid,0)・生成器はイメージ名まで見る)', () => {
    writeFileSync(pidLockPath(NAME), '4242', 'utf-8');
    expect(acquirePidLock(NAME, process.pid, () => true)).toBe(false);    // 生きている扱い → 取らない
    expect(acquirePidLock(NAME, process.pid, () => false)).toBe(true);    // 死んでいる扱い → 引き継ぐ
    expect(readFileSync(pidLockPath(NAME), 'utf-8')).toBe(String(process.pid));
  });

  it('ロックの現況を人に説明できる材料が読める(理由を書くための入力)', () => {
    writeFileSync(pidLockPath(NAME), '4242', 'utf-8');
    const info = inspectPidLock(NAME);
    expect(info.pid).toBe(4242);
    expect(info.path).toBe(pidLockPath(NAME));
    expect(info.expectedImage).toBe(ownImageName());
  });

  it('pid ファイルの形式は従来どおり String(pid) のまま(既存の読み手を巻き添えにしない)', () => {
    acquirePidLock(NAME);
    expect(readFileSync(pidLockPath(NAME), 'utf-8')).toBe(String(process.pid));
  });
});
