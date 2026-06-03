import { describe, it, expect } from 'vitest';
import { detectGranvilleReversal, detectGranvilleContinuation,
  type GranvilleParams, type GranvilleContParams } from './granville.js';

const P: GranvilleParams = { maPeriod: 10, slopeBack: 5 };
const PC: GranvilleContParams = { maPeriod: 10, slopeBack: 5, retestBack: 5, touchBand: 0.02 };

// 系列を末尾1本ずつ伸ばして評価し、転換が「何回」発火したか(=クロスの瞬間だけか)を数える。
// 旧実装は cBack(15本前)基準で、クロス後も約slopeBack本ぶん毎足発火していた(過去の転換を新規表示)。
// 現実装はエッジ検知で「ちょうど1回」が期待値。
function scanReversal(closes: number[], p: GranvilleParams): { fires: number; sig: ReturnType<typeof detectGranvilleReversal> } {
  let fires = 0; let sig: ReturnType<typeof detectGranvilleReversal> = null;
  const need = p.maPeriod + 2 * p.slopeBack + 1;
  for (let n = need; n <= closes.length; n++) {
    const s = detectGranvilleReversal(closes.slice(0, n), p);
    if (s) { fires++; sig = s; }
  }
  return { fires, sig };
}

describe('detectGranvilleReversal (グランビル①トレンド転換)', () => {
  it('買い転換: 上抜けの瞬間に1度だけ発火(エコーしない)', () => {
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);   // 100..81
    const up = [85, 95, 105, 110, 112];                           // 反発して MA を上抜け
    const r = scanReversal([...down, ...up], P);
    expect(r.fires).toBe(1);                       // クロスは1回 → 発火も1回(過去転換の再発火なし)
    expect(r.sig!.dir).toBe('up');
    expect(r.sig!.deviation).toBeGreaterThan(0);
    expect(r.sig!.origin).toBeLessThan(r.sig!.ma); // 起点は転換前(MA下)の1つ以上前の足の価格
  });

  it('売り転換: 下抜けの瞬間に1度だけ発火(エコーしない)', () => {
    const upTrend = Array.from({ length: 20 }, (_, i) => 80 + i);  // 80..99
    const down = [95, 85, 75, 70, 68];                            // 反落して MA を下抜け
    const r = scanReversal([...upTrend, ...down], P);
    expect(r.fires).toBe(1);
    expect(r.sig!.dir).toBe('down');
    expect(r.sig!.deviation).toBeLessThan(0);
    expect(r.sig!.origin).toBeGreaterThan(r.sig!.ma);
  });

  it('単調下落(転換なし)は null', () => {
    const mono = Array.from({ length: 25 }, (_, i) => 100 - i);
    expect(detectGranvilleReversal(mono, P)).toBeNull();
  });

  it('データ不足は null', () => {
    expect(detectGranvilleReversal([1, 2, 3], P)).toBeNull();
  });

  // 遅行MAの取りこぼし回帰: 75本MAは反転に遅行するため、価格がMAを上抜けた時点ではMAはまだ下向き
  // (slopeRecentは負)。減速(slopeRecent>slopePrior)で「クロスの瞬間に1度だけ」発火することを検証。
  it('買い転換(遅行MA75): クロス時に1度だけ発火', () => {
    const closes: number[] = [];
    for (let i = 0; i < 130; i++) closes.push(68000 - 2000 * (i / 129));   // 緩やか下降
    const b = closes[closes.length - 1]!;
    for (let k = 1; k <= 40; k++) closes.push(b + 40 * k);                 // 反転上昇でMA上抜け
    const r = scanReversal(closes, { maPeriod: 75, slopeBack: 15 });
    expect(r.fires).toBe(1);
    expect(r.sig!.dir).toBe('up');
  });

  it('売り転換(遅行MA75): クロス時に1度だけ発火', () => {
    const closes: number[] = [];
    for (let i = 0; i < 130; i++) closes.push(66000 + 2000 * (i / 129));   // 緩やか上昇
    const t = closes[closes.length - 1]!;
    for (let k = 1; k <= 40; k++) closes.push(t - 40 * k);                 // 反落でMA下抜け
    const r = scanReversal(closes, { maPeriod: 75, slopeBack: 15 });
    expect(r.fires).toBe(1);
    expect(r.sig!.dir).toBe('down');
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
