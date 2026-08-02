import { describe, it, expect, vi } from 'vitest';
import type { Price } from '../types.js';

// ★refPrice(計画の基準価格)の鮮度ゲート。
//   従来の実装は `prices.find(p => p.symbol === symbol)?.price ?? 0` で、
//     (a) stale フラグを見ない = フィード断で持ち越された古い価格をそのまま基準にする
//     (b) 取得失敗を静かに 0 にする = 無言の失敗
//   の二重の穴があった。
//
//   実測(2026-07-23・serverlog + prices_kabu.db の bars_1m):
//     21:42:01→21:56:52  sell 指値@66725  その時の実勢 65795  乖離 930円  trade2 が131回連続で拒否・一度も約定せず
//     22:44:35→22:59:30  sell 指値@66990  その時の実勢 65995  乖離 995円  130回連続で拒否
//   66,725 に最後に届いたのは同日 14:45、66,990 は 10:16 = **7〜12時間前の水準**。
//
//   ★stale フラグだけでは塞がらない実在の穴: priceLoop.tick() は取引時間外に setPrices を呼ばずに
//     早期 return するため、時間外はキャッシュに「最後の場中価格が stale:false のまま」凍って残る。
//     engine 経路は inPollWindow でゲートされるが POST /api/scalp-plan は時間外でも通る
//     (旧記述「trade2 が叩く」は誤り。trade2 はシグナル追従のみで scalp-plan は叩かない=2026-08-02 実確認)。
//     → 経過時間の上限(REF_PRICE_MAX_AGE_MS)が要る。

const createMock = vi.fn();
vi.mock('./providers.js', () => ({
  isLLMEnabled: () => true,
  isVisionCapableProvider: () => false,
  callWithFallback: async (task: (p: unknown) => Promise<string>) =>
    task({ client: { chat: { completions: { create: createMock } } }, config: { name: 'test', chatModel: 'test-model' } }),
}));
vi.mock('./webSearch.js', () => ({ isWebSearchEnabled: () => false, webSearch: async () => '' }));
vi.mock('./dataTools.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  buildMonitorContext: () => '',
}));
// knob は実ユーザー設定に依存させない(LC 上下限/バイアス等でプランが落ちるとゲートの検証にならない)。
vi.mock('../configStore.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  resolveScalpLcFloorDirective: () => ({ mode: 'manual', value: 45 }),
  resolveScalpLcCeilingDirective: () => ({ mode: 'manual', value: 65 }),
  resolveScalpTrendVetoDirective: () => ({ mode: 'manual', value: 100 }),
  resolveScalpCooldownDirective: () => ({ mode: 'manual', value: 90 }),
  resolveScalpBiasDirective: () => ({ mode: 'manual', value: 'none' }),
  resolveScalpRangeDirective: () => ({ mode: 'manual', value: true }),
  resolveScalpLcHardMax: () => ({ enabled: false, value: 150 }),
  resolveScalpAiTechnicalEnabled: () => false,
}));

const { buildScalpPlan, resolveRefPrice, REF_PRICE_MAX_AGE_MS } = await import('./scalpPlan.js');

const NOW = 1_785_455_141_000;
const q = (over: Partial<Price> = {}): Price =>
  ({ symbol: 'NIY=F', price: 63865, changePercent: 0, timestamp: NOW, stale: false, ...over } as Price);
/** buildScalpPlan は実時計(Date.now)で鮮度を測るので、経路テストでは「今」の見積りを渡す。 */
const fresh = (over: Partial<Price> = {}): Price => q({ timestamp: Date.now(), ...over });

describe('resolveRefPrice: 古い/壊れた基準価格を弾く', () => {
  it('新鮮な価格はそのまま採用', () => {
    expect(resolveRefPrice([q()], 'NIY=F', NOW)).toEqual({ ok: true, refPrice: 63865 });
  });

  it('★stale(フィード断の持ち越し)は不採用=理由付きで失敗する', () => {
    const r = resolveRefPrice([q({ stale: true })], 'NIY=F', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('stale');
  });

  it('★銘柄が無いときに 0 へ落ちない(旧実装 `?? 0` の否定対照)', () => {
    const r = resolveRefPrice([], 'NIY=F', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('キャッシュに無い');
  });

  it('価格が 0 / 非有限なら不採用', () => {
    for (const price of [0, -1, NaN, Infinity]) {
      expect(resolveRefPrice([q({ price })], 'NIY=F', NOW).ok).toBe(false);
    }
  });

  it(`★経過時間の上限は ${REF_PRICE_MAX_AGE_MS / 1000} 秒(境界で切り替わる)`, () => {
    // 上限ちょうど=採用 / 1ms 超過=不採用。
    expect(resolveRefPrice([q({ timestamp: NOW - REF_PRICE_MAX_AGE_MS })], 'NIY=F', NOW).ok).toBe(true);
    const over = resolveRefPrice([q({ timestamp: NOW - REF_PRICE_MAX_AGE_MS - 1 })], 'NIY=F', NOW);
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error('unreachable');
    expect(over.reason).toContain('古い');
  });

  it('★2026-07-23 の水準(7〜12時間前の価格)は当然に不採用', () => {
    // 66,725 は 14:45 の値。21:42 に基準として使われていた=約7時間前。
    const sevenHoursAgo = NOW - 7 * 3600_000;
    const r = resolveRefPrice([q({ price: 66725, timestamp: sevenHoursAgo })], 'NIY=F', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('25200秒');   // 7時間
  });

  it('取引時間外にキャッシュが凍る形(stale:false のまま古い)も塞がる', () => {
    // priceLoop は時間外に setPrices を呼ばない → stale は立たないまま timestamp だけが古くなる。
    const r = resolveRefPrice([q({ timestamp: NOW - 3 * 3600_000 })], 'NIY=F', NOW);
    expect(r.ok).toBe(false);
  });
});

describe('buildScalpPlan: 使えない refPrice では計画を作らない(無言で見送りにしない)', () => {
  it('★stale な現在値 → ok:false + 理由。LLM は一度も呼ばれない', async () => {
    createMock.mockReset();
    const r = await buildScalpPlan({ symbol: 'NIY=F', prices: [fresh({ stale: true })], news: [] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('現在値が使えない');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('★現在値が取れない → ok:false(refPrice=0 の計画を作らない)', async () => {
    createMock.mockReset();
    const r = await buildScalpPlan({ symbol: 'NIY=F', prices: [], news: [] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('現在値が使えない');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('新鮮な現在値なら従来どおり LLM を呼んで計画を返す(過剰抑止しない)', async () => {
    createMock.mockReset();
    createMock.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        direction: 'buy', limitEntry: 63805, stopLossForLimit: 63750, rationale: 'r', refPrice: 63865,
      }) } }],
    });
    const r = await buildScalpPlan({ symbol: 'NIY=F', prices: [fresh()], news: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.refPrice).toBe(63865);
    expect(createMock).toHaveBeenCalled();
  });
});
