import { describe, it, expect } from 'vitest';
import { entryLabel, entryStance, entryPositionOk, type EntryKind, type EntryLabel, type EntryTrendDir } from './entryLabel.js';
// ★同一性の突き合わせ: server/llm/scalpPlan.ts の entrySideOk は **この関数の再輸出** になった。
//   写しではなく import なので理屈の上ではずれ得ないが、「再輸出を実装に戻す」変更が入ったら
//   ここが気づける唯一の場所なので、実際に同じ答えを返すことを固定しておく。
import { entrySideOk } from '../server/llm/scalpPlan.js';

const REF = 68_700;   // 現在値(refPrice)。以降の entry はすべてこの値を基準に置く。

// ─── entryStance: ★順張り/逆張りは「トレンドの向き × 売買の向き」で決まる ────────
describe('entryStance: トレンド × 売買の向き(★脚の種別からは決めない)', () => {
  it('上昇トレンド: 買い=順張り / 売り=逆張り', () => {
    expect(entryStance('buy', 'up')).toBe('trend');
    expect(entryStance('sell', 'up')).toBe('counter');
  });

  it('下降トレンド: 売り=順張り / 買い=逆張り', () => {
    expect(entryStance('sell', 'down')).toBe('trend');
    expect(entryStance('buy', 'down')).toBe('counter');
  });

  it('★断定できないトレンドは undefined(決めない)', () => {
    // 'flat'=横這い / 'conflict'=短期と長期が逆 / 'stale'=材料が古い / 未指定=材料なし。
    // 「分からないものを断定しない」の規範をここで守る(語を出さないための入口)。
    for (const t of ['flat', 'conflict', 'stale', undefined] as (EntryTrendDir | undefined)[]) {
      expect(entryStance('buy', t)).toBeUndefined();
      expect(entryStance('sell', t)).toBeUndefined();
    }
  });

  it('★脚の種別(limit/stop)は stance に一切影響しない', () => {
    // 旧版はここを取り違えて「指値=逆張り」と決め打ちしていた(押し目買いは古典的に順張り)。
    // entryStance の引数に kind が無いこと自体が、その誤りが再発できない形になっている。
    expect(entryLabel('buy', 'limit', 'up').stance).toBe(entryLabel('buy', 'stop', 'up').stance);
    expect(entryLabel('sell', 'limit', 'down').stance).toBe(entryLabel('sell', 'stop', 'down').stance);
  });
});

// ─── entryLabel: 4通り(buy/sell × limit/stop) × トレンドの表 ────────────────
describe('entryLabel: 脚の型は direction×kind / 順張り逆張りは trend×direction', () => {
  const TABLE: readonly (readonly [
    direction: 'buy' | 'sell', kind: EntryKind, trendDir: EntryTrendDir | undefined, expected: EntryLabel,
  ])[] = [
    // 上昇トレンド: 買いはどちらの脚も順張り(★押し目買いが逆張りにならない=旧版で消したかった矛盾)。
    ['buy',  'stop',  'up',   { side: 'buy',  stance: 'trend',   above: true,  text: 'ブレイク新規・順張り' }],
    ['buy',  'limit', 'up',   { side: 'buy',  stance: 'trend',   above: false, text: '押し目買い・順張り' }],
    // 上昇トレンドで売るのは逆張り。
    ['sell', 'stop',  'up',   { side: 'sell', stance: 'counter', above: false, text: 'ブレイク新規・逆張り' }],
    ['sell', 'limit', 'up',   { side: 'sell', stance: 'counter', above: true,  text: '戻り売り・逆張り' }],
    // 下降トレンドは鏡。
    ['sell', 'stop',  'down', { side: 'sell', stance: 'trend',   above: false, text: 'ブレイク新規・順張り' }],
    ['sell', 'limit', 'down', { side: 'sell', stance: 'trend',   above: true,  text: '戻り売り・順張り' }],
    ['buy',  'stop',  'down', { side: 'buy',  stance: 'counter', above: true,  text: 'ブレイク新規・逆張り' }],
    ['buy',  'limit', 'down', { side: 'buy',  stance: 'counter', above: false, text: '押し目買い・逆張り' }],
    // ★トレンドが取れない回は **語を足さない**(脚の型だけ)。stance キーごと生えない。
    ['buy',  'limit', undefined, { side: 'buy',  above: false, text: '押し目買い' }],
    ['buy',  'stop',  'flat',     { side: 'buy',  above: true,  text: 'ブレイク新規' }],
    ['sell', 'limit', 'conflict', { side: 'sell', above: true,  text: '戻り売り' }],
    ['sell', 'stop',  'stale',    { side: 'sell', above: false, text: 'ブレイク新規' }],
  ];

  for (const [direction, kind, trendDir, expected] of TABLE) {
    it(`${direction} × ${kind} × trend=${trendDir ?? 'なし'} → ${expected.text}`, () => {
      expect(entryLabel(direction, kind, trendDir)).toEqual(expected);
    });
  }

  it('★トレンド不明のとき stance キーは **生えない**(undefined を「決めた」ように見せない)', () => {
    const l = entryLabel('buy', 'limit', 'flat');
    expect(Object.prototype.hasOwnProperty.call(l, 'stance')).toBe(false);
  });

  it('★above は「買いの逆指値」と「売りの指値」だけ true(トレンドに依存しない)', () => {
    for (const t of ['up', 'down', 'flat', undefined] as (EntryTrendDir | undefined)[]) {
      expect(entryLabel('buy', 'stop', t).above).toBe(true);
      expect(entryLabel('sell', 'limit', t).above).toBe(true);
      expect(entryLabel('buy', 'limit', t).above).toBe(false);
      expect(entryLabel('sell', 'stop', t).above).toBe(false);
    }
  });

  it('★語彙は既存のものだけ(新語を作っていない)', () => {
    const texts = new Set(
      (['buy', 'sell'] as const).flatMap(d =>
        (['limit', 'stop'] as const).flatMap(k =>
          (['up', 'down', 'flat'] as const).map(t => entryLabel(d, k, t).text))),
    );
    expect([...texts].sort()).toEqual([
      'ブレイク新規', 'ブレイク新規・逆張り', 'ブレイク新規・順張り',
      '押し目買い', '押し目買い・逆張り', '押し目買い・順張り',
      '戻り売り', '戻り売り・逆張り', '戻り売り・順張り',
    ].sort());
  });

  it('★above と entryPositionOk は同じ規約(ラベルの向きと検査の向きがずれない)', () => {
    for (const direction of ['buy', 'sell'] as const) {
      for (const kind of ['limit', 'stop'] as const) {
        const { above } = entryLabel(direction, kind);
        // ラベルが「上」と言うなら、refPrice より上の値だけが合格でなければならない。
        expect(entryPositionOk(direction, kind, REF + 25, REF)).toBe(above);
        expect(entryPositionOk(direction, kind, REF - 25, REF)).toBe(!above);
      }
    }
  });
});

// ─── entryPositionOk: 正しい側 / 誤った側 / 同値 の3系統をすべて ──────────
describe('entryPositionOk: 位置の規約(3系統×4通り)', () => {
  it('正しい側 → true', () => {
    expect(entryPositionOk('buy',  'limit', REF - 25, REF)).toBe(true);   // 買い指値は下
    expect(entryPositionOk('buy',  'stop',  REF + 25, REF)).toBe(true);   // 買い逆指値は上
    expect(entryPositionOk('sell', 'limit', REF + 25, REF)).toBe(true);   // 売り指値は上
    expect(entryPositionOk('sell', 'stop',  REF - 25, REF)).toBe(true);   // 売り逆指値は下
  });

  it('誤った側 → false', () => {
    expect(entryPositionOk('buy',  'limit', REF + 25, REF)).toBe(false);
    expect(entryPositionOk('buy',  'stop',  REF - 25, REF)).toBe(false);
    expect(entryPositionOk('sell', 'limit', REF - 25, REF)).toBe(false);
    expect(entryPositionOk('sell', 'stop',  REF + 25, REF)).toBe(false);
  });

  it('★同値(entry === refPrice)は4通りすべて false(距離0=置いた瞬間に約定する)', () => {
    // 境界を false に倒した理由は entryLabel.ts のコメント参照(core/stopGeometry.ts の
    // stopSideOk が「幅0 は実質ストップにならないので不正」としているのと同じ流儀)。
    expect(entryPositionOk('buy',  'limit', REF, REF)).toBe(false);
    expect(entryPositionOk('buy',  'stop',  REF, REF)).toBe(false);
    expect(entryPositionOk('sell', 'limit', REF, REF)).toBe(false);
    expect(entryPositionOk('sell', 'stop',  REF, REF)).toBe(false);
  });

  it('★1円でも正しい側なら true(刻みの話はしない=幾何だけを見る)', () => {
    expect(entryPositionOk('buy', 'limit', REF - 1, REF)).toBe(true);
    expect(entryPositionOk('buy', 'stop',  REF + 1, REF)).toBe(true);
  });

  it('refPrice が非有限なら判定しない(true=fail-safe・材料が無いときに落とさない)', () => {
    expect(entryPositionOk('buy',  'limit', REF + 25, NaN)).toBe(true);
    expect(entryPositionOk('sell', 'stop',  REF + 25, Infinity)).toBe(true);
  });

  it('entry が非有限なら false(比較が全て false=不正側に落ちる)', () => {
    expect(entryPositionOk('buy', 'limit', NaN, REF)).toBe(false);
    expect(entryPositionOk('buy', 'stop',  NaN, REF)).toBe(false);
  });
});

// ─── ★実際に起きる不正(実データの形) ─────────────────────────────────
describe('★実際に起きる不正: 買い・指値・entry > refPrice(=置いた瞬間に約定)', () => {
  // 実データの形(価格帯・5円刻み)で置く。現在値 68,700 のときの「買い 68,725 指値」。
  // 68,725 で買う指値を 68,700 の相場に置けば、その場で 68,700 で約定してしまう
  // = 「押し目を待って引きつけて入る」という指値レッグの契約を満たしていない。
  const REF_LIVE = 68_700;
  const BAD_LIMIT = 68_725;

  it('entryPositionOk が false を返す', () => {
    expect(entryPositionOk('buy', 'limit', BAD_LIMIT, REF_LIVE)).toBe(false);
  });

  it('★ラベル側は「現在値より下」と言っている=表示と実データが矛盾している', () => {
    const label = entryLabel('buy', 'limit', 'up');
    expect(label.above).toBe(false);              // ラベルの主張: 現在値より下
    expect(BAD_LIMIT > REF_LIVE).toBe(true);      // 実データ: 現在値より上
    // → 画面はこの矛盾を **黙って正常に見せてはいけない**(signalPanel が印を付ける)。
  });

  it('同じ価格でも「逆指値(ブレイク新規)」としてなら正しい配置', () => {
    expect(entryPositionOk('buy', 'stop', BAD_LIMIT, REF_LIVE)).toBe(true);
  });
});

// ─── server 側(scalpPlan.entrySideOk)との同一性 ───────────────────────
describe('scalpPlan.entrySideOk は entryPositionOk の再輸出(挙動が1ビットも違わない)', () => {
  it('関数の同一性', () => {
    expect(entrySideOk).toBe(entryPositionOk);
  });

  it('4通り × (下 / 同値 / 上) の全12組で答えが一致する', () => {
    for (const direction of ['buy', 'sell'] as const) {
      for (const kind of ['limit', 'stop'] as const) {
        for (const entry of [REF - 25, REF, REF + 25]) {
          expect(entrySideOk(direction, kind, entry, REF))
            .toBe(entryPositionOk(direction, kind, entry, REF));
        }
      }
    }
  });
});
