// ★CORS 例外(/api/exit-stop)がパスの表記ゆれで回らないこと。
//
// ── 否定対照 ────────────────────────────────────────────────────────────────
//   修正前の server/index.ts は `NO_CORS_PATHS.has(req.path)`(完全一致)だった:
//     git show HEAD:server/index.ts | grep "NO_CORS_PATHS.has"
//       → `if (NO_CORS_PATHS.has(req.path)) {`
//   実サーバ実測(修正前):
//     POST /api/exit-stop   → Access-Control-Allow-Origin: (なし)
//     POST /API/exit-stop   → Access-Control-Allow-Origin: *      ← 例外をすり抜けた
//     POST /api/exit-stop/  → Access-Control-Allow-Origin: *      ← 同上
//   下の「実際の照合に使われている」テストは、修正前の index.ts では **赤** になる
//   (normalizeCorsPath が現れないため)。
//
// ★オラクルとしては成立しない(ハンドラ側の access gate が Origin/Referer/Sec-Fetch-Site を見て 403)。
//   ここで直しているのは多層防御の1層。**access gate は一切弱めていない**。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { normalizeCorsPath } from './corsPolicy.js';

const NO_CORS_PATHS: ReadonlySet<string> = new Set(['/api/exit-stop']);
const excluded = (p: string): boolean => NO_CORS_PATHS.has(normalizeCorsPath(p));

describe('normalizeCorsPath: express のルーティングと同じ規約で照合する', () => {
  it('素の表記はそのまま除外対象', () => {
    expect(excluded('/api/exit-stop')).toBe(true);
  });

  it('★大文字(caseSensitive=false で同じハンドラへ届く)でも除外対象', () => {
    for (const p of ['/API/exit-stop', '/Api/Exit-Stop', '/api/EXIT-STOP']) {
      expect(excluded(p), `${p} が CORS 例外から漏れている`).toBe(true);
    }
  });

  it('★末尾スラッシュ(strict=false で同じハンドラへ届く)でも除外対象', () => {
    for (const p of ['/api/exit-stop/', '/api/exit-stop//', '/API/exit-stop/']) {
      expect(excluded(p), `${p} が CORS 例外から漏れている`).toBe(true);
    }
  });

  it('無関係な経路は従来どおり CORS を付ける(例外を広げない)', () => {
    for (const p of ['/api/status', '/api/exit-stops', '/api/exit-stop-x', '/']) {
      expect(excluded(p), `${p} まで CORS 例外にしている`).toBe(false);
    }
  });

  it("'/' は空文字にしない(ルートを壊さない)", () => {
    expect(normalizeCorsPath('/')).toBe('/');
  });
});

// ★再混入を止めるトリップワイヤ: 正規化を通さない生の照合へ戻したら赤になる。
describe('★実際の照合に使われている', () => {
  const src = readFileSync(resolve(fileURLToPath(import.meta.url), '..', 'index.ts'), 'utf-8');

  it('server/index.ts が NO_CORS_PATHS を normalizeCorsPath 経由で引いている', () => {
    expect(
      /NO_CORS_PATHS\.has\(\s*normalizeCorsPath\(\s*req\.path\s*\)\s*\)/.test(src),
      'CORS 例外の照合が正規化を通っていない。req.path を素で比べると /API/exit-stop や '
      + '/api/exit-stop/ が例外をすり抜けて Access-Control-Allow-Origin: * が付く(実測済み)。',
    ).toBe(true);
  });

  it('生の req.path を直接 has() へ渡していない', () => {
    expect(src).not.toMatch(/NO_CORS_PATHS\.has\(\s*req\.path\s*\)/);
  });
});
