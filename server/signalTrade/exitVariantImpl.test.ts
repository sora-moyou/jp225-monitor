import { describe, it, expect } from 'vitest';
import { loadExitImpl, DEFAULT_EXIT_VARIANT } from './exit/index.js';
import { exitVariantImplKind, exitVariantImplKindAll } from './exitVariantImpl.js';

// ─── 決済仕様の変種が「実体」か「公開フォールバック」かを外から観測する ─────────
//
// ★否定対照(この観測が無かった時の結果): exitVariantImpl.ts 自体が存在せず、
//   import 段で解決できないので本ファイルは全て赤。実態を知る手段はどこにも無かった。
//
// ★このファイルは公開リポにも載る。**決済の実数値は一切書かない・一切 assert しない。**
//   検証するのは「差し替えが起きたかどうか」という1ビットだけ。

/** private(非公開実装)がこのビルドに同梱されているか。公開クローンでは false。 */
async function privateAvailable(): Promise<boolean> {
  try {
    // @ts-ignore optional private module (absent in public repo)
    const mod = await import('./exit/private.js') as { describeExitLogicVariantPrivate?: unknown };
    return typeof mod.describeExitLogicVariantPrivate === 'function';
  } catch {
    return false;
  }
}

describe('exitVariantImplKind', () => {
  it('★loadExitImpl 前は必ず fallback(差し替えが起きていない状態を fallback と呼ぶ)', () => {
    // このテストファイルはまだ loadExitImpl を呼んでいない = 公開フォールバックのまま。
    expect(exitVariantImplKind('candidate-a')).toBe('fallback');
    expect(exitVariantImplKindAll()).toBe('fallback');
  });

  it('loadExitImpl 後は private の有無を **そのまま** 映す(取り違えない)', async () => {
    const expected = await privateAvailable() ? 'private' : 'fallback';
    await loadExitImpl();
    expect(exitVariantImplKind('candidate-a')).toBe(expected);
    expect(exitVariantImplKindAll()).toBe(expected);
  });

  it('★既定の変種(current)は 400 の判定対象にしない: 実体が無くても現行仕様として正しく動く', async () => {
    // current は「実体が無ければ公開フォールバックのまま現行として動く」のが仕様であって、
    // 「候補で生成したつもりが現行だった」という壊れ方は起きない。だから
    // exitVariantImplKindAll は current を除いた変種だけを見る(route も current では 400 にしない)。
    await loadExitImpl();
    const expected = await privateAvailable() ? 'private' : 'fallback';
    expect(exitVariantImplKind(DEFAULT_EXIT_VARIANT)).toBe(expected);
    expect(exitVariantImplKindAll()).toBe(expected);   // ★current の状態に引きずられていない
  });

  it('判定結果に決済の実数値が出てこない(種別の2値だけ)', async () => {
    await loadExitImpl();
    expect(['private', 'fallback']).toContain(exitVariantImplKindAll());
  });
});
