import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── ★/api/status は「まだ確定していない」と言えること(嘘の指紋を返さない) ─────────────
//
// 実運用の事故: 決済実装のロードが in-flight のあいだに観測した **公開フォールバックの指紋** が
// キャッシュへ焼き付き、以後 /api/status も版台帳も分析用の runs も、その嘘の指紋で埋まった。
// 分析用の前提検証は起動直後に /api/status を叩くので、この窓に当たり得る。
//   → 窓のあいだは configHash を **null**(=まだ言えない)にする。前提検証は指紋が無い期を作らない。
//
// ★DB は一時ディレクトリへ隔離する(APPDATA を差し替えてから status を import する)。
//   実運用の jp225.db には触れない。
process.env.APPDATA = mkdtempSync(join(tmpdir(), 'jp225-status-pending-'));

const { loadExitImpl } = await import('../signalTrade/exit/index.js');
const { exitStatus } = await import('./status.js');

// ★窓は一度きり: ここで「待たない起動」を始め、同じ tick で観測する(server/index.ts:176 と同じ)。
const loading = loadExitImpl();
const during = await exitStatus(1_700_000_000_000);
const kind = await loading;
const after = await exitStatus(1_700_000_000_000);

describe('/api/status — 決済設定の指紋は確定してからしか出さない', () => {
  it('★実装が未確定のあいだは configHash が null(公開フォールバックの指紋を現行として返さない)', () => {
    expect(during).not.toHaveProperty('error');
    const e = during as { configHash: string | null; configVersion: number | null };
    expect(e.configHash).toBeNull();
    expect(e.configVersion).toBeNull();
  });

  it('実装が確定したら 16桁hex の指紋が出る(未採番なので版は null)', () => {
    const e = after as { impl: string; configHash: string | null; configVersion: number | null };
    expect(e.impl).toBe(kind === 'private' ? 'private' : 'fallback');
    expect(e.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(e.configVersion).toBeNull();
  });

  it('応答の形は不変(キーを増やさない・決済の実数値もキーも含まない)', () => {
    expect(Object.keys(after).sort()).toEqual(['configHash', 'configVersion', 'impl', 'variantImpl']);
    expect(JSON.stringify(after)).not.toMatch(/key|sk-|api[-_]?key/i);
  });
});
