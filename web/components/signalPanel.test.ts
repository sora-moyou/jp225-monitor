import { describe, it, expect } from 'vitest';
import { buildSignalView, buildPositionView, splitRationaleLines, buildWaitMain, withStrategyLabel, buildRationaleView, buildLevelBasis, basisTail, buildEntryStance, buildWhyLines, buildSignalSections, extractLegDropNotes, cleanAiText, DISPLAY_TRUNCATED_MARK, type SignalTradeState, type SignalSections } from './signalPanel.js';
import { stripLcArithmetic, NO_REASON as NO_REASON_TEXT } from '../../core/rationaleDisplay.js';
import { entryStanceUnknownReason, entryLabel } from '../../core/entryLabel.js';

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

  // ★2026-08-25(ユーザー指示): 「その後にかっこで囲んで理由/状況を書く」。
  //   解除条件が読み取れる形へ変えた(旧「10:30までクールダウン」→ 新「クールダウンで残り45秒待機」)。
  it('★クールダウンは **残り秒** を出す', () => {
    expect(buildWaitMain(null, { kind: 'cooldown', untilMs: UNTIL }, UNTIL - 45_000))
      .toBe('シグナル待機（クールダウンで残り45秒待機）');
    // 秒未満は切り上げ(0秒と表示して「まだ待つ」を隠さない)
    expect(buildWaitMain(null, { kind: 'cooldown', untilMs: UNTIL }, UNTIL - 1))
      .toBe('シグナル待機（クールダウンで残り1秒待機）');
  });

  it('★level は **再武装の価格** を出す(境界が無ければ従来の語に縮退)', () => {
    expect(buildWaitMain(null, { kind: 'level', upperTrigger: 70_000, lowerTrigger: 69_950 }))
      .toBe('シグナル待機（現在価格が70,000以上、または69,950以下になるまで待機）');
    // ★境界が来ない回(古い server / 節目も価格も読めない)は嘘の数値を作らず従来の語へ
    expect(buildWaitMain(null, { kind: 'level' })).toBe('シグナル待機（節目クロス待ち）');
  });

  it('★armBlocked は 連続失効の回数と残り分を出す', () => {
    const U = UNTIL;
    expect(buildWaitMain(null, { kind: 'armBlocked', untilMs: U, streak: 3 }, U - 12 * 60_000))
      .toBe('シグナル待機（同じ計画が3回続けて失効したため残り12分待機）');
    // 回数が読めない回は回数の部分ごと出さない(0回 と書かない)
    expect(buildWaitMain(null, { kind: 'armBlocked', untilMs: U, streak: 0 }, U - 60_000))
      .toBe('シグナル待機（同じ計画が続けて失効したため残り1分待機）');
    // 解除時刻が壊れていれば その部分ごと出さない
    expect(buildWaitMain(null, { kind: 'armBlocked', untilMs: Number.NaN, streak: 3 })).toBe('シグナル待機');
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
    expect(buildWaitMain({ count: 27, streak: 2, lastAt: 1, waitMin: 15, bias: 'buy' }, { kind: 'cooldown', untilMs: UNTIL }, UNTIL - 30_000))
      .toBe('シグナル待機（クールダウンで残り30秒待機 / 連続失効 15分2回 / 現在買い目線）');
  });

  it('理由も失効も無ければ従来どおり「シグナル待機」', () => {
    expect(buildWaitMain(null, null)).toBe('シグナル待機');
    expect(buildWaitMain(undefined, undefined)).toBe('シグナル待機');
    // 解除時刻が壊れている場合はその部分ごと出さない(空括弧を作らない)
    expect(buildWaitMain(null, { kind: 'cooldown', untilMs: Number.NaN })).toBe('シグナル待機');
  });

  it('buildSignalView(シグナル無し)から waitReason が配線されている', () => {
    // ★buildSignalView は now を取らない(現在時刻を使う)。残り秒は実時計で変わるので形で固定する。
    expect(buildSignalView({ phase: 'flat', updatedAt: 0, waitReason: { kind: 'cooldown', untilMs: Date.now() + 45_000 } }).main)
      .toMatch(/^シグナル待機（クールダウンで残り[0-9]+秒待機）$/);
    expect(buildSignalView({ phase: 'flat', updatedAt: 0, waitReason: { kind: 'level', upperTrigger: 70_000, lowerTrigger: 69_950 } }).main)
      .toBe('シグナル待機（現在価格が70,000以上、または69,950以下になるまで待機）');
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
    // ★v0.9.96: 順張り/逆張りを含むラベルは目線行に出さない(trendDir を見ない)。rationale は不変。
    expect(v.bias).toBe('買い目線');
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
    expect(buildSignalView(sig({ rationale: LC_ONLY, doten: true, strategy: 'トレンド押し目・戻り' })).bias)
      .toBe('🔃 ドテン(反転)・買い目線・トレンド押し目・戻り');
    // ★v0.9.96: 順張り/逆張りを含むラベルはドテンでも足さない(規約は1つ)。
    expect(buildSignalView(sig({ rationale: LC_ONLY, doten: true, strategy: 'ブレイク順張り' })).bias)
      .toBe('🔃 ドテン(反転)・買い目線');
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
    // ★v0.9.96: 「節目の逆張り」は語を含むので目線行には出ない。why は従来どおり出る。
    expect(v.bias).toBe('売り目線');
    expect(v.rationale).toBe('68900の戻り売り');
  });
});

// ─── 純関数そのもの(組み立ての境界を直接固定する) ───
describe('withStrategyLabel / buildRationaleView', () => {
  it('withStrategyLabel: 無い/空白は目線行を1バイトも変えない', () => {
    // ★v0.9.96: 語を含むラベルは常に落ちるので、ここは語を含まないラベルで固定する。
    expect(withStrategyLabel('買い目線', 'トレンド押し目・戻り')).toBe('買い目線・トレンド押し目・戻り');
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

  it('★否定対照: 節目の申告が無い回は basis キーが生えない(他のフィールドは固定値で全比較)', () => {
    const before = buildSignalView(SIG);
    expect(Object.prototype.hasOwnProperty.call(before, 'basis')).toBe(false);
    // ★v0.9.88 で期待値を更新し、it 名も「byte 一致」から実際の内容に合わせて直した
    //   (期待値だけ新形にして名前を据え置くと、名前と中身が乖離して読む人を騙す)。
    //   この it の目的は「**basis** が生えないこと」で、それは直上の hasOwnProperty と
    //   下の onlyDropped が固定している(意図は1ビットも緩めていない)。
    //   stance(脚のラベル)は **AI の申告に一切依存せず direction と脚の種別だけで導出される**ので、
    //   節目の申告が無い回でも必ず生える(生えないならそれは不具合)。= 期待値の方を直すのが正しい。
    // ★v0.9.89 で sections(3つの欄)を期待値に足した。理由は v0.9.88 の stance と **同じ**:
    //   sections は AI の申告に一切依存せず、上の bias/main/rationale/stance を配り直しただけなので
    //   節目の申告が無い回でも必ず生える。この it が固定したい「basis が生えない」は
    //   直上の hasOwnProperty と下の onlyDropped が持っており、意図は1ビットも緩めていない。
    //   ★同時に「配り直しに漏れが無い」ことの否定対照にもなっている(main/stance の各断片が
    //     どの欄に入ったかが、この1つの期待値で全部読める)。
    expect(JSON.stringify(before)).toBe(JSON.stringify({
      cls: 'armed',
      bias: '買い目線',
      main: '🎯 シグナル：買い 68,725 指値 (LC 68,665) / 買い 68,780 逆指値 (LC 68,720)',
      rationale: '上昇トレンド中、押し目を拾う',
      stance: '指値 押し目買い ／ 逆指値 ブレイク新規',
      sections: {
        bias:  { head: '目線', main: '買い目線', lines: ['上昇トレンド中、押し目を拾う'] },
        above: { head: '上', main: '🎯 買い 68,780 逆指値 (LC 68,720)', lines: [] },
        below: { head: '下', main: '🎯 買い 68,725 指値 (LC 68,665)', lines: [] },
      },
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
    expect(doten('トレンド押し目・戻り')).toBe('🔃 ドテン(反転)・買い目線・トレンド押し目・戻り');
    expect(doten('ブレイク順張り')).toBe('🔃 ドテン(反転)・買い目線');   // ★v0.9.96: 語を含むラベルは落ちる
    expect(doten()).toBe('🔃 ドテン(反転)・買い目線');
  });

  it('withStrategyLabel 単体: 既に現れている語は足さない/現れていない語は足す', () => {
    expect(withStrategyLabel('🔃 ドテン(反転)・買い目線', 'ドテン')).toBe('🔃 ドテン(反転)・買い目線');
    expect(withStrategyLabel('買い目線', 'ドテン')).toBe('買い目線・ドテン');
    expect(withStrategyLabel('買い目線', 'トレンド押し目・戻り')).toBe('買い目線・トレンド押し目・戻り');
  });
});

// ─── ★脚のラベルの行(buildEntryStance) ────────────────────────────────
//   ★v0.9.88 の裁定で規則が変わった: 順張り/逆張りは **トレンドの向き × 売買の向き** で決まり、
//     脚の種別(limit/stop)からは決めない。トレンドが取れない回は語を出さない。
describe('★buildEntryStance: 脚のラベルを画面へ出す', () => {
  const REF = 68_700;

  it('両脚: 指値→逆指値 の順で、節目の行と同じ区切りで並ぶ(上昇トレンド=買いは両脚とも順張り)', () => {
    expect(buildEntryStance('buy', { limitEntry: 68_675, stopEntry: 68_780, refPrice: REF, trendDir: 'up' }))
      .toBe('指値 押し目買い・順張り ／ 逆指値 ブレイク新規・順張り');
    // 上昇トレンドで売るのは逆張り(脚の型は変わらない)。
    expect(buildEntryStance('sell', { limitEntry: 68_725, stopEntry: 68_620, refPrice: REF, trendDir: 'up' }))
      .toBe('指値 戻り売り・逆張り ／ 逆指値 ブレイク新規・逆張り');
  });

  // ★実測: 語が出る率は ARM 時刻で 46.4%(全時刻 35.0% / 日中 44.4%)= **半分の回は語が出ない**。
  //   さらに日ごとのばらつきが大きく「一日中まったく語が出ない日」が実在する(最小 0.0%・最大 79.3%)。
  //   ⇒ 語を出さないだけでは「なぜ付かないのか」が画面から読めない(=無言の失敗)。理由を1語添える。
  it('★トレンドが取れない回は語を出さず、代わりに **なぜ出ないか** を1語添える', () => {
    const legs = { limitEntry: 68_675, stopEntry: 68_780, refPrice: REF };
    // 理由の語はすべて formatMomentumLine(AI に見せている勢いの行)の既存語。新語を作らない。
    expect(buildEntryStance('buy', { ...legs, trendDir: 'flat' }))
      .toBe('指値 押し目買い ／ 逆指値 ブレイク新規 （順張り/逆張りなし: 横ばい）');
    expect(buildEntryStance('buy', { ...legs, trendDir: 'conflict' }))
      .toBe('指値 押し目買い ／ 逆指値 ブレイク新規 （順張り/逆張りなし: 方向不一致）');
    expect(buildEntryStance('buy', { ...legs, trendDir: 'stale' }))
      .toBe('指値 押し目買い ／ 逆指値 ブレイク新規 （順張り/逆張りなし: 判定保留(寄り付きギャップ)）');
    // ★注記は脚ごとではなく **行の末尾に1回だけ**(理由はシグナル全体のもの)。
    expect(buildEntryStance('buy', { limitEntry: 68_675, refPrice: REF, trendDir: 'flat' }))
      .toBe('指値 押し目買い （順張り/逆張りなし: 横ばい）');
    // ★trendDir 欠落(旧版 server / 凍結再生)は注記も出さない=従来と byte 一致。
    expect(buildEntryStance('buy', { ...legs, trendDir: undefined }))
      .toBe('指値 押し目買い ／ 逆指値 ブレイク新規');
    // ★語が出る回には注記を付けない(重複しない)。
    expect(buildEntryStance('buy', { ...legs, trendDir: 'up' }))
      .toBe('指値 押し目買い・順張り ／ 逆指値 ブレイク新規・順張り');
    // 脚が1本も無ければ空文字のまま(注記だけの行を作らない)。
    expect(buildEntryStance('buy', { refPrice: REF, trendDir: 'flat' })).toBe('');
  });

  it('片脚ならその脚だけ出る / 脚が無ければ空文字', () => {
    expect(buildEntryStance('buy', { limitEntry: 68_675, refPrice: REF, trendDir: 'up' })).toBe('指値 押し目買い・順張り');
    expect(buildEntryStance('buy', { stopEntry: 68_780, refPrice: REF, trendDir: 'up' })).toBe('逆指値 ブレイク新規・順張り');
    expect(buildEntryStance('buy', { refPrice: REF, trendDir: 'up' })).toBe('');
  });

  it('★refPrice が無い回はラベルだけ(検査を合格の顔で見せない)', () => {
    // 位置が不正な値を渡しても、基準が無ければ印は付かない(判定していないので印も出せない)。
    expect(buildEntryStance('buy', { limitEntry: 68_725, trendDir: 'up' })).toBe('指値 押し目買い・順張り');
    expect(buildEntryStance('buy', { limitEntry: 68_725, refPrice: NaN, trendDir: 'up' })).toBe('指値 押し目買い・順張り');
  });

  it('★否定対照: 位置が逆側の脚には印が付く(無言で正常に見せない)', () => {
    // 実データの形: 現在値 68,700 なのに「買い 68,725 指値」= 置いた瞬間に約定する。
    expect(buildEntryStance('buy', { limitEntry: 68_725, refPrice: REF, trendDir: 'up' }))
      .toBe('指値 押し目買い・順張り ⚠ エントリーが現在値の逆側（ARM時 68,700）');
    // 両脚あっても、印はその脚にだけ付く。
    expect(buildEntryStance('buy', { limitEntry: 68_675, stopEntry: 68_620, refPrice: REF, trendDir: 'up' }))
      .toBe('指値 押し目買い・順張り ／ 逆指値 ブレイク新規・順張り ⚠ エントリーが現在値の逆側（ARM時 68,700）');
    // 境界(同値)も不正扱い(距離0=即約定)。
    expect(buildEntryStance('sell', { stopEntry: REF, refPrice: REF }))
      .toContain('⚠ エントリーが現在値の逆側');
  });

  it('buildSignalView 経由でも stance 行が出る(節目の行と共存する)', () => {
    const v = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', limitEntry: 68_675, stopLossForLimit: 68_615,
        stopEntry: 68_780, stopLossForStop: 68_720,
        rationale: '押し目', at: 10, limitLevel: 68_650, stopLevel: 68_775, refPrice: REF, trendDir: 'up',
      },
    });
    expect(v.stance).toBe('指値 押し目買い・順張り ／ 逆指値 ブレイク新規・順張り');
    // ★節目の行は1バイトも変わらない(既存表示を壊していない)。
    expect(v.basis).toBe('指値 ← 68,650 の 25円内側 ／ 逆指値 ← 68,775 の 5円外側');
  });

  it('レンジ両面は対象外(節目の行と同じ線引き)', () => {
    const v = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', mode: 'range', at: 10, rationale: 'r', refPrice: REF, trendDir: 'up',
        range: {
          upper: { side: 'sell', type: 'limit', entry: 68_800, stopLoss: 68_860 },
          lower: { side: 'buy', type: 'limit', entry: 68_600, stopLoss: 68_540 },
        },
      },
    });
    expect(v.stance).toBeUndefined();
    expect(v.whys).toBeUndefined();
  });
});

// ─── ★v0.9.88(本命): レッグごとの理由(buildWhyLines) ──────────────────
describe('★buildWhyLines: レッグごとの理由を画面へ出す', () => {
  const LEGS = { limitEntry: 68_675, stopEntry: 68_780 };

  it('目線 → 指値 → 逆指値 の順で、脚の理由と LC の理由を1行に並べる', () => {
    expect(buildWhyLines({
      ...LEGS,
      directionWhy: '直近安値を切り上げ、21日線を上抜けた',
      entryWhyForLimit: '68,650 の支持帯まで引きつける',
      lcWhyForLimit: '直近安値の外側',
      entryWhyForStop: '68,775 を抜けたら追随',
      lcWhyForStop: '節目の内側に戻る幅',
    })).toEqual([
      '目線: 直近安値を切り上げ、21日線を上抜けた',
      '指値: 68,650 の支持帯まで引きつける ／ LC: 直近安値の外側',
      '逆指値: 68,775 を抜けたら追随 ／ LC: 節目の内側に戻る幅',
    ]);
  });

  it('★不変の実証: 理由が1つも来ていない回は空配列(=従来の表示と byte 一致)', () => {
    expect(buildWhyLines({ ...LEGS })).toEqual([]);
    // 旧い記録の形(節目や strategy だけがある)でも同じ。
    expect(buildWhyLines({ limitEntry: 68_675 })).toEqual([]);
  });

  it('★否定対照: 1つでも来ていれば、欠けている枠は「（理由の記載なし）」で見える', () => {
    // 「AI が書かなかった」のか「画面が落とした」のかを区別できるようにする(無言の失敗を作らない)。
    expect(buildWhyLines({ ...LEGS, directionWhy: '上昇継続と判断' })).toEqual([
      '目線: 上昇継続と判断',
      '指値: （理由の記載なし） ／ LC: （理由の記載なし）',
      '逆指値: （理由の記載なし） ／ LC: （理由の記載なし）',
    ]);
    // 目線だけが欠けている形も同じ規約。
    expect(buildWhyLines({ limitEntry: 68_675, entryWhyForLimit: '支持帯', lcWhyForLimit: '安値の外' })).toEqual([
      '目線: （理由の記載なし）',
      '指値: 支持帯 ／ LC: 安値の外',
    ]);
  });

  it('★全枠が空なら1行に畳む(実測75%がこの形=これが標準的な見え方)', () => {
    // 枠ごとに出すと「（理由の記載なし）」が4行連続する。枠名は情報を1ビットも足していないので畳む。
    // ★畳んでも「書かれていない」という事実は消えない(1行は必ず出る=無言の失敗にしない)。
    expect(buildWhyLines({ ...LEGS, directionWhy: '' })).toEqual(['（理由の記載なし）']);
    // LC検算しか書かれていない枠も「空」として数える(検算を理由に見せない)。
    expect(buildWhyLines({
      limitEntry: 68_675,
      directionWhy: '指値レッグ 68675 と 68615 の引き算 → LC幅は60円。',
      entryWhyForLimit: 'LC幅は60円',
    })).toEqual(['（理由の記載なし）']);
  });

  it('★一部だけ空なら畳まない(どの枠が書かれていないかが情報になる)', () => {
    expect(buildWhyLines({ limitEntry: 68_675, entryWhyForLimit: '支持帯まで待つ' })).toEqual([
      '目線: （理由の記載なし）',
      '指値: 支持帯まで待つ ／ LC: （理由の記載なし）',
    ]);
  });

  it('★改行を含む理由は行に分かれる(1要素に入れると CSS で改行が潰れる)', () => {
    // buildWhyLines は組み立てだけ。分割は paintPanel が splitRationaleLines で行う。
    // ここでは「改行が保たれたまま渡る」ことを固定する(潰して1行にしていない)。
    const v = buildWhyLines({ limitEntry: 68_675, directionWhy: '1行目\n2行目\n3行目' });
    expect(v[0]).toBe('目線: 1行目\n2行目\n3行目');
    expect(splitRationaleLines(v[0]!)).toEqual(['目線: 1行目', '2行目', '3行目']);
  });

  it('★長すぎる理由は上限で切られ、切ったことが分かる印が付く', () => {
    const long = 'あ'.repeat(5_000);
    const [line] = buildWhyLines({ limitEntry: 68_675, directionWhy: long });
    expect(line!.endsWith(DISPLAY_TRUNCATED_MARK)).toBe(true);
    expect(line!.length).toBeLessThan(2_100);   // '目線: ' + 上限2000字
    // 正常な長さには効かない。
    expect(buildWhyLines({ limitEntry: 68_675, directionWhy: 'あ'.repeat(319) })[0])
      .toBe('目線: ' + 'あ'.repeat(319));
  });

  it('出ていない脚の行は出さない(落ちた脚の理由を孤立して見せない)', () => {
    expect(buildWhyLines({
      limitEntry: 68_675, directionWhy: '上昇継続',
      entryWhyForStop: 'この理由は画面に出ない(台帳には残る)',
    })).toEqual([
      '目線: 上昇継続',
      '指値: （理由の記載なし） ／ LC: （理由の記載なし）',
    ]);
  });

  it('buildSignalView 経由で理由の行が出る / 理由が無ければ whys キーごと生えない', () => {
    const base = {
      direction: 'buy' as const, limitEntry: 68_675, stopLossForLimit: 68_615,
      rationale: '押し目', at: 10, refPrice: 68_700,
    };
    const withWhy = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: { ...base, directionWhy: '上昇継続と判断', entryWhyForLimit: '支持帯まで待つ', lcWhyForLimit: '安値の外' },
    });
    expect(withWhy.whys).toEqual(['目線: 上昇継続と判断', '指値: 支持帯まで待つ ／ LC: 安値の外']);
    const without = buildSignalView({ phase: 'armed', updatedAt: 0, signal: base });
    expect(Object.prototype.hasOwnProperty.call(without, 'whys')).toBe(false);
  });
});

// ─── ★v0.9.88: AI 生成文は例外なく LC検算を落としてから出す ──────────────
describe('★cleanAiText: strategyWhy の穴を塞ぐ', () => {
  it('LC検算しか無い文は空になる(NO_REASON をそのまま返さない)', () => {
    expect(cleanAiText('指値レッグ 68725 と 68665 の引き算 → LC幅は60円。')).toBe('');
    expect(cleanAiText(undefined)).toBe('');
    expect(cleanAiText('')).toBe('');
  });

  it('理由の本文は残り、検算だけが落ちる', () => {
    expect(cleanAiText('21日線を上抜けて押し目待ち。LC幅は60円。')).toBe('21日線を上抜けて押し目待ち。');
  });

  it('★strategyWhy が検算だけの回は、目線の行に検算を出さない(従来は出ていた)', () => {
    // 従来は strategyWhy を素通しで先頭行に置いていたため、LC の検算が画面に出る経路が残っていた。
    const v = buildRationaleView('押し目を拾う', '指値レッグ 68725 と 68665 の引き算 → LC幅は60円。');
    expect(v).toBe('押し目を拾う');
    // 両方とも検算だけなら「理由が書かれていない」という事実を出す(空にして無言で消さない)。
    expect(buildRationaleView('LC幅は60円', 'LC=55円')).toBe('（理由の記載なし）');
  });
});

// ─── ★v0.9.88: 目線行の strategy ラベル ───────────────────────────────
//   裁定(2周目で修正): 落とすのは **stance が確定していて、かつ順張り/逆張りの語を含むとき** だけ。
//   最初の版は trendDir を見ずに落としていたため、矛盾しようがない回でも落ちて
//   「順張り/逆張り」の情報が画面から **純減** していた(下の反例の it がそれを固定する)。
describe('★withStrategyLabel: AI の strategy ラベルの扱い', () => {
  it('★語を含む → 落とす(画面に矛盾/重複を並べない)', () => {
    // 直したかった形: 目線行「買い目線・節目の逆張り」(AI の自己申告) と
    //                 脚の行「指値 押し目買い・順張り」(コード導出) が同じパネルに並んでいた。
    expect(withStrategyLabel('買い目線', 'ブレイク順張り')).toBe('買い目線');
    expect(withStrategyLabel('売り目線', '節目の逆張り')).toBe('売り目線');
    // ★一覧外の生値でも同じ規約(語を含むかだけで判定=ラベル一覧に依存しない)。
    expect(withStrategyLabel('買い目線', '強い上昇の順張りで攻める')).toBe('買い目線');
  });

  it('★v0.9.96: trendDir を見ない=コードが断定できない回も落とす(自己申告を画面に出さない)', () => {
    // ★v0.9.88 の2周目は「stance 未確定なら残す」だった。v0.9.96 でその条件を撤回した。
    //   実測(prices_kabu.db の複製・340件): コード未断定 157件のうち AI が名乗るのは 40件で
    //   **全て trendDir='flat'**。ユーザーが見た回(id=2423)は flat で「ブレイク順張り」と名乗り、
    //   自分の文では「下降トレンド」と書いていた(自己矛盾)。
    //   ★純減の補償: 未断定の回には目線の欄に `横ばい` 等が出て、strategyWhy(なぜその読みか)も残る。
    expect(withStrategyLabel('買い目線', 'ブレイク順張り')).toBe('買い目線');
    expect(withStrategyLabel('売り目線', '節目の逆張り')).toBe('売り目線');
  });

  it('語を含まないラベルは常に出る(機能そのものは残す)', () => {
    for (const label of ['トレンド押し目・戻り', 'レンジ内', 'バンドウォーク追随', 'ドテン', 'その他']) {
      expect(withStrategyLabel('買い目線', label)).toBe(`買い目線・${label}`);
    }
  });

  it('★strategy も stripLcArithmetic を通る(LC検算が目線行に出る経路を塞ぐ)', () => {
    // parseAiStrategy は一覧外の語も丸めずそのまま残す仕様なので、AI が
    // "strategy":"LC幅は60円" と書けば、従来はそのまま目線行に出ていた。
    // ★これは trendDir と無関係に常に塞ぐ(検算は相場の読みではない)。
    expect(withStrategyLabel('買い目線', 'LC幅は60円')).toBe('買い目線');
    expect(withStrategyLabel('買い目線', '指値レッグ 68725 と 68665 の引き算 → LC幅は60円。')).toBe('買い目線');
    // 理由が混ざっていれば従来どおり残る(判定を保守側に倒している既存の規約と同じ)。
    expect(withStrategyLabel('買い目線', '21日線の上でLC幅は60円')).toBe('買い目線・21日線の上でLC幅は60円');
  });

  it('★buildSignalView 経由: trendDir が up でも flat でも欠落でも落ちる(実際の配線)', () => {
    const mk = (trendDir?: 'up' | 'flat') => buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', limitEntry: 68_675, stopLossForLimit: 68_615,
        rationale: '押し目', at: 10, refPrice: 68_700, strategy: 'ブレイク順張り', trendDir,
      },
    });
    expect(mk('up').bias).toBe('買い目線');                       // 落とす
    expect(mk('up').stance).toBe('指値 押し目買い・順張り');       // 情報は脚の行が持つ
    // ★v0.9.96: 未断定でも落とす。順張り/逆張りの語はコードが測った trendDir からしか出ない。
    expect(mk('flat').bias).toBe('買い目線');
    expect(mk('flat').stance).toBe('指値 押し目買い （順張り/逆張りなし: 横ばい）');   // 語の代わりに理由
    expect(mk(undefined).bias).toBe('買い目線');                   // 欠落も同じ
  });

  it('★v0.9.96: レンジ両面でも語を含むラベルは落ちる(方向プランと同じ規約)', () => {
    const v = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', mode: 'range', at: 10, rationale: 'r', strategy: '節目の逆張り', trendDir: 'up',
        range: { lower: { side: 'buy', type: 'limit', entry: 68_600, stopLoss: 68_540 } },
      },
    });
    expect(v.bias).toBe('レンジ');
    expect(v.stance).toBeUndefined();
    // 語を含まないラベルはレンジでも従来どおり出る。
    const v2 = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', mode: 'range', at: 10, rationale: 'r', strategy: 'レンジ内', trendDir: 'up',
        range: { lower: { side: 'buy', type: 'limit', entry: 68_600, stopLoss: 68_540 } },
      },
    });
    expect(v2.bias).toBe('レンジ・レンジ内');
  });
});

// ─── ★v0.9.89(依頼の本体): シグナル枠を3つの欄(目線 / 上 / 下)に分ける ──────────
describe('★buildSignalSections: 目線 / 上 / 下 の3欄', () => {
  const REF = 68_700;
  /** 全部そろった買いのシグナル(理由5枠・節目2つ・refPrice・trendDir)。 */
  const FULL = {
    direction: 'buy' as const, at: 10, refPrice: REF, trendDir: 'up' as const,
    limitEntry: 68_675, stopLossForLimit: 68_615, limitLevel: 68_650,
    stopEntry: 68_780, stopLossForStop: 68_720, stopLevel: 68_775,
    rationale: '上昇トレンド中、押し目を拾う', strategy: 'トレンド押し目・戻り',
    directionWhy: '直近安値を切り上げ、21日線を上抜けた',
    entryWhyForLimit: '68,650 の支持帯まで引きつける', lcWhyForLimit: '直近安値の外側',
    entryWhyForStop: '68,775 を抜けたら追随', lcWhyForStop: '節目の内側に戻る幅',
  };
  const sections = (signal: Record<string, unknown>): SignalSections =>
    buildSignalView({ phase: 'armed', updatedAt: 0, signal: signal as never }).sections!;

  it('①全部そろった回: 買いは 上=逆指値 / 下=指値 で、素材が欄ごとに分かれる', () => {
    const s = sections(FULL);
    // ★v0.9.90: 基準価格の行(上/下 ← ARM時 …)と節目の行(指値 ← … )は **画面に出さない**。
    // ★v0.9.96: 目線の箱(directionWhy)が在るので、計画全体の本文(rationale)は目線の欄に積まない
    //   (この回は strategyWhy が無いので、残るのは `目線: …` の1行だけ)。
    expect(s.bias).toEqual({
      head: '目線', main: '買い目線・トレンド押し目・戻り',
      // ★2026-08-25(ユーザー指示): 行頭の `目線: ` は消した(欄の見出しと目線行で3回目だった)。
      lines: ['直近安値を切り上げ、21日線を上抜けた'],
    });
    // ★2026-08-31(ユーザー指示①②): 名札の行は出さない / 残る行は句点で1行に繋ぐ。
    expect(s.above).toEqual({
      head: '上', main: '🎯 買い 68,780 逆指値 (LC 68,720)',
      lines: ['68,775 を抜けたら追随 ／ LC: 節目の内側に戻る幅。'],
    });
    expect(s.below).toEqual({
      head: '下', main: '🎯 買い 68,675 指値 (LC 68,615)',
      lines: ['68,650 の支持帯まで引きつける ／ LC: 直近安値の外側。'],
    });
  });

  it('★売りは上下が入れ替わる(規約 core/entryLabel.ts の above をそのまま使う)', () => {
    const s = sections({
      direction: 'sell', at: 10, refPrice: REF, trendDir: 'down',
      limitEntry: 68_775, stopLossForLimit: 68_835, limitLevel: 68_800,
      stopEntry: 68_620, stopLossForStop: 68_680, stopLevel: 68_650,
      rationale: '戻り売り',
    });
    expect(s.above.main).toBe('🎯 売り 68,775 指値 (LC 68,835)');       // 売りの指値=上
    expect(s.below.main).toBe('🎯 売り 68,620 逆指値 (LC 68,680)');     // 売りの逆指値=下
    // ★2026-08-31: 名札は画面に出さない(記録は signal_plans.leg_label_*)=脚の欄に理由が無ければ行も無い。
    expect(s.above.lines).toEqual([]);
    expect(s.below.lines).toEqual([]);
  });

  it('③片脚だけの回: 空になった欄は「逆指値なし」で見える(無言で消さない)', () => {
    const s = sections({ ...FULL, stopEntry: undefined, stopLossForStop: undefined, stopLevel: undefined });
    expect(s.above).toEqual({ head: '上', main: '逆指値なし', lines: [], empty: true });
    expect(s.below.main).toBe('🎯 買い 68,675 指値 (LC 68,615)');
    // 売りなら逆で、空になるのは下の欄(名前もその脚のもの)。
    const sell = sections({ direction: 'sell', at: 10, limitEntry: 68_775, stopLossForLimit: 68_835, rationale: 'r' });
    expect(sell.below).toEqual({ head: '下', main: '逆指値なし', lines: [], empty: true });
  });

  it('②理由が全部空の回: 畳まれた1行は目線の欄に入る(脚の欄には理由の行が生えない)', () => {
    const s = sections({ ...FULL, rationale: 'LC幅は60円', strategy: undefined,
      directionWhy: '', entryWhyForLimit: '', lcWhyForLimit: '', entryWhyForStop: '', lcWhyForStop: '' });
    // ★v0.9.90(ユーザー指示): 「（理由の記載なし）」は **画面に出さない**(欠測は台帳で数える)。
    //   v0.9.88 では2行連続、v0.9.89 では1行、v0.9.90 で 0行。
    //   ★PanelView.rationale / whys(記録側)は従来どおり「（理由の記載なし）」を持ったまま
    //     (下の「記録は不変」テストが固定している)。変えたのは **画面に出すかどうか** だけ。
    expect(s.bias.lines).toEqual([]);
    expect(s.above.lines).toEqual([]);   // ★2026-08-31: 名札を出さないので行そのものが生えない
  });

  it('★理由が1つも来ていない回(旧い記録)は理由の行が1つも生えない', () => {
    const s = sections({
      direction: 'buy', at: 10, limitEntry: 68_675, stopLossForLimit: 68_615, rationale: '押し目',
    });
    expect(s.bias.lines).toEqual(['押し目']);
    expect(s.below.lines).toEqual([]);   // ★2026-08-31: 名札は画面に出さない
  });

  it('⑦古い記録(trendDir / refPrice なし)でも壊れない(語も注記も作らない)', () => {
    const s = sections({
      direction: 'buy', at: 10, rationale: '押し目',
      limitEntry: 68_675, stopLossForLimit: 68_615, stopEntry: 68_780, stopLossForStop: 68_720,
    });
    expect(s.above.lines).toEqual([]);                        // ★2026-08-31: 名札は画面に出さない
    expect(s.below.lines).toEqual([]);
    expect(s.bias.lines).toEqual(['押し目']);                 // 注記も出さない(語が無い)
  });

  it('★順張り/逆張りが決まらない回の語は目線の欄に1回だけ(脚ごとに2回出さない)', () => {
    // ★v0.9.90(裁定): 画面には **語だけ**。「（順張り/逆張りなし: 横ばい）」という
    //   欠落の告知の形にはしない(ユーザーが消した「（理由の記載なし）」と同型になるため)。
    // ★★2026-08-31(裁定): 一度この語を消したが **戻した**。ユーザーの指示は逐語で
    //   「**シグナル最後の行**の指値押し目買い等の文字列」= 脚の名札のことで、この語は
    //   目線の欄の別の行(=相場の観測結果)。名指しされていないし、パネルの他のどこにも出ていない。
    const s = sections({ ...FULL, trendDir: 'flat' });
    expect(s.bias.lines.filter(l => l === '横ばい')).toHaveLength(1);
    expect(s.bias.lines.join()).not.toContain('順張り/逆張りなし');
    expect(s.above.lines.join()).not.toContain('横ばい');
    expect(s.below.lines.join()).not.toContain('横ばい');
  });

  it('★位置の規約に反した脚の ⚠ は、その脚の欄に残る', () => {
    // 買いの逆指値を現在値より下に置いた(=置いた瞬間に約定する不正配置)。
    // ★2026-08-31: 名札は消えたが **⚠ の警告は残る**(名札ではなく「注文の置き方が不正」の警告)。
    //   理由の行と句点で繋がって1行になる。
    const s = sections({ ...FULL, stopEntry: 68_620, stopLevel: undefined });
    expect(s.above.lines).toEqual([
      '68,775 を抜けたら追随 ／ LC: 節目の内側に戻る幅。⚠ エントリーが現在値の逆側（ARM時 68,700）。',
    ]);
  });

  it('★コード側の注記(※…は不採用)は目線の欄に残る(脚へ機械的に振り分けない)', () => {
    const s = sections({
      ...FULL, stopEntry: undefined, stopLossForStop: undefined, stopLevel: undefined,
      rationale: '押し目を拾う\n※上部(買い逆指値)は不採用: 損切り幅が設定の上限より広い',
    });
    // ★v0.9.96: 本文(押し目を拾う)は目線の欄から外れるが、**引き取り手の無い注記は残る**
    //   (この回の注記は `※上部` = 持ち主 'above' で、方向プランの空き欄は 'stop' なので移せない)。
    expect(s.bias.lines).toContain('※上部(買い逆指値)は不採用: 損切り幅が設定の上限より広い');
    expect(s.bias.lines).not.toContain('押し目を拾う');
    expect(s.above.main).toBe('逆指値なし');
  });

  it('⑥レンジ両面: upper→上 / lower→下。片面だけなら「上部なし」', () => {
    const both = sections({
      direction: 'buy', mode: 'range', at: 10, rationale: 'レンジ', strategy: 'レンジ内',
      range: { upper: { side: 'sell', type: 'limit', entry: 68_900, stopLoss: 68_960 },
               lower: { side: 'buy', type: 'limit', entry: 68_700, stopLoss: 68_640 } },
    });
    expect(both.bias.main).toBe('レンジ・レンジ内');
    expect(both.above.main).toBe('🎯 売り68,900指値(上) (LC 68,960)');
    expect(both.below.main).toBe('🎯 買い68,700指値(下) (LC 68,640)');
    const onlyLower = sections({
      direction: 'buy', mode: 'range', at: 10, rationale: 'レンジ',
      range: { lower: { side: 'buy', type: 'limit', entry: 68_700, stopLoss: 68_640 } },
    });
    expect(onlyLower.above).toEqual({ head: '上', main: '上部なし', lines: [], empty: true });
  });

  it('④待機(flat)は欄を作らない(分ける脚が無い=従来の1行のまま)', () => {
    expect(buildSignalView({ phase: 'flat', updatedAt: 0 }).sections).toBeUndefined();
    expect(buildSignalView(null).sections).toBeUndefined();
    // 決済でクリアされた回も同じ。
    expect(buildSignalView({
      phase: 'flat', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65_395, at: 10 },
      lastExit: { exitPrice: 65_400, pnl: 5, at: 20 },
    }).sections).toBeUndefined();
  });

  it('⑤保有中(filled)でも3つの欄を出し続ける(シグナルは消えない)', () => {
    const v = buildSignalView({
      phase: 'filled', updatedAt: 0,
      signal: { ...FULL, at: 30 },
      position: { direction: 'buy', entryPrice: 68_675, qty: 1, unrealized: 30, at: 31 },
    });
    expect(v.sections!.above.main).toBe('🎯 買い 68,780 逆指値 (LC 68,720)');
    expect(v.sections!.below.main).toBe('🎯 買い 68,675 指値 (LC 68,615)');
    // 保有枠は3欄にしない(分ける脚が無い枠)。
    expect(buildPositionView({
      phase: 'filled', updatedAt: 0,
      position: { direction: 'buy', entryPrice: 68_675, qty: 1, unrealized: 30, at: 31 },
    }).sections).toBeUndefined();
  });

  it('★情報の保存: 従来の各行が必ずどこかの欄に入っている(取りこぼしの否定対照)', () => {
    const v = buildSignalView({ phase: 'armed', updatedAt: 0, signal: FULL as never });
    const all = [v.sections!.bias, v.sections!.above, v.sections!.below]
      .flatMap(s => [s.main, ...s.lines]).join('\n');
    expect(all).toContain(v.bias!);                                    // 目線行
    for (const leg of v.main.replace('🎯 シグナル：', '').split(' / ')) expect(all).toContain(leg);
    // ★v0.9.96: 計画全体の本文(PanelView.rationale)は **意図して欄に入れない**。
    //   ここは「消えた先の証明」= 記録側には在り、画面には無い(basis と同じ扱い)。
    expect(v.rationale).toBe('上昇トレンド中、押し目を拾う');
    expect(all).not.toContain(v.rationale);
    // ★2026-08-25(ユーザー指示): 欄からは行頭の見出し(`目線: `/`指値: `/`逆指値: `)を外した。
    //   PanelView.whys(旧経路の表現・**画面には描かれない**)は従来どおり見出し付きなので、
    //   ★突き合わせは **見出しを剥がした中身** で行う(取りこぼしの否定対照はここが本体)。
    const stripLabel = (w: string): string => w.replace(/^(?:目線|指値|逆指値): /, '');
    for (const w of v.whys!) {
      for (const part of stripLabel(w).split(' ／ ')) expect(all).toContain(stripLabel(part));
    }
    // ★★2026-08-31(ユーザー指示①): 脚の名札(PanelView.stance)は **画面に出さない** ようにした。
    //   ここは「消えた先の証明」に変える: 欄には無く、**台帳(signal_plans.leg_label_*)に在る**。
    //   ★名札を作る関数(legStanceText / buildEntryStance)も PanelView.stance も消していない
    //     (旧経路=否定対照として残す)。値も1バイト変わっていない(下の1行が固定している)。
    expect(v.stance).toBe('指値 押し目買い・順張り ／ 逆指値 ブレイク新規・順張り');
    for (const p of v.stance!.split(' ／ ')) expect(all).not.toContain(p);
    // ★v0.9.90: 節目の行(v.basis)は **画面に出さない**(ユーザー指示)。記録側には従来どおり残る
    //   ので、ここでは「PanelView には在るが欄には無い」ことを固定する(消えた先の証明)。
    expect(v.basis).toBe('指値 ← 68,650 の 25円内側 ／ 逆指値 ← 68,775 の 5円外側');
    for (const p of v.basis!.split(' ／ ')) expect(all).not.toContain(p);
  });

  it('★buildSignalSections 単体: 素材(bias/rationale)+ sig の理由を欄ごとに配る', () => {
    const s = buildSignalSections(
      { direction: 'buy', limitEntry: 68_675, stopEntry: 68_780, at: 10,
        directionWhy: 'A', entryWhyForLimit: 'B', lcWhyForLimit: 'C',
        entryWhyForStop: 'D', lcWhyForStop: 'E' },
      { bias: '買い目線', rationale: '本文' },
    );
    // ★v0.9.96: 目線の箱(A)が在る回は「本文」を積まない。
    expect(s.bias.lines).toEqual(['A']);
    // ★箱が空の回は従来どおり本文を出す(画面を無言にしない)。
    expect(buildSignalSections(
      { direction: 'buy', limitEntry: 68_675, stopEntry: 68_780, at: 10 },
      { bias: '買い目線', rationale: '本文' },
    ).bias.lines).toEqual(['本文']);
    // ★2026-08-31: 見出し(逆指値:)は付けない / LC: は残す / 行末は句点で閉じる。
    expect(s.above.lines[0]).toBe('D ／ LC: E。');
    expect(s.below.lines[0]).toBe('B ／ LC: C。');
  });
});

// ─── ★v0.9.90(ユーザー指示): 開発用の記述は表示せず、記録だけに残す ────────────
// 「②Bのパネル表示ですが、ユーザー目線にたち、開発用の記述は表示せず、保存のみしてください。」
//   例に挙がった3つ: `上/下 ← ARM時 66,190` / `／LC：（理由の記載なし）` / `指値 ← 66,145 ちょうど`
describe('★v0.9.90: 画面から外したもの(記録は1バイトも変えない)', () => {
  const sections = (signal: Record<string, unknown>): SignalSections =>
    buildSignalView({ phase: 'armed', updatedAt: 0, signal: signal as never }).sections!;
  const flat = (s: SignalSections): string =>
    [s.bias, s.above, s.below].flatMap(x => [x.head, x.main, ...x.lines]).join('\n');
  const BASE = {
    direction: 'buy' as const, at: 10, refPrice: 66_190, trendDir: 'up' as const,
    limitEntry: 66_145, stopLossForLimit: 66_085, limitLevel: 66_145,
    stopEntry: 66_240, stopLossForStop: 66_180, stopLevel: 66_235,
    rationale: '押し目を拾う',
  };

  it('①基準価格の行(上/下 ← ARM時 …)はどこにも出ない', () => {
    expect(flat(sections(BASE))).not.toContain('ARM時');
    // ★ただし位置の異常を知らせる ⚠ の中の「（ARM時 …）」は **残す**(開発用ではなく警告)。
    const wrong = sections({ ...BASE, stopEntry: 66_100, stopLevel: undefined });
    expect(flat(wrong)).toContain('⚠ エントリーが現在値の逆側（ARM時 66,190）');
  });

  it('②「（理由の記載なし）」の類は画面に一切出ない(目線・脚・LC のどれも)', () => {
    // 理由が1つも来ていない回 / 全部空の回 / 検算しか無い回、いずれも出さない。
    for (const sig of [
      BASE,
      { ...BASE, directionWhy: '', entryWhyForLimit: '', lcWhyForLimit: '', entryWhyForStop: '', lcWhyForStop: '' },
      { ...BASE, rationale: 'LC幅は60円', directionWhy: 'LC幅は60円' },
    ]) {
      expect(flat(sections(sig))).not.toContain(NO_REASON_TEXT);
    }
  });

  it('★片方だけ空なら **その片方だけ** 落とす(依頼の「／LC：（理由の記載なし）」)', () => {
    // ★2026-08-31: 行末は句点で閉じる(残す部分は改行せず句点にする、の指示)。
    const s = sections({ ...BASE, entryWhyForStop: '66,235 を抜けたら追随' });   // lcWhyForStop は無い
    expect(s.above.lines[0]).toBe('66,235 を抜けたら追随。');   // ★見出し(逆指値:)は付けない
    // 逆(脚の理由だけが空)なら LC の側だけが残る。
    const s2 = sections({ ...BASE, lcWhyForStop: '節目の内側に戻る幅' });
    expect(s2.above.lines[0]).toBe('LC: 節目の内側に戻る幅。');
    // 両方あれば従来どおり1行に並ぶ。
    const s3 = sections({ ...BASE, entryWhyForStop: '追随', lcWhyForStop: '節目の内側' });
    expect(s3.above.lines[0]).toBe('追随 ／ LC: 節目の内側。');
    // ★両方空なら行そのものが出ない(名札も出さないので、脚の欄は空になる)。
    expect(sections(BASE).above.lines).toEqual([]);
  });

  it('③節目の行(指値 ← 66,145 ちょうど)は画面に出ない', () => {
    expect(flat(sections(BASE))).not.toContain('ちょうど');
    expect(flat(sections(BASE))).not.toContain('66,145 ちょうど');
    expect(flat(sections(BASE))).not.toContain('円外側');
  });

  it('★残すもの: 目線・注文・価格・LC・脚のラベル・中身のある理由', () => {
    const s = sections({ ...BASE, strategy: 'トレンド押し目・戻り', directionWhy: '安値を切り上げた' });
    const t = flat(s);
    expect(t).toContain('買い目線・トレンド押し目・戻り');   // 目線とラベル
    expect(t).toContain('🎯 買い 66,240 逆指値 (LC 66,180)'); // 注文・価格・LC
    expect(t).toContain('🎯 買い 66,145 指値 (LC 66,085)');
    // ★2026-08-31(ユーザー指示①): 脚の名札は **残さない**(記録は signal_plans.leg_label_*)。
    expect(t).not.toContain('逆指値 ブレイク新規・順張り');
    expect(t).not.toContain('指値 押し目買い・順張り');
    expect(t).toContain('安値を切り上げた');                  // 中身のある理由(見出しは付かない)
    // ★v0.9.96: rationale の本文は目線の欄から外した(箱が在る回)。箱が無ければ従来どおり出る。
    expect(t).not.toContain('押し目を拾う');
    expect(flat(sections({ ...BASE, strategy: 'トレンド押し目・戻り' }))).toContain('押し目を拾う');
  });

  it('★残すもの: コード注記(※…は不採用) と 順張り/逆張りが出ない理由(相場の事実)', () => {
    const s = sections({
      ...BASE, trendDir: 'flat', stopEntry: undefined, stopLossForStop: undefined, stopLevel: undefined,
      rationale: '押し目を拾う\n※上部(買い逆指値)は不採用: 損切り幅が設定の上限より広い',
    });
    expect(s.bias.lines).toContain('※上部(買い逆指値)は不採用: 損切り幅が設定の上限より広い');
    // ★v0.9.90 の裁定は 2026-08-31 の名札削除でも **生きている**(一度消して戻した)。
    //   この語は名札の付属物ではなく **相場の事実** で、パネルの他のどこにも出ていない。
    expect(s.bias.lines).toContain('横ばい');   // ★事実の語だけ(欠落の告知にしない)
  });

  it('★記録は1バイトも変えない: PanelView の既存フィールドは v0.9.89 と同じ値', () => {
    const v = buildSignalView({ phase: 'armed', updatedAt: 0, signal: {
      ...BASE, directionWhy: '', entryWhyForLimit: '', lcWhyForLimit: '',
    } as never });
    // 画面から消した3つは **どれも PanelView には残っている**(=記録・SSE 側は不変)。
    expect(v.basis).toBe('指値 ← 66,145 ちょうど ／ 逆指値 ← 66,235 の 5円外側');
    // ★buildWhyLines の既存規約(全枠空なら1行に畳む)はそのまま=記録側は1バイトも変わっていない。
    expect(v.whys).toEqual(['（理由の記載なし）']);
    expect(v.rationale).toBe('押し目を拾う');
    expect(v.stance).toBe('指値 押し目買い・順張り ／ 逆指値 ブレイク新規・順張り');
    expect(v.main).toBe('🎯 シグナル：買い 66,145 指値 (LC 66,085) / 買い 66,240 逆指値 (LC 66,180)');
    expect(v.bias).toBe('買い目線');
    // …が、欄には出ていない。
    expect(flat(v.sections!)).not.toContain(NO_REASON_TEXT);
    expect(flat(v.sections!)).not.toContain('ちょうど');
  });

  it('★古い記録(trendDir/refPrice/理由 なし)でも壊れない', () => {
    const s = sections({
      direction: 'buy', at: 10, rationale: '押し目を拾う',
      limitEntry: 66_145, stopLossForLimit: 66_085, stopEntry: 66_240, stopLossForStop: 66_180,
    });
    expect(s.bias.lines).toEqual(['押し目を拾う']);
    expect(s.above.lines).toEqual([]);   // ★2026-08-31: 名札は画面に出さない
    expect(s.below.lines).toEqual([]);
  });

  it('★レンジ両面・片脚・保有中・待機 でも壊れない', () => {
    const range = sections({
      direction: 'buy', mode: 'range', at: 10, rationale: 'レンジと判断', refPrice: 66_190,
      range: { upper: { side: 'sell', type: 'limit', entry: 66_300, stopLoss: 66_360 } },
    });
    expect(range.above.main).toBe('🎯 売り66,300指値(上) (LC 66,360)');
    expect(range.below).toEqual({ head: '下', main: '下部なし', lines: [], empty: true });
    expect(flat(range)).not.toContain('ARM時');

    const oneLeg = sections({ ...BASE, stopEntry: undefined, stopLossForStop: undefined });
    expect(oneLeg.above).toEqual({ head: '上', main: '逆指値なし', lines: [], empty: true });

    const held = buildSignalView({
      phase: 'filled', updatedAt: 0, signal: { ...BASE, at: 30 } as never,
      position: { direction: 'buy', entryPrice: 66_145, qty: 1, unrealized: 20, at: 31 },
    });
    expect(held.sections!.below.main).toBe('🎯 買い 66,145 指値 (LC 66,085)');

    // 待機は従来どおり1行(欄を作らない)。待機理由も残る。
    const wait = buildSignalView({ phase: 'flat', updatedAt: 0, waitReason: { kind: 'level' } });
    expect(wait.sections).toBeUndefined();
    expect(wait.main).toBe('シグナル待機（節目クロス待ち）');
  });
});

// ─── ★v0.9.90(裁定): 順張り/逆張りが決まらない回は「欠落の告知」ではなく「事実の語」 ────
describe('★トレンドが断定できない回: 画面には語だけを出す', () => {
  const sections = (signal: Record<string, unknown>): SignalSections =>
    buildSignalView({ phase: 'armed', updatedAt: 0, signal: signal as never }).sections!;
  const BASE = {
    direction: 'buy' as const, at: 10, refPrice: 66_190,
    limitEntry: 66_145, stopLossForLimit: 66_085, stopEntry: 66_240, stopLossForStop: 66_180,
    rationale: '押し目を拾う',
  };

  it('★3種とも括弧と「順張り/逆張りなし:」を落とし、語だけを目線の欄の末尾に出す', () => {
    // ★★2026-08-31(裁定): 名札を消したときに **この語まで一緒に消してしまい、戻した**。
    //   ユーザーが消せと言ったのは「シグナル最後の行」の名札で、この語は目線の欄の別の行。
    //   ★名札(コードが付けた名前)と 相場の観測結果 を取り違えないこと。
    expect(sections({ ...BASE, trendDir: 'flat' }).bias.lines.at(-1)).toBe('横ばい');
    expect(sections({ ...BASE, trendDir: 'conflict' }).bias.lines.at(-1)).toBe('方向不一致');
    expect(sections({ ...BASE, trendDir: 'stale' }).bias.lines.at(-1)).toBe('判定保留(寄り付きギャップ)');
    // 語は core/entryLabel.ts(formatMomentumLine 由来)のまま=新しい語を作っていない。
    for (const d of ['flat', 'conflict', 'stale'] as const) {
      expect(sections({ ...BASE, trendDir: d }).bias.lines.at(-1))
        .toBe(entryStanceUnknownReason(d));
    }
  });

  it('★trendDir が欠落している古い記録でも何も出さない', () => {
    const s = sections(BASE);
    expect(s.bias.lines).toEqual(['押し目を拾う']);
    expect(s.above.lines).toEqual([]);
    expect(s.below.lines).toEqual([]);
  });

  it('★2026-08-31: trendDir が何であっても **脚の欄** の見え方は変わらない(名札を出さないため)', () => {
    // ★名札を出していた頃は、ここに「順張り/逆張り」が出ていた。★変わるのは目線の欄だけ。
    for (const d of [undefined, 'up', 'down', 'flat'] as const) {
      const s = sections(d === undefined ? BASE : { ...BASE, trendDir: d });
      expect(s.above.lines).toEqual([]);
      expect(s.below.lines).toEqual([]);
    }
    // ★目線の欄は従来どおり: 断定できた回は語なし / できない回は語が1行(相場の事実)。
    expect(sections({ ...BASE, trendDir: 'up' }).bias.lines).toEqual(['押し目を拾う']);
    expect(sections({ ...BASE, trendDir: 'flat' }).bias.lines).toEqual(['押し目を拾う', '横ばい']);
  });

  it('★脚が1本も無い回も従来どおり空(名札も語も無い)', () => {
    const s = buildSignalSections(
      { direction: 'buy', at: 10, trendDir: 'flat' },
      { bias: '買い目線', rationale: '' },
    );
    expect(s.bias.lines).toEqual([]);
  });

  it('★括弧付きの旧書式は buildEntryStance(PanelView.stance)側にだけ残る=値は旧版と同じ', () => {
    // 画面(sections)は語だけ。PanelView.stance は「1行の末尾に足す」文脈なので括弧付きのまま。
    expect(buildEntryStance('buy', { limitEntry: 66_145, trendDir: 'flat' }))
      .toBe('指値 押し目買い （順張り/逆張りなし: 横ばい）');
    const v = buildSignalView({ phase: 'armed', updatedAt: 0, signal: { ...BASE, trendDir: 'flat' } as never });
    expect(v.stance).toBe('指値 押し目買い ／ 逆指値 ブレイク新規 （順張り/逆張りなし: 横ばい）');
    // ★その stance は armed の回には描かれない(欄が持つのは語だけ)。
    const flat = [v.sections!.bias, v.sections!.above, v.sections!.below]
      .flatMap(x => [x.main, ...x.lines]).join('\n');
    expect(flat).not.toContain('順張り/逆張りなし');
    expect(flat).toContain('横ばい');
  });
});

// ─── ★v0.9.92: 脚落ちの注記を、その脚の欄へ移す ────────────────────────────
// 依頼(逐語)「（指値は不採用: …）の表示位置は、上　指値なしの場所が望ましい。」
describe('★v0.9.92: 脚落ちの注記を空いている欄へ', () => {
  const sections = (signal: Record<string, unknown>): SignalSections =>
    buildSignalView({ phase: 'armed', updatedAt: 0, signal: signal as never }).sections!;
  const GEOM = '（指値は不採用: エントリーが現在値の逆側、または損切り幅の値が不正）';
  const STOP_NOTE = '（逆指値は不採用: 損切り幅が設定の上限より広い）';
  // 依頼の画面と同じ回: 売り・指値が落ちて逆指値だけ残った(売りの指値=上の欄)。
  const SELL_LIMIT_DROPPED = {
    direction: 'sell' as const, at: 10, refPrice: 65_800, trendDir: 'down' as const,
    stopEntry: 65_740, stopLossForStop: 65_800,
    rationale: `下降トレンドの中で、サポートを下抜けたため。 ${GEOM}`,
    directionWhy: '下降トレンドが続いており、サポートを割ったため、売りのエントリーが適切と判断した。',
    entryWhyForStop: 'サポートの65,760円を下抜けた位置にブレイク新規を設定した。',
  };

  it('①依頼の例そのもの: 注記が「上」の欄へ移り、目線の欄からは消える', () => {
    const s = sections(SELL_LIMIT_DROPPED);
    expect(s.above).toEqual({ head: '上', main: GEOM, lines: [], empty: true });
    // ★v0.9.96: 本文は外れ、目線の箱だけが残る(注記は上の欄へ移ったまま=消えていない)。
    expect(s.bias.lines).toEqual([
      '下降トレンドが続いており、サポートを割ったため、売りのエントリーが適切と判断した。',
    ]);
    expect(s.below.main).toBe('🎯 売り 65,740 逆指値 (LC 65,800)');
    // ★`指値なし` は出さない(注記が脚の名前と状態を既に持っている)。
    expect(s.above.main).not.toContain('指値なし');
  });

  it('②逆側: 買い・逆指値が落ちた回は「上」、売り・逆指値が落ちた回は「下」へ入る', () => {
    const buy = sections({
      direction: 'buy', at: 10, refPrice: 66_190, limitEntry: 66_145, stopLossForLimit: 66_085,
      rationale: `押し目を拾う ${STOP_NOTE}`,
    });
    expect(buy.above).toEqual({ head: '上', main: STOP_NOTE, lines: [], empty: true });
    expect(buy.bias.lines).toEqual(['押し目を拾う']);
    const sell = sections({
      direction: 'sell', at: 10, refPrice: 66_190, limitEntry: 66_240, stopLossForLimit: 66_300,
      rationale: `戻りを売る ${STOP_NOTE}`,
    });
    expect(sell.below).toEqual({ head: '下', main: STOP_NOTE, lines: [], empty: true });
    expect(sell.above.main).toBe('🎯 売り 66,240 指値 (LC 66,300)');
  });

  it('★取り違えの実証: 注記が名乗る脚と空いている欄の脚が違えば **動かさない**', () => {
    // 買い・指値が落ちた(空いているのは「下」=指値の欄)のに、注記は逆指値のもの。
    const s = sections({
      direction: 'buy', at: 10, refPrice: 66_190, stopEntry: 66_240, stopLossForStop: 66_180,
      rationale: `ブレイクに乗る ${STOP_NOTE}`,
    });
    expect(s.below).toEqual({ head: '下', main: '指値なし', lines: [], empty: true });   // 縮退表示のまま
    expect(s.bias.lines).toEqual([`ブレイクに乗る ${STOP_NOTE}`]);                        // 1バイトも動かさない
  });

  it('★脚が在る欄には絶対に入らない(両脚ある回は注記があっても目線に残る)', () => {
    const s = sections({
      direction: 'buy', at: 10, refPrice: 66_190,
      limitEntry: 66_145, stopLossForLimit: 66_085, stopEntry: 66_240, stopLossForStop: 66_180,
      rationale: `両方出した ${GEOM}`,
    });
    expect(s.above.main).toBe('🎯 買い 66,240 逆指値 (LC 66,180)');
    expect(s.below.main).toBe('🎯 買い 66,145 指値 (LC 66,085)');
    expect(s.bias.lines).toEqual([`両方出した ${GEOM}`]);
  });

  it('★注記が2つある回: 引き取れるものだけ移り、残りは目線に残る', () => {
    // 買い・指値が落ちた(空きは「下」)。注記は指値と逆指値の2本。
    const s = sections({
      direction: 'buy', at: 10, refPrice: 66_190, stopEntry: 66_240, stopLossForStop: 66_180,
      rationale: `本文 ${GEOM}${STOP_NOTE}`,
    });
    expect(s.below.main).toBe(GEOM);                       // 指値の注記だけが移る
    expect(s.bias.lines).toEqual([`本文 ${STOP_NOTE}`]);    // 逆指値の注記は残る(脚が在るので)
  });

  it('★両脚とも落ちた回は欄そのものが出ない(従来どおり「シグナル待機」)', () => {
    const v = buildSignalView({ phase: 'armed', updatedAt: 0, signal: {
      direction: 'buy', at: 10, refPrice: 66_190, rationale: `見送り ${GEOM}${STOP_NOTE}`,
    } as never });
    expect(v.sections).toBeUndefined();
    expect(v.main).toBe('シグナル待機');
  });

  it('★注記だけの行は行ごと欄へ移る / 本文と同じ行なら本文だけが残る(空白を残さない)', () => {
    const onlyNote = sections({ ...SELL_LIMIT_DROPPED, rationale: GEOM, directionWhy: undefined });
    expect(onlyNote.bias.lines).toEqual([]);
    expect(onlyNote.above.main).toBe(GEOM);
    const withBody = sections({ ...SELL_LIMIT_DROPPED, directionWhy: undefined });
    expect(withBody.bias.lines).toEqual(['下降トレンドの中で、サポートを下抜けたため。']);
  });

  it('⑥レンジ: ※上部/※下部 の注記も同じ規約でその欄へ入る', () => {
    const s = sections({
      direction: 'buy', mode: 'range', at: 10,
      rationale: 'レンジと判断\n※上部(売り指値)は不採用: 損切り幅が設定の上限より広い',
      range: { lower: { side: 'buy', type: 'limit', entry: 66_100, stopLoss: 66_040 } },
    });
    expect(s.above).toEqual({
      head: '上', main: '※上部(売り指値)は不採用: 損切り幅が設定の上限より広い', lines: [], empty: true,
    });
    expect(s.bias.lines).toEqual(['レンジと判断']);
    // ★下部の注記は「下」へ(位置がそのまま欄になる)。
    const lower = sections({
      direction: 'buy', mode: 'range', at: 10,
      rationale: 'レンジ\n※下部のレッグなし: AIが提案せず',
      range: { upper: { side: 'sell', type: 'limit', entry: 66_300, stopLoss: 66_360 } },
    });
    expect(lower.below.main).toBe('※下部のレッグなし: AIが提案せず');
  });

  it('★レンジの注記は方向レッグの回では動かない(位置の語を脚の欄へ読み替えない)', () => {
    const s = sections({
      direction: 'buy', at: 10, refPrice: 66_190, limitEntry: 66_145, stopLossForLimit: 66_085,
      rationale: '押し目\n※上部(買い逆指値)は不採用: 損切り幅が設定の上限より広い',
    });
    expect(s.above.main).toBe('逆指値なし');
    expect(s.bias.lines).toContain('※上部(買い逆指値)は不採用: 損切り幅が設定の上限より広い');
  });
});

describe('★extractLegDropNotes: 注記の切り出し(純関数)', () => {
  const all = (): boolean => true;
  const none = (): boolean => false;

  it('★引き取り手が無ければ入力と同一のインスタンスを返す(1バイトも触らない)', () => {
    const line = '本文（指値は不採用: 損切り幅が設定の上限より広い）';
    const r = extractLegDropNotes(line, none);
    expect(r.rest).toBe(line);
    expect(r.claimed).toEqual([]);
  });

  it('★「（指値」と「（逆指値」を取り違えない(名前は開き括弧の直後で決まる)', () => {
    expect(extractLegDropNotes('（逆指値なし: AIが提案せず）', all).claimed)
      .toEqual([{ owner: 'stop', text: '（逆指値なし: AIが提案せず）' }]);
    expect(extractLegDropNotes('（指値なし: AIが提案せず）', all).claimed)
      .toEqual([{ owner: 'limit', text: '（指値なし: AIが提案せず）' }]);
  });

  it('連続した2本を別々に切り出す(区切り無しで連結される実際の形)', () => {
    const r = extractLegDropNotes('本文 （指値なし: AIが提案せず）（逆指値は不採用: トレンドに逆行）', all);
    expect(r.claimed.map(c => c.owner)).toEqual(['limit', 'stop']);
    expect(r.rest).toBe('本文');
  });

  it('★閉じ括弧が無い壊れた形は触らない(注記として扱わない)', () => {
    const line = '本文 （指値は不採用: 途中で切れている';
    expect(extractLegDropNotes(line, all).rest).toBe(line);
    expect(extractLegDropNotes(line, all).claimed).toEqual([]);
  });

  it('レンジの注記は行頭一致だけを見る(本文の途中の同じ語では動かない)', () => {
    expect(extractLegDropNotes('※上部(売り指値)は不採用: トレンドに逆行', all).claimed[0]?.owner).toBe('above');
    const mid = 'AI が ※上部 と書いた本文';
    expect(extractLegDropNotes(mid, all).rest).toBe(mid);
  });
});

// ─── ★v0.9.96: 目線の欄から「計画全体の本文」を外す ────────────────────────────
// 依頼(逐語)「A はエントリーについて何も尋ねていないはずですが？」
//   = 目線の欄に rationale(計画全体の本文)が積まれ、エントリー価格の話で埋まっていた。
//   ★実測(prices_kabu.db の複製・signal_plans・2026-08-19〜08-24・direction<>'none' 405件):
//     目線の欄の本文は strategyWhy 由来 340行 / rationale 由来 100行(100件=29.4%・
//     そのうち価格の数字 50% ・注文の語 80%) / 脚落ちの注記 61行。外すのは rationale 由来だけ。
describe('★v0.9.96: 目線の欄は「なぜこの目線か」だけにする', () => {
  const sections = (signal: Record<string, unknown>): SignalSections =>
    buildSignalView({ phase: 'armed', updatedAt: 0, signal: signal as never }).sections!;
  /** ユーザーが見た回(2026-08-24 00:03・実データ id=2423)と同じ形。 */
  const SEEN = {
    direction: 'buy' as const, at: 10, refPrice: 66_100, trendDir: 'flat' as const,
    limitEntry: 66_070, stopLossForLimit: 66_010, stopEntry: 66_125, stopLossForStop: 66_065,
    strategy: 'ブレイク順張り',
    strategyWhy: '現在の価格が下降トレンドにあり、直近の高値をブレイクする可能性がある。',
    rationale: '66070での反発を狙い、66125をブレイクした場合にエントリーする。',
    directionWhy: '下降トレンドからの反発を狙い、ブレイク新規でエントリーする。',
    entryWhyForLimit: '66,070 の支持で反発を待つ', lcWhyForLimit: '直近安値の外側',
    entryWhyForStop: '66,125 を抜けたら追随', lcWhyForStop: '節目の内側に戻る幅',
  };

  it('★依頼の例そのもの: 計画全体の本文が目線の欄から消え、strategyWhy と目線の理由は残る', () => {
    const s = sections(SEEN);
    expect(s.bias.lines).toEqual([
      '現在の価格が下降トレンドにあり、直近の高値をブレイクする可能性がある。',   // strategyWhy(残す)
      '下降トレンドからの反発を狙い、ブレイク新規でエントリーする。',             // directionWhy
      '横ばい',                                                                   // trendDir='flat' の事実
    ]);
    // ★エントリー価格の話は目線の欄から消え、脚の欄に在る(消滅ではなく置き場所の問題)。
    expect(s.bias.lines.join()).not.toContain('66070での反発');
    expect(s.above.lines[0]).toBe('66,125 を抜けたら追随 ／ LC: 節目の内側に戻る幅。');
    expect(s.below.lines[0]).toBe('66,070 の支持で反発を待つ ／ LC: 直近安値の外側。');
    // ★②: コードが断定できない回(flat)でも AI の「ブレイク順張り」は目線行に出さない。
    expect(s.bias.main).toBe('買い目線');
  });

  it('★条件は「目線の箱に中身が在るか」= 箱が空なら従来どおり本文を出す(画面を無言にしない)', () => {
    const empty = sections({ ...SEEN, directionWhy: undefined, strategyWhy: undefined,
      entryWhyForLimit: undefined, lcWhyForLimit: undefined,
      entryWhyForStop: undefined, lcWhyForStop: undefined });
    expect(empty.bias.lines).toContain('66070での反発を狙い、66125をブレイクした場合にエントリーする。');
    // 目線の箱が **LC の検算しか書いていない** 回も「空」と数える(既存の cleanAiText の規約)。
    const lcOnly = sections({ ...SEEN, directionWhy: 'LC幅は60円' });
    expect(lcOnly.bias.lines).toContain('66070での反発を狙い、66125をブレイクした場合にエントリーする。');
  });

  it('★脚の箱だけが欠けた回でも本文は外す(条件は目線の箱ひとつ)', () => {
    const s = sections({ ...SEEN, entryWhyForStop: undefined, lcWhyForStop: undefined });
    expect(s.bias.lines.join()).not.toContain('66070での反発');
    expect(s.above.lines).toEqual([]);   // 脚の理由は無い(欠測はそのまま見える)+名札も出さない
  });

  it('★落としても脚落ちの注記は消えない(引き取り手が在れば欄へ / 無ければ目線に残る)', () => {
    const claimed = sections({
      ...SEEN, stopEntry: undefined, stopLossForStop: undefined,
      rationale: `66070での反発を狙う。 （逆指値は不採用: 損切り幅が設定の上限より広い）`,
    });
    expect(claimed.above.main).toBe('（逆指値は不採用: 損切り幅が設定の上限より広い）');
    expect(claimed.bias.lines.join()).not.toContain('66070での反発');
    // 引き取り手が無い注記(方向プランに `※上部` が来た回)は目線の欄に残す=嘘の欄に置かない。
    const unclaimed = sections({
      ...SEEN, rationale: '66070での反発を狙う。\n※上部(買い逆指値)は不採用: 損切り幅が設定の上限より広い',
    });
    expect(unclaimed.bias.lines).toContain('※上部(買い逆指値)は不採用: 損切り幅が設定の上限より広い');
    expect(unclaimed.bias.lines.join()).not.toContain('66070での反発');
  });

  it('★記録は変えない: PanelView.rationale / whys は従来どおり本文を持つ(捨てた先の証明)', () => {
    const v = buildSignalView({ phase: 'armed', updatedAt: 0, signal: SEEN as never });
    expect(v.rationale).toBe(
      '現在の価格が下降トレンドにあり、直近の高値をブレイクする可能性がある。\n'
      + '66070での反発を狙い、66125をブレイクした場合にエントリーする。');
    expect(v.whys?.[0]).toBe('目線: 下降トレンドからの反発を狙い、ブレイク新規でエントリーする。');
  });

  it('★箱が1つも来ていない回(旧い記録・分割の配線前)は従来どおり rationale が目線の欄に出る', () => {
    // ★★訂正(2026-08-24): この it は元々「★分割ONの形: 5つの箱が空」という題で、コメントに
    //   「分割ONで組み立てられる plan は directionWhy / entryWhyFor* を持たない」と書いていた。
    //   ★同じ作業ツリーで server/llm/planVariants.ts と scalpPlanSplit.ts を直して
    //     **箱に入れるようにした** ので、その記述は嘘になっていた(テストは通るが証拠として偽)。
    //   ⇒ 題とコメントを事実に直す。ここが固定しているのは「箱が1つも無い回の縮退」で、
    //     分割ONの実際の形は下の describe(★分割ONの3通り)が **実走の値** で固定する。
    const s = sections({
      direction: 'buy', at: 10, refPrice: 66_100, trendDir: 'flat',
      limitEntry: 66_070, stopLossForLimit: 66_010, stopEntry: 66_125, stopLossForStop: 66_065,
      strategy: 'ブレイク順張り',
      rationale: 'ブレイク順張り / 指値: 66,070 の支持で反発を待つ / 逆指値: 66,125 を抜けたら追随',
    });
    expect(s.bias.lines[0]).toBe('ブレイク順張り / 指値: 66,070 の支持で反発を待つ / 逆指値: 66,125 を抜けたら追随');
    expect(s.above.lines).toEqual([]);   // 脚ごとの理由の箱が無い回(名札も出さない)
  });
});

// ★v0.9.96 の実装の穴を塞いだ回帰テスト(改行入りの strategyWhy)。
//   AI 生成文は改行を含みうる。keepOnly を丸ごと1本の文字列として比べると、
//   改行入りの strategyWhy が **どの行とも一致せずに落ちる**(=残すと決めたものが消える)。
describe('★v0.9.96: 改行を含む strategyWhy も行ごとに残る', () => {
  it('2行の strategyWhy は2行とも残り、rationale の本文だけが落ちる', () => {
    const s = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', at: 10, limitEntry: 68_675, stopLossForLimit: 68_615,
        strategyWhy: '上段の読み。\n下段の読み。',
        rationale: '68,675 で拾い、68,780 を抜けたら追随する計画。',
        directionWhy: '安値を切り上げた',
      } as never,
    }).sections!;
    expect(s.bias.lines).toEqual(['上段の読み。', '下段の読み。', '安値を切り上げた']);
  });
});

// ─── ★v0.9.96(2周目): 分割ON の3通り。★値は **runSplitPlan の実走** から採った ──────────
// エバリュエーターが実走で見つけた2つの純減を固定する。
//   ① レンジ両面で本文を落とすと、B の理由も strategy も **どこにも出ない**(受け皿が無い)
//   ② A が理由を返さなかった回に本文を残すと、**同じ理由が目線の欄と脚の欄に2回** 出る
describe('★v0.9.96(2周目): 分割ON の3通りで純減も二重も作らない', () => {
  const sections = (signal: Record<string, unknown>): SignalSections =>
    buildSignalView({ phase: 'armed', updatedAt: 0, signal: signal as never }).sections!;
  /** 分割ON・方向プラン(A も B も理由を返した回)。 */
  const SPLIT_DIR = {
    direction: 'sell' as const, at: 10, refPrice: 66_100, trendDir: 'flat' as const,
    limitEntry: 66_140, stopLossForLimit: 66_200, stopEntry: 66_060, stopLossForStop: 66_120,
    strategy: 'ブレイク順張り',
    rationale: 'ブレイク順張り / 指値売り注文: 66,135 のレジスタンスの5円上に戻り売りの指値を置いた。'
      + ' / 逆指値売り注文: 66,065 のサポートを抜けたら追随するため5円下。',
    directionWhy: '直近1時間で高値を切り下げ、21日線の下に居るため。',
    entryWhyForLimit: '66,135 のレジスタンスの5円上に戻り売りの指値を置いた。',
    entryWhyForStop: '66,065 のサポートを抜けたら追随するため5円下。',
  };

  it('①分割ON・両方の理由が在る回: 目線の欄は A の理由だけ / 脚の理由は上下の欄', () => {
    const s = sections(SPLIT_DIR);
    expect(s.bias.lines).toEqual(['直近1時間で高値を切り下げ、21日線の下に居るため。', '横ばい']);
    expect(s.above.lines[0]).toBe('66,135 のレジスタンスの5円上に戻り売りの指値を置いた。');
    expect(s.below.lines[0]).toBe('66,065 のサポートを抜けたら追随するため5円下。');
  });

  it('★②A が理由を返さなかった回: 同じ理由を2箇所に出さない(脚の箱が在れば本文を落とす)', () => {
    const s = sections({ ...SPLIT_DIR, directionWhy: undefined });
    // 直す前はここに `ブレイク順張り / 指値売り注文: … / 逆指値売り注文: …` が残り、
    // 上/下の欄にも同じ2本が出ていた(実走で再現した)。
    expect(s.bias.lines.join('\n')).not.toContain('指値売り注文');
    expect(s.bias.lines).toEqual(['横ばい']);
    expect(s.above.lines[0]).toBe('66,135 のレジスタンスの5円上に戻り売りの指値を置いた。');
    expect(s.below.lines[0]).toBe('66,065 のサポートを抜けたら追随するため5円下。');
  });

  it('★③レンジ両面では本文を落とさない(上下の欄が理由の受け皿を持たないため)', () => {
    const s = sections({
      direction: 'buy', mode: 'range', at: 10, refPrice: 66_100, trendDir: 'flat',
      range: { upper: { side: 'sell', type: 'limit', entry: 66_180, stopLoss: 66_240 },
               lower: { side: 'buy', type: 'limit', entry: 66_020, stopLoss: 65_960 } },
      strategy: 'レンジの逆張り',
      rationale: 'レンジの逆張り / 指値売り注文: 上限の手前で売る / 指値買い注文: 下限の手前で買う',
      directionWhy: '高安が重なりトレンドが無い',
    });
    // ★本文(B の理由と読み)が残っていること。落とすと画面のどこにも出ない=純減。
    expect(s.bias.lines).toEqual([
      'レンジの逆張り / 指値売り注文: 上限の手前で売る / 指値買い注文: 下限の手前で買う',
      '高安が重なりトレンドが無い',
    ]);
    expect(s.above.lines).toEqual([]);   // レンジの欄は理由の行を持たない(既存の線引き)
    expect(s.below.lines).toEqual([]);
  });

  it('★B の strategy は語を含まなければ目線行に出る(消えない)', () => {
    // ★「分割ONでは B の strategy が必ず消える」ではない。消えるのは
    //   順張り/逆張りを含む回だけで、それは②の裁定(コードが測った trendDir だけを権威にする)の帰結。
    expect(sections({ ...SPLIT_DIR, strategy: '押し目を節目手前で拾う' }).bias.main)
      .toBe('売り目線・押し目を節目手前で拾う');
    expect(sections(SPLIT_DIR).bias.main).toBe('売り目線');
  });

  it('★LC の箱だけでは本文を落とさない(本文が語る「目線と価格」を引き受けないため)', () => {
    const s = sections({
      direction: 'sell', at: 10, refPrice: 66_100, limitEntry: 66_140, stopLossForLimit: 66_200,
      rationale: '戻り売りを狙う。', lcWhyForLimit: '直近高値の外側',
    });
    expect(s.bias.lines).toEqual(['戻り売りを狙う。']);
    expect(s.above.lines[0]).toBe('LC: 直近高値の外側。');
  });
});

// ═══ ★2026-08-25(ユーザー指示): ボードから消した3つの文字列 ═══════════════════
//
// ■ 依頼(逐語)
//     目線の  「目線: 」
//     上の    「指値: その後に理由を日本語で自由表記 → 」
//     下の    「逆指値: その後に理由を日本語で自由表記 → 」
//     以上３か所のボード上の文字列は不要です。ユーザー目線で考えて。
//     …見出しではなく、消すには「目線: 」の文字列です。
//
// ■ ★消したもの / 残したもの(取り違えないこと)
//     消した … 理由の **行頭の見出し** `目線: ` `指値: ` `逆指値: ` と、
//              モデルが写した形式の見本 `その後に理由を日本語で自由表記 → `
//     残した … ★**欄の見出し**(`目線` / `上` / `下`)・目線行・メイン行(`🎯 買い … 指値 (LC …)`)・
//              `LC: `(1行に脚の理由と LC の理由が並ぶので、区切りとして要る)
//
// ■ ★なぜ見出しが要らないか(ユーザー目線)
//     `[上] 🎯 買い 65,780 逆指値 (LC 65,720)` の次の行に `逆指値: …` と書くのは
//     同じ語の2回目。目線に至っては 欄の見出し・目線行・行頭 で3回目だった。
//     トレーダーが読む情報を1ビットも足していない。
describe('★ボードから消した3つの文字列(2026-08-25 ユーザー指示)', () => {
  const SIG = {
    direction: 'buy' as const, refPrice: 65_700, at: 10,
    limitEntry: 65_600, stopLossForLimit: 65_545,
    stopEntry: 65_780, stopLossForStop: 65_720,
    entryWhyForLimit: '65,595 の節目手前で拾う', lcWhyForLimit: '直近安値の外側',
    entryWhyForStop: '65,775 の節目を抜けたら追随', lcWhyForStop: '節目の内側に戻る幅',
    directionWhy: '直近安値を切り上げた',
  };
  const sec = (): ReturnType<typeof buildSignalSections> =>
    buildSignalSections(SIG as never, { bias: '買い目線・トレンド押し目', rationale: '' });
  const flatAll = (): string => {
    const s = sec();
    return [s.bias, s.above, s.below].flatMap(x => [x.head, x.main, ...x.lines]).join('\n');
  };

  it('★3つの見出しがボードのどこにも出ない', () => {
    const t = flatAll();
    expect(t).not.toContain('目線: ');
    expect(t).not.toContain('指値: ');     // `逆指値: ` も部分文字列として一緒に落ちる
    expect(t).not.toContain('逆指値: ');
  });

  it('★★欄の見出しは残っている(消したのは行頭の文字列だけ)', () => {
    const s = sec();
    expect(s.bias.head).toBe('目線');
    expect(s.above.head).toBe('上');
    expect(s.below.head).toBe('下');
    // 目線行とメイン行もそのまま(注文の種類はここが名乗る)。
    expect(s.bias.main).toBe('買い目線・トレンド押し目');
    expect(s.above.main).toBe('🎯 買い 65,780 逆指値 (LC 65,720)');
    expect(s.below.main).toBe('🎯 買い 65,600 指値 (LC 65,545)');
  });

  it('★理由の中身は1文字も落ちていない(消したのは見出しだけ)', () => {
    const s = sec();
    expect(s.bias.lines).toContain('直近安値を切り上げた');
    // ★2026-08-31: 中身は1文字も落ちない(足したのは行末の句点だけ)。
    expect(s.above.lines[0]).toBe('65,775 の節目を抜けたら追随 ／ LC: 節目の内側に戻る幅。');
    expect(s.below.lines[0]).toBe('65,595 の節目手前で拾う ／ LC: 直近安値の外側。');
  });

  it('★`LC: ` は残す(脚の理由と LC の理由の区切りとして要る)', () => {
    expect(sec().above.lines[0]).toContain(' ／ LC: ');
    // ★脚の理由が空なら `LC: …` だけの行になる(従来どおり)。
    const only = buildSignalSections(
      { ...SIG, entryWhyForStop: undefined } as never, { bias: 'b', rationale: '' },
    );
    expect(only.above.lines[0]).toBe('LC: 節目の内側に戻る幅。');
  });
});

// ─── ★TP(利確)をボードに出す ──────────────────────────────────────────────
//   ■ 症状(ユーザー報告): 「TP が AI委任 ですが、TP 表示されません。」
//     実際にボードは TP を **一度も** 表示していなかった(描いている箇所が0件)。
//   ■ 出し方: LC が価格で出ているので TP も **価格**。書式は既存の `(LC …)` と同じ形を並べるだけ。
//   ■ ★★価格は **server が計算して SSE に載せる**。画面は選んで描くだけで、1円も計算しない:
//     ・待機中 … `signal.tpTriggerForLimit` / `tpTriggerForStop`
//     ・保有中 … `hold.tpTrigger`(決済が実際に使う価格)を **約定した脚だけ** に
//     ★画面が幅から計算していた版では、ARM 時に凍結した設定を見ていたため
//       「決済は発火するのに画面は無音」「発火しないのに画面は出したまま」が起きた。
//       → ★画面のテストに **設定(scalpTpEnabled/幅)は1つも出てこない**。それが直った証拠。
//   ■ 値が無ければ **1文字も出さない**(「TP なし」とは書かない)。

/** 買いの2レッグ(指値=下 / 逆指値=上)。TP の材料だけを差し替えて使う。 */
const TP_SIG = (extra: Record<string, unknown>): SignalTradeState => ({
  phase: 'armed', updatedAt: 0,
  signal: {
    direction: 'buy',
    limitEntry: 65395, stopLossForLimit: 65345,
    stopEntry: 65520, stopLossForStop: 65470,
    rationale: '押し目買い', at: 1, ...extra,
  },
});

describe('★TP をボードに出す(sections=実際に描かれる欄)', () => {
  it('待機中: server が載せた発火価格を両脚にそのまま出す', () => {
    const v = buildSignalView(TP_SIG({ tpTriggerForLimit: 65465, tpTriggerForStop: 65610 }));
    // 買い: 指値=下 / 逆指値=上。
    expect(v.sections?.below.main).toBe('🎯 買い 65,395 指値 (LC 65,345) (TP 65,465)');
    expect(v.sections?.above.main).toBe('🎯 買い 65,520 逆指値 (LC 65,470) (TP 65,610)');
  });

  it('売りでも同じ(価格をそのまま出すだけなので向きの計算はしない)', () => {
    const v = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'sell', limitEntry: 65520, stopLossForLimit: 65570,
        stopEntry: 65395, stopLossForStop: 65445, at: 1,
        tpTriggerForLimit: 65450, tpTriggerForStop: 65305,
      },
    });
    // 売り: 指値=上 / 逆指値=下。
    expect(v.sections?.above.main).toBe('🎯 売り 65,520 指値 (LC 65,570) (TP 65,450)');
    expect(v.sections?.below.main).toBe('🎯 売り 65,395 逆指値 (LC 65,445) (TP 65,305)');
  });

  it('★保有中: hold.tpTrigger を **そのまま** 出す(画面が計算し直さない)', () => {
    const s = TP_SIG({ tpTriggerForLimit: 65465, tpTriggerForStop: 65610 });
    s.phase = 'filled';
    // 指値(65,395)で約定。★待機中の値(65,465)が signal に残っていても、
    //   決済が使う価格は hold.tpTrigger=65,500。**画面はこちらを出す**。
    s.hold = { signalId: 1, direction: 'buy', entryPrice: 65395, exitStop: 65345, at: 2, tpTrigger: 65500 };
    const v = buildSignalView(s);
    expect(v.sections?.below.main).toBe('🎯 買い 65,395 指値 (LC 65,345) (TP 65,500)');
    // ★約定していない脚(逆指値)には出さない: そこに建玉の TP を並べると
    //   「買いの逆指値 65,520 より下に TP 65,500」という嘘の表示になる。
    expect(v.sections?.above.main).toBe('🎯 買い 65,520 逆指値 (LC 65,470)');
  });

  it('★保有中に TP が動けば表示も動く(hold.tpTrigger は毎tick 引き直される)', () => {
    const mk = (trigger?: number): string => {
      const s = TP_SIG({});
      s.phase = 'filled';
      s.hold = { signalId: 1, direction: 'buy', entryPrice: 65395, exitStop: 65345, at: 2, tpTrigger: trigger };
      return buildSignalView(s).sections!.below.main;
    };
    expect(mk(65475)).toContain('(TP 65,475)');
    expect(mk(65435)).toContain('(TP 65,435)');   // 幅が変わった → 次tickの hold で表示も動く
    expect(mk(undefined)).toBe('🎯 買い 65,395 指値 (LC 65,345)');   // TP が効いていない建玉
  });

  it('★価格が来ていなければ1文字も出さない(「TP なし」とは書かない)', () => {
    const bare = '🎯 買い 65,395 指値 (LC 65,345)';
    // ① 旧い server / TP が効かない回(server が載せない)
    expect(buildSignalView(TP_SIG({})).sections?.below.main).toBe(bare);
    // ② 片脚だけ来ている(もう片方は出さない)
    const one = buildSignalView(TP_SIG({ tpTriggerForStop: 65610 }));
    expect(one.sections?.below.main).toBe(bare);
    expect(one.sections?.above.main).toBe('🎯 買い 65,520 逆指値 (LC 65,470) (TP 65,610)');
    // ③ 壊れた値(NaN/Infinity)は描かない
    for (const t of [NaN, Infinity]) {
      expect(buildSignalView(TP_SIG({ tpTriggerForLimit: t })).sections?.below.main).toBe(bare);
    }
  });

  it('★レンジ両面の脚には出さない(レンジでは TP を尋ねていない)', () => {
    const v = buildSignalView({
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', mode: 'range', at: 1,
        tpTriggerForLimit: 65465, tpTriggerForStop: 65610,   // ★万一載っていても描かない
        range: {
          upper: { side: 'sell', type: 'limit', entry: 65600, stopLoss: 65660 },
          lower: { side: 'buy', type: 'limit', entry: 65400, stopLoss: 65340 },
        },
      },
    });
    expect(JSON.stringify(v.sections)).not.toContain('TP');
  });

  it('★否定対照: TP が来ない回は PanelView 全体が TP 導入前と同一(main は元から TP を持たない)', () => {
    const noTp = buildSignalView(TP_SIG({}));
    expect(noTp.main).toBe('🎯 シグナル：買い 65,395 指値 (LC 65,345) / 買い 65,520 逆指値 (LC 65,470)');
    // TP が出る回でも **main は変えない**(main は描かれない=旧版との突き合わせ用の否定対照)。
    expect(buildSignalView(TP_SIG({ tpTriggerForLimit: 65465, tpTriggerForStop: 65610 })).main).toBe(noTp.main);
  });
});

// ═══ ★2026-08-31(ユーザー指示): 脚の名札は画面に出さず、記録だけに残す ═══════════
//
// ■ 依頼(逐語)
//     「シグナル最後の行の指値押し目買い等の文字列は、こちら側の文字例なので、
//       表示しないようにして、記録のみにしてください。」
//     「残す部分は、改行せず句点にして。」
//
// ■ ★消したもの / 残したもの(取り違えないこと)
//     消した … 脚の名札 `指値 押し目買い・逆張り` `逆指値 ブレイク新規・順張り`(コードが付けた名前)**だけ**。
//     残した … ★`⚠ エントリーが現在値の逆側（ARM時 …）`(★名札ではなく **注文の置き方が不正** の警告)・
//              欄の見出し・メイン行・AI の理由・
//              ★`横ばい` `方向不一致` `判定保留(寄り付きギャップ)`(★相場の観測結果。目線の欄の別の行)。
//     ★★一度この3語まで消して **戻した**(裁定)。ユーザーが名指ししたのは「シグナル最後の行」=
//        脚の名札で、この語は目線の欄に出ている。**名札と相場の事実を取り違えないこと**(影響24.4%の回)。
//     移した … 名札は台帳 signal_plans.leg_label_limit / leg_label_stop へ(記録のみ)。
//     繋いだ … メイン行より下に残る行(理由 と ⚠)は **改行せず句点で1行**に。
describe('★2026-08-31: 名札を画面から消す(⚠ の警告は残す)', () => {
  const sections = (signal: Record<string, unknown>): SignalSections =>
    buildSignalView({ phase: 'armed', updatedAt: 0, signal: signal as never }).sections!;
  const flat = (s: SignalSections): string =>
    [s.bias, s.above, s.below].flatMap(x => [x.head, x.main, ...x.lines]).join('\n');
  const BASE = {
    at: 10, refPrice: 65_500,
    limitEntry: 65_395, stopLossForLimit: 65_345,
    stopEntry: 65_620, stopLossForStop: 65_560,
    rationale: '押し目を拾う',
  };

  it('★① 名札(押し目買い/戻り売り/ブレイク新規 と 順張り/逆張り)が画面のどこにも出ない', () => {
    // ★期待値は **entryLabel を実際に呼んで** 作る(名札の定義を写経しない=定義が変わっても効き続ける)。
    for (const direction of ['buy', 'sell'] as const) {
      for (const trendDir of [undefined, 'up', 'down', 'flat', 'conflict', 'stale'] as const) {
        const t = flat(sections({ ...BASE, direction, ...(trendDir ? { trendDir } : {}) }));
        for (const kind of ['limit', 'stop'] as const) {
          expect(t).not.toContain(entryLabel(direction, kind, trendDir).text);
        }
        // ★★対照: 順張り/逆張りが **付かない理由の語** は目線の欄に出たまま(消したのは名札だけ)。
        //   ここを消したことがあり、裁定で戻した。名札(コードが付けた名前)と
        //   相場の観測結果(横ばい/方向不一致/判定保留)は別物。
        const why = entryStanceUnknownReason(trendDir);
        if (why) expect(t).toContain(why);
      }
    }
  });

  it('★② ⚠ の警告は4象限すべてで残る(名札が無くても、どの脚の話かは欄が名乗る)', () => {
    // 規約に反した側へ置いた脚を4通り作る(買い指値=上 / 買い逆指値=下 / 売り指値=下 / 売り逆指値=上)。
    //   ★第3要素は **その脚が入る欄**(core/entryLabel.ts の above がその1本の権威)。
    const cases: Array<[string, Record<string, unknown>, '上' | '下']> = [
      ['買い指値を現在値より上', { direction: 'buy', limitEntry: 65_600, stopEntry: undefined }, '下'],
      ['買い逆指値を現在値より下', { direction: 'buy', stopEntry: 65_400, limitEntry: undefined }, '上'],
      ['売り指値を現在値より下', { direction: 'sell', limitEntry: 65_400, stopEntry: undefined }, '上'],
      ['売り逆指値を現在値より上', { direction: 'sell', stopEntry: 65_600, limitEntry: undefined }, '下'],
    ];
    for (const [, sig, shownSide] of cases) {
      const s = sections({ ...BASE, ...sig, trendDir: 'up' });
      const t = flat(s);
      expect(t).toContain('⚠ エントリーが現在値の逆側（ARM時 65,500）');
      // ★どの欄に出たかも固定する。欄の見出しとメイン行がどの脚かを名乗る(名札の代わり)。
      const shown = shownSide === '上' ? s.above : s.below;
      expect(shown.lines.join()).toContain('⚠ エントリーが現在値の逆側（ARM時 65,500）');
      expect(shown.main).toContain('🎯');
    }
  });

  it('★③ 正しい側に置かれた脚には ⚠ を出さない(恒真でない)', () => {
    expect(flat(sections({ ...BASE, direction: 'buy', trendDir: 'up' }))).not.toContain('⚠');
  });

  it('★④ refPrice が無い/非有限の回は検査そのものを出さない(fail-safe を合格に見せない)', () => {
    for (const refPrice of [undefined, Number.NaN]) {
      expect(flat(sections({ ...BASE, direction: 'buy', limitEntry: 65_600, refPrice })))
        .not.toContain('⚠');
    }
  });
});

// ═══ ★2026-08-31(ユーザー指示): 残る行は改行せず句点で1行に繋ぐ ═══════════════
describe('★2026-08-31: 脚の欄の行を句点で繋ぐ(二重の句点も孤立した句点も作らない)', () => {
  const sections = (signal: Record<string, unknown>): SignalSections =>
    buildSignalView({ phase: 'armed', updatedAt: 0, signal: signal as never }).sections!;
  /** 下の欄(買いの指値)だけを見る。逆側に置けば ⚠ が付く。 */
  const below = (why: string, wrongSide = false): string[] => sections({
    direction: 'buy', at: 10, refPrice: 65_500, trendDir: 'up',
    limitEntry: wrongSide ? 65_600 : 65_395, stopLossForLimit: 65_345,
    rationale: '押し目を拾う', entryWhyForLimit: why,
  }).below.lines;
  const WARN = '⚠ エントリーが現在値の逆側（ARM時 65,500）';

  it('★場面1 理由あり・警告なし → 1行。末尾の句点は二重にならない', () => {
    expect(below('直近安値の外側に置く')).toEqual(['直近安値の外側に置く。']);
    expect(below('直近安値の外側に置く。')).toEqual(['直近安値の外側に置く。']);   // ★二重にしない
  });

  it('★場面2 理由あり・警告あり → 「理由。⚠ 警告。」の1行', () => {
    expect(below('直近安値の外側に置く。', true)).toEqual([`直近安値の外側に置く。${WARN}。`]);
    expect(below('直近安値の外側に置く', true)).toEqual([`直近安値の外側に置く。${WARN}。`]);
  });

  it('★場面3 理由なし・警告あり → 孤立した「。」が先頭に付かない', () => {
    expect(below('', true)).toEqual([`${WARN}。`]);
    // ★理由の枠が LC の検算だけ(cleanAiText が空にする回)も同じ=空として扱う。
    expect(below('指値レッグ 65395 と 65345 の引き算 → LC幅は50円。', true)).toEqual([`${WARN}。`]);
  });

  it('★場面4 理由なし・警告なし → 行そのものが出ない(空行を残さない)', () => {
    expect(below('')).toEqual([]);
    expect(below('指値レッグ 65395 と 65345 の引き算 → LC幅は50円。')).toEqual([]);
  });

  it('★終わり方の規則: 。．.！!？?… で終わる文には足さない / 読点は句点に置き換える', () => {
    for (const end of ['。', '．', '.', '！', '!', '？', '?', '…']) {
      expect(below(`外側に置く${end}`)).toEqual([`外側に置く${end}`]);   // ★足さない
    }
    for (const end of ['、', '，', ',']) {
      // ★読点で終わる回は `、。` にせず、その1文字を句点に置き換える(語は1つも消していない)。
      expect(below(`外側に置く${end}`)).toEqual(['外側に置く。']);
    }
    // ★切詰の印で終わる回も足さない(句点を足すと文が完結したように見える=嘘になる)。
    const long = 'あ'.repeat(2100);
    const cut = below(long)[0]!;
    expect(cut.endsWith(DISPLAY_TRUNCATED_MARK)).toBe(true);
    expect(cut.endsWith(`${DISPLAY_TRUNCATED_MARK}。`)).toBe(false);
  });

  it('★LC の理由と並ぶ回も句点は1つだけ(区切りの ／ は従来どおり)', () => {
    const s = sections({
      direction: 'buy', at: 10, refPrice: 65_500, trendDir: 'up',
      limitEntry: 65_395, stopLossForLimit: 65_345, rationale: 'r',
      entryWhyForLimit: '直近安値の外側に置く。', lcWhyForLimit: '節目の内側に戻る幅',
    });
    expect(s.below.lines).toEqual(['直近安値の外側に置く。 ／ LC: 節目の内側に戻る幅。']);
  });
});
