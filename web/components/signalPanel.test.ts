import { describe, it, expect } from 'vitest';
import { buildSignalView, buildPositionView, splitRationaleLines, type SignalTradeState } from './signalPanel.js';

// ─── シグナル枠(buildSignalView): 現在シグナル(s.signal)を常時描く=保有中も消えない ───
describe('buildSignalView(シグナル枠)', () => {
  it('signal 無しは「シグナル待機」', () => {
    expect(buildSignalView(null).main).toBe('シグナル待機');
    expect(buildSignalView({ phase: 'flat', updatedAt: 0 }).main).toBe('シグナル待機');
  });

  // ★未約定失効(armed-timeout)= 武装したのに一度も約定せず15分で失効した件数。
  //   monitor が武装 → trade2 が受信後ずっと拒否 → 黙って失効、という乖離が **画面から見えない** のが
  //   実害だった(実測 sid=361 は trade2 が147回拒否したのに、monitor 側の画面には何も出なかった)。
  //   ★v0.9.59: 表示は「累計」から「連続失効(約定でリセット)」へ切り替え、待ち時間と目線を添える。
  //     累計(count)は無音の失敗を数える指標として state には残るが、画面には出さない。
  it('★未約定失効が起きていれば待機表示に連続回数を出す(0件/欠落では従来と同じ文字列)', () => {
    expect(buildSignalView({ phase: 'flat', updatedAt: 0, armedTimeout: { count: 27, streak: 3, lastAt: 1, waitMin: 15, bias: 'buy' } }).main)
      .toBe('シグナル待機（連続失効 15分3回 / 現在買い目線）');
    // 決済済みシグナルで待機に戻る経路でも出る(同じ待機文言を共有する)。
    const exited: SignalTradeState = {
      phase: 'flat', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, at: 10 },
      lastExit: { exitPrice: 65400, pnl: 5, at: 20 },
      armedTimeout: { count: 1, streak: 1, lastAt: 1, waitMin: 15, bias: 'sell' },
    };
    expect(buildSignalView(exited).main).toBe('シグナル待機（連続失効 15分1回 / 現在売り目線）');
    // 0件は従来どおり。★累計が積み上がっていても連続 0 なら「シグナル待機」に戻る。
    expect(buildSignalView({ phase: 'flat', updatedAt: 0, armedTimeout: { count: 0, streak: 0, lastAt: 0 } }).main)
      .toBe('シグナル待機');
    expect(buildSignalView({ phase: 'flat', updatedAt: 0, armedTimeout: { count: 27, streak: 0, lastAt: 1 } }).main)
      .toBe('シグナル待機');
  });

  it('現在シグナル(指値/逆指値+LC)を「🎯 シグナル：…」で描き、理由も出す', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, stopLossForLimit: 65345, stopEntry: 65520, stopLossForStop: 65470, rationale: '押し目買い', at: 1 },
    };
    const v = buildSignalView(s);
    expect(v.cls).toBe('armed');
    expect(v.bias).toBe('買い目線');
    expect(v.main).toContain('買い 65,395 指値 (LC 65,345)');
    expect(v.main).toContain('買い 65,520 逆指値 (LC 65,470)');
    expect(v.rationale).toBe('押し目買い');
  });

  it('★ドテン(反転)シグナルは目線行に「🔃 ドテン(反転)」を明示・非dotenは従来どおり', () => {
    const doten: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'sell', limitEntry: 66000, stopLossForLimit: 66050, at: 1, doten: true },
    };
    const v = buildSignalView(doten);
    expect(v.bias).toBe('🔃 ドテン(反転)・売り目線');
    expect(v.main).toContain('売り 66,000 指値 (LC 66,050)');
    // 非 doten は従来の目線行のまま(マーカーなし)。
    const normal: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'sell', limitEntry: 66000, stopLossForLimit: 66050, at: 1 },
    };
    expect(buildSignalView(normal).bias).toBe('売り目線');
  });

  it('★目線行: 買い→買い目線 / 売り→売り目線 / range→レンジ / 待機は目線なし', () => {
    const sell: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'sell', limitEntry: 66000, stopLossForLimit: 66050, at: 1 },
    };
    expect(buildSignalView(sell).bias).toBe('売り目線');
    const range: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'buy', mode: 'range', at: 1,
        range: { upper: { side: 'sell', type: 'limit', entry: 66000, stopLoss: 66050 },
                 lower: { side: 'buy', type: 'limit', entry: 65600, stopLoss: 65550 } } },
    };
    expect(buildSignalView(range).bias).toBe('レンジ');
    expect(buildSignalView(null).bias).toBeUndefined();   // 待機は目線なし
  });

  it('★保有中(filled + position)でも signal がある限りシグナルを描き続ける(消えない)', () => {
    const s: SignalTradeState = {
      phase: 'filled', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, stopLossForLimit: 65345, rationale: 'r', at: 1 },
      position: { direction: 'buy', entryPrice: 65395, qty: 1, unrealized: 30, at: 2 },
    };
    const v = buildSignalView(s);
    expect(v.main).toContain('🎯 シグナル');
    expect(v.main).toContain('65,395 指値');
    expect(v.main).not.toContain('保有');   // 保有はシグナル枠には出さない(別枠)
  });

  it('★A案: 決済で即クリア。sig.at <= lastExit.at(既決済トレードのシグナル)は「シグナル待機」に戻る', () => {
    const s: SignalTradeState = {
      phase: 'flat', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, stopLossForLimit: 65345, rationale: 'r', at: 10 },
      lastExit: { exitPrice: 65500, pnl: 105, at: 20 },
    };
    const v = buildSignalView(s);
    expect(v.cls).toBe('flat');
    expect(v.main).toBe('シグナル待機');
  });

  it('決済後に来た新シグナル(sig.at > lastExit.at)は再び描く(🎯)', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, stopLossForLimit: 65345, rationale: 'r', at: 30 },
      lastExit: { exitPrice: 65500, pnl: 105, at: 20 },
    };
    const v = buildSignalView(s);
    expect(v.cls).toBe('armed');
    expect(v.main).toContain('🎯 シグナル');
  });

  it('★保有中(filled) + 前トレードの古い lastExit(sig.at > lastExit.at)は描き続ける(v0.9.0維持)', () => {
    const s: SignalTradeState = {
      phase: 'filled', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, stopLossForLimit: 65345, rationale: 'r', at: 30 },
      position: { direction: 'buy', entryPrice: 65395, qty: 1, unrealized: 30, at: 31 },
      lastExit: { exitPrice: 64000, pnl: -50, at: 20 },
    };
    const v = buildSignalView(s);
    expect(v.main).toContain('🎯 シグナル');
  });

  it('lastExit が無い(初回)ときは抑制しない(描く)', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, stopLossForLimit: 65345, rationale: 'r', at: 10 },
    };
    expect(buildSignalView(s).main).toContain('🎯 シグナル');
  });

  it('sig.at 欠落 + lastExit 有りは抑制しない(安全側=表示)', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, stopLossForLimit: 65345, rationale: 'r' },
      lastExit: { exitPrice: 65500, pnl: 105, at: 20 },
    };
    expect(buildSignalView(s).main).toContain('🎯 シグナル');
  });

  it('レンジ両面は上下レッグを描く', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', mode: 'range', rationale: 'range', at: 1,
        range: {
          upper: { side: 'sell', type: 'limit', entry: 66000, stopLoss: 66050 },
          lower: { side: 'buy', type: 'limit', entry: 65000, stopLoss: 64950 },
        },
      },
    };
    const v = buildSignalView(s);
    expect(v.main).toContain('🎯 レンジ');
    expect(v.main).toContain('売り66,000指値(上)');
    expect(v.main).toContain('買い65,000指値(下)');
  });
});

// ─── 理由文の行分解(splitRationaleLines): コード側の脚 drop 注記(\n 区切り)を読める形で描くため ───
//   注記は `${rationale}\n※上部(売り指値)は不採用: …` の形で足される。1要素に textContent で入れると
//   CSS(white-space:normal)で改行が潰れて本文に埋もれるので、行に分けて別要素で描く。
describe('splitRationaleLines(理由文の行分解)', () => {
  it('\\n 区切りを行に分ける(前後の空白は落とす)', () => {
    expect(splitRationaleLines('レンジと判断\n※上部(売り指値)は不採用: トレンドに逆行'))
      .toEqual(['レンジと判断', '※上部(売り指値)は不採用: トレンドに逆行']);
  });

  it('注記が複数行でも全部残る(片側だけになった理由が読める)', () => {
    const t = '上下に反応帯\n※上部(売り指値)は不採用: エントリーが現在値の逆側\n※下部(買い指値)は不採用: 損切り幅が設定の上限より広い';
    expect(splitRationaleLines(t)).toHaveLength(3);
    expect(splitRationaleLines(t)[2]).toBe('※下部(買い指値)は不採用: 損切り幅が設定の上限より広い');
  });

  it('空行・空文字は落とす(改行のみの文字列は空配列)', () => {
    expect(splitRationaleLines('本文\n\n※注記')).toEqual(['本文', '※注記']);
    expect(splitRationaleLines('')).toEqual([]);
    expect(splitRationaleLines('\n \n')).toEqual([]);
  });

  it('改行が無い従来の理由文は1行のまま(挙動不変)', () => {
    expect(splitRationaleLines('押し目買い。直近安値が支持。')).toEqual(['押し目買い。直近安値が支持。']);
  });
});

// ─── 保有枠(buildPositionView): 建値+含み / 直近決済 / 保有なし。シグナルとは独立 ───
describe('buildPositionView(保有枠)', () => {
  const NOW = 1_000_000;

  it('無保有は「保有なし」', () => {
    expect(buildPositionView(null, NOW).main).toBe('保有なし');
    expect(buildPositionView({ phase: 'flat', updatedAt: 0 }, NOW).main).toBe('保有なし');
  });

  it('保有中は建値と含み(pt)を描く(決済逆指値は出さない)', () => {
    const s: SignalTradeState = {
      phase: 'filled', updatedAt: 0,
      position: { direction: 'buy', entryPrice: 65395, qty: 1, unrealized: 120, at: 2 },
    };
    const v = buildPositionView(s, NOW);
    expect(v.cls).toBe('filled');
    expect(v.main).toBe('● 保有：買い @65,395（含み +120）');
  });

  it('直近決済は数十秒だけ「✔ 決済 …」を出し、以降は「保有なし」', () => {
    const s: SignalTradeState = { phase: 'flat', updatedAt: 0, lastExit: { exitPrice: 65500, pnl: 105, at: NOW - 1000 } };
    expect(buildPositionView(s, NOW).main).toBe('✔ 決済 65,500（+105）');
    // 40秒超で消える
    expect(buildPositionView(s, NOW + 41_000).main).toBe('保有なし');
  });
});
