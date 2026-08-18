import { describe, it, expect } from 'vitest';
import { buildSignalView, buildPositionView, splitRationaleLines, buildWaitMain, withStrategyLabel, buildRationaleView, buildLevelBasis, basisTail, type SignalTradeState } from './signalPanel.js';
import { stripLcArithmetic } from '../../core/rationaleDisplay.js';

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

// ─── ★画面から LC幅の検算だけを落とす(生成側のプロンプトは不変) ───
//   実測 2026-08-17 の画面には、根拠文が「LC幅の引き算」だけ2文並んでいて
//   「なぜ買い目線か / なぜこの価格か」が1文も無かった。検算は符号の保持に効いている
//   (式を外すと stopSide 落ちが 10→30件)ので **プロンプトからは外さず、表示だけ落とす**。
//   落とす純関数の境界は core/rationaleDisplay.test.ts が固定する。ここは配線の確認。
describe('buildSignalView: rationale から LC検算を落とす', () => {
  // ★ユーザーが実際に貼った文字列。
  const REAL_LC = '指値レッグ 68725 と 68665 の引き算 → LC幅は60円。ブレイク新規レッグ 68780 と 68840 の引き算 → LC幅は60円。';

  it('理由の本文が在れば、LC検算の文だけ消えて本文が残る', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 68725, stopLossForLimit: 68665, at: 1, rationale: `68700の節目を上抜けて押し目待ち。${REAL_LC}` },
    };
    expect(buildSignalView(s).rationale).toBe('68700の節目を上抜けて押し目待ち。');
  });

  it('★検算しか無い(=全部落ちる)ときは「（理由の記載なし）」を出す(無言で空にしない)', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 68725, stopLossForLimit: 68665, at: 1, rationale: REAL_LC },
    };
    // 元文字列を戻す設計にはしない(実測でほとんどの回が検算だけ=画面が何も変わらなくなる)。
    // 空にもしない(AI が書かなかったのか剥がし過ぎたのか区別できない=無音の失敗になる)。
    expect(buildSignalView(s).rationale).toBe('（理由の記載なし）');
  });

  it('★コード側が足す注記(※…/（逆指値は不採用: …）)は残る', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', limitEntry: 68725, stopLossForLimit: 68665, at: 1,
        rationale: `押し目買い。${REAL_LC}\n※上部(売り指値)は不採用: 損切り幅が設定の下限より狭い`,
      },
    };
    expect(splitRationaleLines(buildSignalView(s).rationale))
      .toEqual(['押し目買い。', '※上部(売り指値)は不採用: 損切り幅が設定の下限より狭い']);
  });
});

// ─── ★待機理由(なぜ待機なのか)をかっこで出す ───
describe('buildWaitMain: 待機理由(waitReason)', () => {
  // 2026-08-17 10:30 JST = 2026-08-17T01:30:00Z
  const UNTIL = Date.UTC(2026, 7, 17, 1, 30, 0);

  it('クールダウンは解除時刻(JST HH:MM)を出す', () => {
    expect(buildWaitMain(null, { kind: 'cooldown', untilMs: UNTIL })).toBe('シグナル待機（10:30までクールダウン）');
  });

  it('節目クロス待ち', () => {
    expect(buildWaitMain(null, { kind: 'level' })).toBe('シグナル待機（節目クロス待ち）');
  });

  // ★取引時間外。語彙は画面の他所(価格ボード/指標パネル/API状態)と同じ「取引時間外」を使う=新語を作らない。
  //   引け後にアプリを開いたとき、engine が実際に止めている理由はこれ(以前は「節目クロス待ち」と嘘が出ていた)。
  it('取引時間外', () => {
    expect(buildWaitMain(null, { kind: 'closed' })).toBe('シグナル待機（取引時間外）');
    expect(buildWaitMain({ count: 3, streak: 1, lastAt: 1, waitMin: 15, bias: 'sell' }, { kind: 'closed' }))
      .toBe('シグナル待機（取引時間外 / 連続失効 15分1回 / 現在売り目線）');
  });

  it('★既存の連続失効表示は壊さない(両方あるときは併記)', () => {
    // 理由なし=従来と1バイトも同じ
    expect(buildWaitMain({ count: 27, streak: 2, lastAt: 1, waitMin: 15, bias: 'buy' }))
      .toBe('シグナル待機（連続失効 15分2回 / 現在買い目線）');
    expect(buildWaitMain({ count: 27, streak: 2, lastAt: 1, waitMin: 15, bias: 'buy' }, { kind: 'cooldown', untilMs: UNTIL }))
      .toBe('シグナル待機（10:30までクールダウン / 連続失効 15分2回 / 現在買い目線）');
  });

  it('理由も失効も無ければ従来どおり「シグナル待機」', () => {
    expect(buildWaitMain(null, null)).toBe('シグナル待機');
    expect(buildWaitMain(undefined, undefined)).toBe('シグナル待機');
    // 解除時刻が壊れている場合はその部分ごと出さない(空括弧を作らない)
    expect(buildWaitMain(null, { kind: 'cooldown', untilMs: Number.NaN })).toBe('シグナル待機');
  });

  it('buildSignalView(シグナル無し)から waitReason が配線されている', () => {
    expect(buildSignalView({ phase: 'flat', updatedAt: 0, waitReason: { kind: 'cooldown', untilMs: UNTIL } }).main)
      .toBe('シグナル待機（10:30までクールダウン）');
  });
});

// ─── ★v0.9.86: AI の「相場の読み」(strategy / strategyWhy)を画面へ配線する ───
//   v0.9.85 で AI に読みを出させ台帳(signal_plans)に記録したが、**SSE にも画面にも1行も配線していなかった**。
//   ここは AiPlan → ArmedBracket → CurrentSignal → SSE → パネル の最後の1段(表示)を固定する。
//   ★欠落(旧版のシグナル / AI が書かなかった回)では **従来の表示に byte 一致で縮退** すること。
describe('buildSignalView: 相場の読み(strategy / strategyWhy)', () => {
  const LC_ONLY = '指値レッグ 68725 と 68665 の引き算 → LC幅は60円。ブレイク新規レッグ 68780 と 68840 の引き算 → LC幅は60円。';
  const sig = (extra: Partial<NonNullable<SignalTradeState['signal']>>): SignalTradeState => ({
    phase: 'armed', updatedAt: 0,
    signal: {
      direction: 'buy', limitEntry: 68725, stopLossForLimit: 68665,
      stopEntry: 68780, stopLossForStop: 68720, at: 1, ...extra,
    },
  });

  // ① ラベルあり × why あり(= ユーザーが見たい形。実測の rationale は検算だけなので理由行は why のみ)
  it('ラベルは目線行に `・` で添え、why は理由の行に出す', () => {
    const v = buildSignalView(sig({ rationale: LC_ONLY, strategy: 'トレンド押し目・戻り', strategyWhy: '上昇トレンド中、S1まで引きつけて反発を取る' }));
    expect(v.bias).toBe('買い目線・トレンド押し目・戻り');
    expect(v.main).toBe('🎯 シグナル：買い 68,725 指値 (LC 68,665) / 買い 68,780 逆指値 (LC 68,720)');
    // ★why が在るなら「（理由の記載なし）」は出さない(読みは書かれている)。
    expect(v.rationale).toBe('上昇トレンド中、S1まで引きつけて反発を取る');
  });

  // ② ラベルあり × why なし
  it('why が無ければ理由の行は従来どおり(rationale の残り or 「（理由の記載なし）」)', () => {
    const v = buildSignalView(sig({ rationale: `68700の節目を上抜けて押し目待ち。${LC_ONLY}`, strategy: 'ブレイク順張り' }));
    expect(v.bias).toBe('買い目線・ブレイク順張り');
    expect(v.rationale).toBe('68700の節目を上抜けて押し目待ち。');
    const v2 = buildSignalView(sig({ rationale: LC_ONLY, strategy: 'ブレイク順張り' }));
    expect(v2.rationale).toBe('（理由の記載なし）');
  });

  // ③ ラベルなし × why あり
  it('ラベルが無ければ目線行は従来どおり(空の `・` を作らない)', () => {
    const v = buildSignalView(sig({ rationale: LC_ONLY, strategyWhy: '押し安値を割らない前提で拾う' }));
    expect(v.bias).toBe('買い目線');
    expect(v.rationale).toBe('押し安値を割らない前提で拾う');
    // 空白だけのラベルも「無い」と同じ(undefined を文字にしない)。
    expect(buildSignalView(sig({ rationale: LC_ONLY, strategy: '   ' })).bias).toBe('買い目線');
    expect(buildSignalView(sig({ rationale: LC_ONLY, strategy: '' })).bias).toBe('買い目線');
  });

  // ④ 両方なし = ★否定対照(従来と byte 一致)
  it('★両方無い(旧版のシグナル)ときは従来の表示と byte 一致', () => {
    const before = buildSignalView(sig({ rationale: `68700の節目を上抜けて押し目待ち。${LC_ONLY}` }));
    expect(before.bias).toBe('買い目線');
    expect(before.rationale).toBe('68700の節目を上抜けて押し目待ち。');
    expect(buildSignalView(sig({ rationale: LC_ONLY })).rationale).toBe('（理由の記載なし）');
    // rationale ごと無い回も従来どおり空(NO_REASON を作らない)。
    expect(buildSignalView(sig({})).rationale).toBe('');
  });

  it('why と rationale の本文が両方あるときは why が先・本文が後の別行', () => {
    const v = buildSignalView(sig({
      rationale: `68700の節目を上抜けて押し目待ち。${LC_ONLY}`,
      strategy: 'トレンド押し目・戻り', strategyWhy: '上昇トレンド中、S1まで引きつけて反発を取る',
    }));
    expect(splitRationaleLines(v.rationale))
      .toEqual(['上昇トレンド中、S1まで引きつけて反発を取る', '68700の節目を上抜けて押し目待ち。']);
  });

  it('why と完全一致する行だけは重複を落とす(部分一致では落とさない)', () => {
    const same = buildSignalView(sig({ rationale: '押し目を待つ。', strategy: 'トレンド押し目・戻り', strategyWhy: '押し目を待つ。' }));
    expect(splitRationaleLines(same.rationale)).toEqual(['押し目を待つ。']);
    const near = buildSignalView(sig({ rationale: '押し目を待つ。上ヒゲが続いている。', strategyWhy: '押し目を待つ。' }));
    expect(splitRationaleLines(near.rationale)).toEqual(['押し目を待つ。', '押し目を待つ。上ヒゲが続いている。']);
  });

  it('コード側の注記(※…)は why の後ろにそのまま残る', () => {
    const v = buildSignalView(sig({
      rationale: `${LC_ONLY}\n※上部(売り指値)は不採用: 損切り幅が設定の下限より狭い`,
      strategyWhy: '上昇トレンド中、S1まで引きつけて反発を取る',
    }));
    expect(splitRationaleLines(v.rationale))
      .toEqual(['上昇トレンド中、S1まで引きつけて反発を取る', '※上部(売り指値)は不採用: 損切り幅が設定の下限より狭い']);
  });

  it('★一覧(SCALP_STRATEGY_LABELS)外のラベルも丸めずそのまま出す', () => {
    expect(buildSignalView(sig({ rationale: LC_ONLY, strategy: '寄り天狙い' })).bias).toBe('買い目線・寄り天狙い');
  });

  it('ドテンの目線行の書式を壊さない(既存の `・` の後ろに足すだけ・★ただし語の重複は作らない)', () => {
    // ★v0.9.87 で修正: v0.9.86 はここで「🔃 ドテン(反転)・買い目線・ドテン」と **ドテンを2回** 出していた。
    //   目線行に既に現れている語は足さない(下の「別ラベルなら足す」で、足す側の挙動は残っていることを固定)。
    const v = buildSignalView(sig({ rationale: LC_ONLY, doten: true, strategy: 'ドテン', strategyWhy: '上昇転換で保有の売りを畳む' }));
    expect(v.bias).toBe('🔃 ドテン(反転)・買い目線');
    expect(v.rationale).toBe('上昇転換で保有の売りを畳む');
    // ドテンでも「ドテン」以外のラベルは従来どおり後ろに足す。
    expect(buildSignalView(sig({ rationale: LC_ONLY, doten: true, strategy: 'ブレイク順張り' })).bias)
      .toBe('🔃 ドテン(反転)・買い目線・ブレイク順張り');
    // ラベルが無いドテンは従来どおり。
    expect(buildSignalView(sig({ rationale: LC_ONLY, doten: true })).bias).toBe('🔃 ドテン(反転)・買い目線');
  });

  it('レンジ両面でもラベル/why を出す(無ければ従来どおり)', () => {
    const range: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', at: 1, mode: 'range', rationale: LC_ONLY,
        range: {
          upper: { side: 'sell', type: 'limit', entry: 68900, stopLoss: 68960 },
          lower: { side: 'buy', type: 'limit', entry: 68700, stopLoss: 68640 },
        },
        strategy: 'レンジ内', strategyWhy: '上下端が効いているので両側で待つ',
      },
    };
    const v = buildSignalView(range);
    expect(v.bias).toBe('レンジ・レンジ内');
    expect(v.rationale).toBe('上下端が効いているので両側で待つ');
    const bare: SignalTradeState = { ...range, signal: { ...range.signal!, strategy: undefined, strategyWhy: undefined } };
    expect(buildSignalView(bare).bias).toBe('レンジ');
    expect(buildSignalView(bare).rationale).toBe('（理由の記載なし）');
  });

  it('signal が無く entry だけの経路(後方互換)でもラベル/why を落とさない', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      entry: {
        direction: 'sell', limitEntry: 68900, stopLossForLimit: 68960, at: 1, rationale: LC_ONLY,
        strategy: '節目の逆張り', strategyWhy: '68900の戻り売り',
      },
    };
    const v = buildSignalView(s);
    expect(v.bias).toBe('売り目線・節目の逆張り');
    expect(v.rationale).toBe('68900の戻り売り');
  });
});

// ─── 純関数そのもの(組み立ての境界を直接固定する) ───
describe('withStrategyLabel / buildRationaleView', () => {
  it('withStrategyLabel: 無い/空白は目線行を1バイトも変えない', () => {
    expect(withStrategyLabel('買い目線', 'ブレイク順張り')).toBe('買い目線・ブレイク順張り');
    expect(withStrategyLabel('買い目線', undefined)).toBe('買い目線');
    expect(withStrategyLabel('買い目線', '')).toBe('買い目線');
    expect(withStrategyLabel('買い目線', ' \n ')).toBe('買い目線');
    // 前後の空白は落とすが、語そのものは丸めない。
    expect(withStrategyLabel('レンジ', '  その他  ')).toBe('レンジ・その他');
  });

  it('buildRationaleView: why が無ければ stripLcArithmetic と byte 一致(否定対照)', () => {
    const texts = ['', '押し目買い。', 'LC幅は60円。', '押し目買い。LC幅は60円。', '押し目買い。\n※上部(売り指値)は不採用: 幅が狭い'];
    for (const t of texts) {
      expect(buildRationaleView(t, undefined)).toBe(stripLcArithmetic(t));
      expect(buildRationaleView(t, '  ')).toBe(stripLcArithmetic(t));
    }
    expect(buildRationaleView(undefined, undefined)).toBe('');
  });

  it('buildRationaleView: why が在れば「（理由の記載なし）」は出さない', () => {
    expect(buildRationaleView('LC幅は60円。', '押し目を取る')).toBe('押し目を取る');
    expect(buildRationaleView(undefined, '押し目を取る')).toBe('押し目を取る');
    expect(buildRationaleView('', '押し目を取る')).toBe('押し目を取る');
  });
});

// ─── ★v0.9.87: 「なぜこの価格なのか」= どの節目に基づいて置いたか ──────────────
//
// ■ 何を守るテストか
//   この仕組みの価格は必ず節目から導かれる契約(指値=節目の内側 / ブレイク新規=節目の外側)なので、
//   **どの節目を使ったか** が「なぜこの価格か」の答えになる。AI は節目の価格を数値で申告するだけで、
//   内側/外側と距離は **画面側が計算する**(AI に書かせない=嘘の表示を作らない)。
//   ★4象限すべてを固定する。取り違えると「25円内側」と書きながら実は外側、という嘘の画面になる。
//
// ★否定対照: 節目の申告が無い回は PanelView に basis を **付けない**=従来と byte 一致(下で JSON 比較)。
describe('★buildLevelBasis / basisTail(節目の行・4象限)', () => {
  it('買い・指値: 節目(支持)の上に置く=内側', () => {
    // 数直線: 68,700(節目) ── 68,725(指値) ── 現在値 →
    expect(basisTail('buy', 'limit', 68725, 68700)).toBe('の 25円内側');
  });
  it('買い・逆指値(ブレイク新規): 節目(抵抗)の上に置く=外側', () => {
    // 数直線: ← 現在値 ── 68,775(節目) ── 68,780(逆指値)
    expect(basisTail('buy', 'stop', 68780, 68775)).toBe('の 5円外側');
  });
  it('売り・指値: 節目(抵抗)の下に置く=内側', () => {
    // 数直線: ← 現在値 ── 68,775(指値) ── 68,800(節目)
    expect(basisTail('sell', 'limit', 68775, 68800)).toBe('の 25円内側');
  });
  it('売り・逆指値(ブレイク新規): 節目(支持)の下に置く=外側', () => {
    // 数直線: 68,695(逆指値) ── 68,700(節目) ── 現在値 →
    expect(basisTail('sell', 'stop', 68695, 68700)).toBe('の 5円外側');
  });

  // ★反対側に置いた回(契約違反)も **そのまま正直に** 出す。丸めて「内側」と言わない。
  it('契約と逆の側に置いた回は逆の語になる(4象限の裏)', () => {
    expect(basisTail('buy', 'limit', 68690, 68700)).toBe('の 10円外側');   // 支持を割った位置の指値
    expect(basisTail('buy', 'stop', 68770, 68775)).toBe('の 5円内側');     // 抵抗の手前の逆指値
    expect(basisTail('sell', 'limit', 68810, 68800)).toBe('の 10円外側');
    expect(basisTail('sell', 'stop', 68705, 68700)).toBe('の 5円内側');
  });

  it('節目そのものに置いた回は「ちょうど」(内も外も無いので向きを作らない)', () => {
    expect(basisTail('buy', 'limit', 68700, 68700)).toBe('ちょうど');
    expect(basisTail('sell', 'stop', 68700, 68700)).toBe('ちょうど');
    expect(buildLevelBasis('buy', { limitEntry: 68700, limitLevel: 68700 })).toBe('指値 ← 68,700 ちょうど');
  });

  it('両脚そろえば1行に並ぶ(依頼どおりの書式)', () => {
    expect(buildLevelBasis('buy', {
      limitEntry: 68725, limitLevel: 68700, stopEntry: 68780, stopLevel: 68775,
    })).toBe('指値 ← 68,700 の 25円内側 ／ 逆指値 ← 68,775 の 5円外側');
  });

  it('★節目が申告されていない脚は出さない(「不明」と書かない)', () => {
    // 逆指値レッグは在るが節目の申告が無い → 指値の分だけ出す。
    expect(buildLevelBasis('buy', { limitEntry: 68725, limitLevel: 68700, stopEntry: 68780 }))
      .toBe('指値 ← 68,700 の 25円内側');
    // 節目は申告されたがその脚が落ちている(entry が無い) → 孤立した節目は出さない。
    expect(buildLevelBasis('buy', { limitEntry: 68725, limitLevel: 68700, stopLevel: 68775 }))
      .toBe('指値 ← 68,700 の 25円内側');
    expect(buildLevelBasis('sell', { stopEntry: 68695, stopLevel: 68700 }))
      .toBe('逆指値 ← 68,700 の 5円外側');
  });

  it('両方とも申告が無ければ空文字(=行ごと出さない)', () => {
    expect(buildLevelBasis('buy', { limitEntry: 68725, stopEntry: 68780 })).toBe('');
    expect(buildLevelBasis('buy', {})).toBe('');
  });

  it('壊れた値(NaN/Infinity)でも行を作らない(嘘の距離を出さない)', () => {
    expect(buildLevelBasis('buy', { limitEntry: 68725, limitLevel: NaN })).toBe('');
    expect(buildLevelBasis('buy', { limitEntry: 68725, limitLevel: Infinity })).toBe('');
    expect(buildLevelBasis('buy', { limitEntry: NaN, limitLevel: 68700 })).toBe('');
  });
});

describe('★buildSignalView: 節目の行を画面へ出す', () => {
  const SIG = {
    phase: 'armed' as const, updatedAt: 0,
    signal: {
      direction: 'buy' as const,
      limitEntry: 68725, stopLossForLimit: 68665,
      stopEntry: 68780, stopLossForStop: 68720,
      rationale: '上昇トレンド中、押し目を拾う', at: 10,
    },
  };

  it('両脚に節目があれば理由の最後の行として出る(依頼の完成形)', () => {
    const v = buildSignalView({
      ...SIG,
      signal: { ...SIG.signal, strategy: 'トレンド押し目・戻り', limitLevel: 68700, stopLevel: 68775 },
    });
    expect(v.bias).toBe('買い目線・トレンド押し目・戻り');
    expect(v.main).toBe('🎯 シグナル：買い 68,725 指値 (LC 68,665) / 買い 68,780 逆指値 (LC 68,720)');
    expect(v.basis).toBe('指値 ← 68,700 の 25円内側 ／ 逆指値 ← 68,775 の 5円外側');
  });

  it('売りでも同じ経路で出る', () => {
    const v = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'sell', limitEntry: 68775, stopLossForLimit: 68835,
        stopEntry: 68695, stopLossForStop: 68755,
        rationale: '戻り売り', at: 10, limitLevel: 68800, stopLevel: 68700,
      },
    });
    expect(v.basis).toBe('指値 ← 68,800 の 25円内側 ／ 逆指値 ← 68,700 の 5円外側');
  });

  it('片脚だけならその脚だけ出る', () => {
    const v = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 68725, stopLossForLimit: 68665, rationale: '押し目', at: 10, limitLevel: 68700 },
    });
    expect(v.basis).toBe('指値 ← 68,700 の 25円内側');
  });

  it('★否定対照: 節目の申告が無い回は PanelView が従来と byte 一致(basis キーも生えない)', () => {
    const before = buildSignalView(SIG);
    expect(Object.prototype.hasOwnProperty.call(before, 'basis')).toBe(false);
    expect(JSON.stringify(before)).toBe(JSON.stringify({
      cls: 'armed',
      bias: '買い目線',
      main: '🎯 シグナル：買い 68,725 指値 (LC 68,665) / 買い 68,780 逆指値 (LC 68,720)',
      rationale: '上昇トレンド中、押し目を拾う',
    }));
    // 落ちた脚の節目だけが申告されていても、行は生えない(孤立した節目を見せない)。
    const onlyDropped = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 68725, stopLossForLimit: 68665, rationale: '押し目', at: 10, stopLevel: 68775 },
    });
    expect(onlyDropped.basis).toBeUndefined();
  });

  it('レンジ両面は対象外(上下2レッグへの対応づけが無いので憶測で結びつけない)', () => {
    const v = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', at: 10, rationale: 'レンジ', mode: 'range',
        limitLevel: 68700, stopLevel: 68775,
        range: {
          upper: { side: 'sell', type: 'limit', entry: 68900, stopLoss: 68960 },
          lower: { side: 'buy', type: 'limit', entry: 68700, stopLoss: 68640 },
        },
      },
    });
    expect(v.basis).toBeUndefined();
  });
});

describe('★ドテンの重複表示(直前のコミットのバグ)', () => {
  const doten = (strategy?: string): string | undefined => buildSignalView({
    phase: 'armed', updatedAt: 0,
    signal: { direction: 'buy', limitEntry: 68725, stopLossForLimit: 68665, rationale: '反転', at: 10, doten: true, strategy },
  }).bias;

  it('ラベルが「ドテン」でも目線行に2回出さない', () => {
    // ★以前は「🔃 ドテン(反転)・買い目線・ドテン」になっていた。
    expect(doten('ドテン')).toBe('🔃 ドテン(反転)・買い目線');
  });

  it('別のラベルなら従来どおり添える(ドテンの書式は壊さない)', () => {
    expect(doten('ブレイク順張り')).toBe('🔃 ドテン(反転)・買い目線・ブレイク順張り');
    expect(doten()).toBe('🔃 ドテン(反転)・買い目線');
  });

  it('withStrategyLabel 単体: 既に現れている語は足さない/現れていない語は足す', () => {
    expect(withStrategyLabel('🔃 ドテン(反転)・買い目線', 'ドテン')).toBe('🔃 ドテン(反転)・買い目線');
    expect(withStrategyLabel('買い目線', 'ドテン')).toBe('買い目線・ドテン');
    expect(withStrategyLabel('買い目線', 'トレンド押し目・戻り')).toBe('買い目線・トレンド押し目・戻り');
  });
});
