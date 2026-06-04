import { describe, it, expect } from 'vitest';
import { detectGranvilleReversal, detectGranvilleContinuation, detectMaCross,
  type GranvilleParams, type GranvilleContParams } from './granville.js';

const P: GranvilleParams = { maPeriod: 10, slopeBack: 5 };
const PC: GranvilleContParams = { maPeriod: 10, slopeBack: 5, retestBack: 5, touchBand: 0.02 };

describe('detectGranvilleReversal (グランビル①トレンド転換)', () => {
  // 検知は cBack(クロス前=slopeBack本前が反対側)基準。リアルタイム足は末尾が進行中で
  // 60秒ポーリングがクロスの瞬間を外しても確実に捕捉できる。エコー(クロス後も出続ける)は
  // alertEngine 側のエッジ抑制で1回化する(本ユニットでは検知の正しさのみ確認)。
  it('買い転換: MAが下落→上向き＋価格が下から上抜け', () => {
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);   // 100..81
    const up = [85, 95, 105, 110, 112];                           // 反発して MA を上抜け
    const sig = detectGranvilleReversal([...down, ...up], P);
    expect(sig?.dir).toBe('up');
    expect(sig!.deviation).toBeGreaterThan(0);
    // 起点 = slopeBack(5)本前の終値(クロス前)= closes[19]=81。現値(112)ではなく1つ以上前の足。
    expect(sig!.origin).toBe(81);
  });

  it('売り転換: MAが上昇→下向き＋価格が上から下抜け', () => {
    const upTrend = Array.from({ length: 20 }, (_, i) => 80 + i);  // 80..99
    const down = [95, 85, 75, 70, 68];                            // 反落して MA を下抜け
    const sig = detectGranvilleReversal([...upTrend, ...down], P);
    expect(sig?.dir).toBe('down');
    expect(sig!.deviation).toBeLessThan(0);
  });

  it('単調下落(転換なし)は null', () => {
    const mono = Array.from({ length: 25 }, (_, i) => 100 - i);
    expect(detectGranvilleReversal(mono, P)).toBeNull();
  });

  it('データ不足は null', () => {
    expect(detectGranvilleReversal([1, 2, 3], P)).toBeNull();
  });

  // 遅行MAの取りこぼし回帰: 75本MAは反転に遅行するため、価格がMAを上抜けた時点ではMAはまだ下向き
  // (slopeRecentは負)。減速(slopeRecent>slopePrior)で発火することを検証。
  it('買い転換(遅行MA75): 価格がMAを上抜けた時点で、MAが下げ渋り(減速)なら転換を捉える', () => {
    const closes: number[] = [];
    for (let i = 0; i < 90; i++) closes.push(67500 - 1500 * (i / 89));   // 67500→66000 緩やか下降
    const b = closes[closes.length - 1]!;
    for (let i = 1; i <= 20; i++) closes.push(b + 30 * i);               // 反転上昇(MA上抜け直後)
    const sig = detectGranvilleReversal(closes, { maPeriod: 75, slopeBack: 15 });
    expect(sig?.dir).toBe('up');
  });

  it('売り転換(遅行MA75): 価格がMAを下抜けた時点で、MAが上げ渋り(減速)なら転換を捉える', () => {
    const closes: number[] = [];
    for (let i = 0; i < 90; i++) closes.push(66000 + 1500 * (i / 89));   // 66000→67500 緩やか上昇
    const t = closes[closes.length - 1]!;
    for (let i = 1; i <= 20; i++) closes.push(t - 30 * i);               // 反落(MA下抜け直後)
    const sig = detectGranvilleReversal(closes, { maPeriod: 75, slopeBack: 15 });
    expect(sig?.dir).toBe('down');
  });
});

describe('detectGranvilleContinuation (グランビル②③トレンド継続)', () => {
  it('売り継続(戻り売り): 下降MAで戻りがMA手前で否定→下落再開', () => {
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);   // 100..81 下降
    const fail = [84, 85, 85, 84, 83];                            // MA手前まで戻すが超えられず下落
    const sig = detectGranvilleContinuation([...down, ...fail], PC);
    expect(sig?.dir).toBe('down');
    expect(sig!.origin).toBe(85);   // 起点 = 戻りの高値(直近窓の最高値)
  });

  it('買い継続(押し目買い): 上昇MOで押しがMA手前で支持→上昇再開', () => {
    const up = Array.from({ length: 20 }, (_, i) => 80 + i);      // 80..99 上昇
    const hold = [96, 95, 95, 96, 97];                           // MA手前まで押すが割らず上昇
    const sig = detectGranvilleContinuation([...up, ...hold], PC);
    expect(sig?.dir).toBe('up');
    expect(sig!.origin).toBe(95);   // 起点 = 押しの安値(直近窓の最安値)
  });

  it('単調トレンド(戻り/押しなし)は null', () => {
    const mono = Array.from({ length: 25 }, (_, i) => 100 - i);
    expect(detectGranvilleContinuation(mono, PC)).toBeNull();
  });
});

describe('detectMaCross (素のMAクロス)', () => {
  // MA10 で評価。直前足が MA の反対側 → 最後の足で現在側へ抜けた時だけ発火(新規クロス)。
  it('上抜け: 直前まで MA下 → 最後の足で MA上へクロスで up', () => {
    const closes = [...Array.from({ length: 18 }, () => 100), 98, 98, 103];   // 直前(98)はMA下、末尾(103)でMA上抜け
    const sig = detectMaCross(closes, 10);
    expect(sig?.dir).toBe('up');
    expect(sig!.period).toBe(10);
    expect(sig!.deviation).toBeGreaterThan(0);
  });

  it('下抜け: 直前まで MA上 → 最後の足で MA下へクロスで down', () => {
    const closes = [...Array.from({ length: 18 }, () => 100), 102, 102, 97];
    expect(detectMaCross(closes, 10)?.dir).toBe('down');
  });

  it('現在側に居続ける(直前足も同じ側)なら新規クロスでない=null(エコー抑制)', () => {
    // ずっと MA より上 → クロスではない
    const closes = [...Array.from({ length: 20 }, () => 100), 105, 106, 107, 108];
    expect(detectMaCross(closes, 10)).toBeNull();
  });

  it('データ不足は null', () => {
    expect(detectMaCross([1, 2, 3], 10)).toBeNull();
  });
});
