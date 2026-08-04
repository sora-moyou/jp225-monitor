import { describe, it, expect } from 'vitest';
import {
  ARM_REPEAT_BLOCK_MS, ARM_REPEAT_LIMIT, EMPTY_ARM_REPEAT,
  bracketSignature, describeArmBlock, isArmBlocked, noteArmExpiry, noteArmFilled,
} from './armRepeat.js';

const buy = (limit: number, stop?: number) => ({ direction: 'buy' as const, limitEntry: limit, stopEntry: stop });

describe('bracketSignature(同じ計画かの判定)', () => {
  it('向き+エントリー価格で決まる', () => {
    expect(bracketSignature(buy(63800, 64100))).toBe('buy|L63800,S64100');
    expect(bracketSignature({ direction: 'sell', limitEntry: 63800 })).toBe('sell|L63800');
  });
  it('5円バケットで丸める(AI の微小なゆらぎを同一視する)', () => {
    expect(bracketSignature(buy(63801))).toBe(bracketSignature(buy(63800)));
    expect(bracketSignature(buy(63802))).toBe(bracketSignature(buy(63800)));
    // 5円を超えてずれたら別の計画。
    expect(bracketSignature(buy(63810))).not.toBe(bracketSignature(buy(63800)));
  });
  it('レンジは向きを range にし上下レッグを持つ / レッグ無しは null', () => {
    expect(bracketSignature({ mode: 'range', range: { upper: { entry: 64200 }, lower: { entry: 63800 } } }))
      .toBe('range|U64200,D63800');
    expect(bracketSignature({ direction: 'buy' })).toBeNull();
    expect(bracketSignature(null)).toBeNull();
  });
});

describe('★(d) 失効後の再武装と、その歯止め', () => {
  const sig = bracketSignature(buy(63800, 64100)) as string;

  it('1〜2回目の失効では同じ価格の計画をブロックしない(=同じものを出し直せる)', () => {
    let st = EMPTY_ARM_REPEAT;
    st = noteArmExpiry(st, sig, 1000);
    expect(st.streak).toBe(1);
    expect(isArmBlocked(st, sig, 1000)).toBe(false);

    st = noteArmExpiry(st, sig, 2000);
    expect(st.streak).toBe(2);
    expect(isArmBlocked(st, sig, 2000)).toBe(false);
  });

  it(`★歯止め: ${ARM_REPEAT_LIMIT}回連続で失効したらその価格を ${ARM_REPEAT_BLOCK_MS / 60_000}分ブロックする`, () => {
    let st = EMPTY_ARM_REPEAT;
    for (let i = 0; i < ARM_REPEAT_LIMIT; i++) st = noteArmExpiry(st, sig, 1000);
    expect(st.streak).toBe(ARM_REPEAT_LIMIT);
    expect(isArmBlocked(st, sig, 1000)).toBe(true);
    // ブロックは期限つき(=永久に締め出さない)。
    expect(isArmBlocked(st, sig, 1000 + ARM_REPEAT_BLOCK_MS - 1)).toBe(true);
    expect(isArmBlocked(st, sig, 1000 + ARM_REPEAT_BLOCK_MS)).toBe(false);
  });

  it('ブロックされるのは「その価格」だけ(別の計画は普通に武装できる=エンジンは止まらない)', () => {
    let st = EMPTY_ARM_REPEAT;
    for (let i = 0; i < ARM_REPEAT_LIMIT; i++) st = noteArmExpiry(st, sig, 1000);
    const other = bracketSignature(buy(64500, 64800)) as string;
    expect(isArmBlocked(st, sig, 1000)).toBe(true);
    expect(isArmBlocked(st, other, 1000)).toBe(false);
  });

  it('別の価格で失効したら連続は 1 に戻る(直近の連続だけを見る)', () => {
    let st = EMPTY_ARM_REPEAT;
    st = noteArmExpiry(st, sig, 1000);
    st = noteArmExpiry(st, sig, 2000);
    expect(st.streak).toBe(2);
    const other = bracketSignature(buy(64500)) as string;
    st = noteArmExpiry(st, other, 3000);
    expect(st.streak).toBe(1);
    expect(st.signature).toBe(other);
    expect(isArmBlocked(st, sig, 3000)).toBe(false);
  });

  it('約定したら歯止めはクリア(その価格帯は到達すると実証された)', () => {
    let st = EMPTY_ARM_REPEAT;
    for (let i = 0; i < ARM_REPEAT_LIMIT; i++) st = noteArmExpiry(st, sig, 1000);
    expect(isArmBlocked(st, sig, 1000)).toBe(true);
    st = noteArmFilled();
    expect(st).toEqual(EMPTY_ARM_REPEAT);
    expect(isArmBlocked(st, sig, 1000)).toBe(false);
  });

  it('★無限ループにならない: 同じ価格を出し続けても武装できるのは連続 LIMIT-1 回まで', () => {
    let st = EMPTY_ARM_REPEAT;
    let arms = 0;
    // 「ブロックされていなければ武装 → 失効」を 50 サイクル繰り返しても、
    // ブロック期限が来るまでに武装できるのは有限回。
    for (let i = 0; i < 50; i++) {
      const now = 1000 + i * 60_000;   // 1分ごと(ブロック60分より短い刻み)
      if (isArmBlocked(st, sig, now)) continue;
      arms++;
      st = noteArmExpiry(st, sig, now);
    }
    // 50分 = ブロック(60分)より短いので、最初の LIMIT 回で打ち止め。
    expect(arms).toBe(ARM_REPEAT_LIMIT);
  });

  it('署名できない失効(レッグ不明)は数えない(歯止めを誤爆させない)', () => {
    let st = EMPTY_ARM_REPEAT;
    st = noteArmExpiry(st, sig, 1000);
    const before = { ...st };
    st = noteArmExpiry(st, null, 2000);
    expect(st).toEqual(before);
  });

  it('describeArmBlock は理由と残り時間を含む', () => {
    let st = EMPTY_ARM_REPEAT;
    for (let i = 0; i < ARM_REPEAT_LIMIT; i++) st = noteArmExpiry(st, sig, 1000);
    const s = describeArmBlock(st, 1000);
    expect(s).toContain(`${ARM_REPEAT_LIMIT}回連続`);
    expect(s).toContain(`あと${ARM_REPEAT_BLOCK_MS / 60_000}分`);
    expect(s).toContain(sig);
  });
});
