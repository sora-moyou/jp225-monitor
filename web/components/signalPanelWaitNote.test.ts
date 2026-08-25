// ★v0.9.97: 待機中(シグナル無し)の枠に **AI の目線と、見送った理由** を出す。
//
// ■ ユーザー指示(原文)
//   「目線はあって、その目線のもとでシグナルを見送った ——— この時も AI の目線を表示してください。」
//
// ■ 実測(2026-08-24・prices_kabu.db の複製 / signal_plans 2,505件・最新 2026-08-24T10:24Z)
//   分割が実走した41件は **全部** a_direction='range' / a_why 41/41 記入済み / none_reason='rangeDisabled'。
//   台帳には目線も理由も在るのに、画面は「シグナル待機（節目クロス待ち）」の1行だけだった。
//
// ■ ★このファイルが守るもの
//   ① 目線が来ない回は **ラベルを出さない**(空括弧・「不明」・`（理由の記載なし）` を作らない)。
//   ② 材料が1つも無い回は、従来の PanelView と **byte 一致**(否定対照)。
//   ③ ★シグナルが在る回(armed / レンジ両面 / 保有枠)は **1バイトも変わらない**。
//   ④ ★3行目の主語(計画)と、理由の行に混ざる脚の注記の主語(指値/逆指値)を混同しない。
//   ⑤ ★いつの目線かが必ず読める(取引時間外は数時間前の目線が出続けるため)。
//
// ■ ★否定対照
//   signalPanel.ts の flatView から buildWaitNoteLines の呼び出しを外すと §待機枠に出る が赤くなる。
//   buildWaitNoteLines の `if (bias && why)` 分岐を `lines.push(bias)` だけにすると §理由 が赤くなる。

import { describe, it, expect } from 'vitest';
import { buildSignalView, buildPositionView, buildWaitNoteLines, waitReasonLabel, type SignalTradeState } from './signalPanel.js';

// ★実データ(2026-08-24 の分割41件のうち1件)をそのまま書き写した理由文。
const REAL_A_WHY = '現値がフィボナッチの50%戻しを下回っており、直近の動きが横ばい。RSIも50付近で上昇・下降の明確な勢いが見られない。';
const REAL_RATIONALE = `目線はレンジ(${REAL_A_WHY})。レンジの取引は設定で無効なため見送り。`;

// ★時刻は固定の実時刻(2026-08-24 09:24 JST)。fmtJstHm がこれを 09:24 にする。
const AT = Date.parse('2026-08-24T09:24:00+09:00');
const HM = '09:24';

const SPLIT_NONE: NonNullable<SignalTradeState['lastNone']> = {
  at: AT, bias: 'range', why: REAL_A_WHY, reason: 'rangeDisabled', reasonText: 'レンジ設定が無効',
};

describe('§buildWaitNoteLines(純関数)', () => {
  it('① 分割の見送り: 時刻 ＋ 目線ラベル ＋ 理由 / 見送りの理由 の2行', () => {
    expect(buildWaitNoteLines(SPLIT_NONE)).toEqual([
      `${HM} レンジ目線 ／ ${REAL_A_WHY}`,
      '見送り: レンジ設定が無効',
    ]);
  });

  it('②★旧経路(目線が取れない): ラベルの部分ごと出さず、理由だけを出す', () => {
    // ★reason='ai' なので3行目は出さない(下の §none_reason=ai を参照)。
    expect(buildWaitNoteLines({ at: AT, why: REAL_RATIONALE, reason: 'ai', reasonText: 'AIが提案せず' })).toEqual([
      `${HM} ${REAL_RATIONALE}`,
    ]);
  });

  it('③★目線も理由も無い回: 見送りの語だけ / それも無ければ0行', () => {
    expect(buildWaitNoteLines({ at: AT, reason: 'aiSilent', reasonText: 'AIが理由も価格も返さず' }))
      .toEqual([`${HM} 見送り: AIが理由も価格も返さず`]);   // ★aiSilent は AI が理由を書いていない=出す
    expect(buildWaitNoteLines({ at: AT })).toEqual([]);
    expect(buildWaitNoteLines(null)).toEqual([]);
    expect(buildWaitNoteLines(undefined)).toEqual([]);
  });

  it('★「（理由の記載なし）」を復活させない: 理由が LC 検算だけなら理由の部分ごと落ちる', () => {
    // cleanAiText が LC 検算だけの文字列を空にする(既存の作法)。目線ラベルだけが残る。
    expect(buildWaitNoteLines({ at: AT, bias: 'buy', why: 'LC幅は60円', reason: 'ai', reasonText: 'AIが提案せず' }))
      .toEqual([`${HM} 買い目線`]);
  });

  it('目線ラベルは既存の語彙(BIAS_JA)と同じ3語', () => {
    const label = (bias: 'buy' | 'sell' | 'range'): string => buildWaitNoteLines({ at: AT, bias })[0]!;
    expect(label('buy')).toBe(`${HM} 買い目線`);
    expect(label('sell')).toBe(`${HM} 売り目線`);
    expect(label('range')).toBe(`${HM} レンジ目線`);
  });
});

// ★⑤(2026-08-24・エバリュエーター指摘): 取引時間外(15:45〜17:00 / 06:00〜08:45)は
//   計画サイクルが走らないので、**数時間前の目線が出続ける**。消さずに時刻を添える(リーダー裁定)。
describe('§いつの目線かが読める', () => {
  it('★先頭の行にだけ時刻が付く(行を増やさない)', () => {
    const lines = buildWaitNoteLines(SPLIT_NONE);
    expect(lines[0]!.startsWith(`${HM} `)).toBe(true);
    expect(lines[1]).toBe('見送り: レンジ設定が無効');   // ★2行目には付けない
  });

  it('★時刻は JST(既存の fmtJstHm と同じ規約=待機表示のクールダウン時刻と揃う)', () => {
    const night = Date.parse('2026-08-24T23:05:00+09:00');
    expect(buildWaitNoteLines({ at: night, bias: 'buy' })[0]).toBe('23:05 買い目線');
  });

  it('★時刻が読めない回は付けない(「Invalid Date」や空の括弧を作らない)', () => {
    // ★2026-08-24(エバリュエーター指摘③): 従来のガードは上限が無く、8640000000000001 で
    //   `Invalid Date` が実際に出た(テストの主張と実装がずれていた)。上限も検査に入れる。
    const OVER = 8_640_000_000_000_001;   // JS の time value の上限(8.64e15)+1
    for (const at of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, OVER, -OVER]) {
      expect(buildWaitNoteLines({ at, bias: 'buy' }), `at=${at} で時刻が付いた`).toEqual(['買い目線']);
    }
  });

  it('★★どんな at でも「Invalid Date」を1文字も出さない(総当たりの主張を実装で保証する)', () => {
    const ATS = [0, -1, 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      8_640_000_000_000_000, 8_640_000_000_000_001, -8_640_000_000_000_001,
      Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 1e300];
    for (const at of ATS) {
      const lines = buildWaitNoteLines({ at, bias: 'buy', why: 'x', reason: 'stale', reasonText: 'y', suppressed: true });
      for (const l of lines) expect(l, `at=${at}`).not.toContain('Invalid Date');
    }
  });

  it('★境界: 上限ちょうど(8.64e15)は出す・+1 は出さない', () => {
    expect(buildWaitNoteLines({ at: 8_640_000_000_000_000, bias: 'buy' })[0]).not.toBe('買い目線');
    expect(buildWaitNoteLines({ at: 8_640_000_000_000_001, bias: 'buy' })[0]).toBe('買い目線');
  });

  it('★同じ穴が待機理由のクールダウン時刻にも在ったので、判定を1つに寄せた', () => {
    expect(waitReasonLabel({ kind: 'cooldown', untilMs: 8_640_000_000_000_001 })).toBe('');
    expect(waitReasonLabel({ kind: 'cooldown', untilMs: Number.NaN })).toBe('');
    expect(waitReasonLabel({ kind: 'armBlocked', untilMs: Number.NaN, streak: 3 })).toBe('');
    // ★正常値は従来どおり(1バイトも変えていない)。
    // ★2026-08-25: 表示は「残り秒」になった(now を渡して固定する)。
    expect(waitReasonLabel({ kind: 'cooldown', untilMs: AT }, AT - 30_000)).toBe('クールダウンで残り30秒待機');
  });

  it('★1行も出ない回に時刻だけが残らない', () => {
    expect(buildWaitNoteLines({ at: AT })).toEqual([]);
  });
});

describe('§待機枠に出る(buildSignalView)', () => {
  const waiting = (lastNone?: SignalTradeState['lastNone']): SignalTradeState => ({
    phase: 'flat', updatedAt: 0, waitReason: { kind: 'level' }, ...(lastNone ? { lastNone } : {}),
  });

  it('①分割の見送り: メイン行は従来のまま・理由の行に目線と見送りが出る', () => {
    const v = buildSignalView(waiting(SPLIT_NONE));
    expect(v.cls).toBe('flat');
    expect(v.main).toBe('シグナル待機（節目クロス待ち）');
    expect(v.rationale.split('\n')).toEqual([
      `${HM} レンジ目線 ／ ${REAL_A_WHY}`,
      '見送り: レンジ設定が無効',
    ]);
    // ★待機枠は3欄に組み替えない(sections はシグナルが在る回だけ)。
    expect(v.sections).toBeUndefined();
  });

  it('②旧経路の見送り: 目線のラベルは出ない', () => {
    const v = buildSignalView(waiting({ at: AT, why: '節目まで距離があり置けない', reason: 'ai', reasonText: 'AIが提案せず' }));
    expect(v.rationale).toBe(`${HM} 節目まで距離があり置けない`);
    expect(v.rationale).not.toContain('目線');
  });

  it('③★lastNone が無い回は従来の PanelView と byte 一致(否定対照)', () => {
    expect(buildSignalView(waiting())).toEqual({ cls: 'flat', main: 'シグナル待機（節目クロス待ち）', rationale: '' });
    expect(buildSignalView(null)).toEqual({ cls: 'flat', main: 'シグナル待機', rationale: '' });
  });

  it('★決済直後に待機へ戻る経路でも同じ行が出る(4つの flat 分岐が同じ関数を通る)', () => {
    const v = buildSignalView({
      phase: 'flat', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, at: 10 },
      lastExit: { exitPrice: 65400, pnl: 5, at: 20 },
      lastNone: SPLIT_NONE,
    });
    expect(v.cls).toBe('flat');
    expect(v.rationale).toContain('レンジ目線');
  });
});

describe('§シグナルが在る回は1バイトも変わらない', () => {
  // ★実運用では server が phase!=='flat' のとき lastNone を **そもそも載せない** ので、
  //   armed / filled でこの入力が来ることは無い。ここで固定しているのは
  //   「web 側だけを見たときにも表示が増えないこと」= **回帰の検知** であって、
  //   到達可能な経路の検証ではない(=「二重で押さえている」とは言えない)。
  const armed: SignalTradeState = {
    phase: 'armed', updatedAt: 0,
    signal: {
      signalId: 1, direction: 'buy', limitEntry: 65340, stopLossForLimit: 65280,
      rationale: '押し目買い', strategy: 'トレンド押し目・戻り', at: 10,
    },
  };

  it('④ armed(シグナル在り): lastNone を足しても PanelView は同一', () => {
    const before = buildSignalView(armed);
    const after = buildSignalView({ ...armed, lastNone: SPLIT_NONE });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('保有枠(buildPositionView)も同一', () => {
    const filled: SignalTradeState = {
      phase: 'filled', updatedAt: 0,
      position: { direction: 'buy', entryPrice: 65340, qty: 1, unrealized: 12, at: 10 },
    };
    expect(JSON.stringify(buildPositionView({ ...filled, lastNone: SPLIT_NONE }, 100)))
      .toBe(JSON.stringify(buildPositionView(filled, 100)));
    // 保有なし(待機)の保有枠も従来どおり(ここに理由は出さない=枠の役割が違う)。
    expect(buildPositionView({ phase: 'flat', updatedAt: 0, lastNone: SPLIT_NONE }, 100))
      .toEqual({ cls: 'flat', main: '保有なし', rationale: '' });
  });
});

// ★2026-08-24(リーダー裁定②): `none_reason='ai'` のときは「見送り: …」の行を出さない。
//   実測(8/19以降の見送りの大多数)で、この形は同じことを2回言っていた:
//       明確なエントリー機会が無いため見送り。   ← AI 自身の理由(上の行)
//       見送り: AIが提案せず                     ← 情報を1ビットも足していない
//   ★SSOT(server/llm/scalpPlan.ts の LEG_DROP_REASON_TEXT)には触らず、**表示側だけ** で出し分ける。
describe('§none_reason=ai は「見送り」の行を出さない', () => {
  it('reason=ai では3行目が消える(理由の行は残る)', () => {
    expect(buildWaitNoteLines({ at: AT, bias: 'buy', why: '良い場面が無い', reason: 'ai', reasonText: 'AIが提案せず' }))
      .toEqual([`${HM} 買い目線 ／ 良い場面が無い`]);
  });

  it('★他の none_reason は従来どおり出す(コードが落とした=AI の理由文には書かれていない)', () => {
    const t = (reason: string, reasonText: string): string[] =>
      buildWaitNoteLines({ at: AT, why: 'x', reason, reasonText });
    expect(t('rangeDisabled', 'レンジ設定が無効')).toEqual([`${HM} x`, '見送り: レンジ設定が無効']);
    expect(t('geometry', 'エントリーが現在値の逆側')).toEqual([`${HM} x`, '見送り: エントリーが現在値の逆側']);
    expect(t('aiSilent', 'AIが理由も価格も返さず')).toEqual([`${HM} x`, '見送り: AIが理由も価格も返さず']);
    expect(t('trend', 'トレンドに逆行')).toEqual([`${HM} x`, '見送り: トレンドに逆行']);
  });
});

// ★2026-08-24(リーダー裁定① / エバリュエーター指摘④): コードが抑止した回は書き分ける。
//   ★語は新しくない: 「不採用」= 根拠文の注記(`（指値は不採用: エントリーが現在値の逆側）`)で
//     既に画面に出ている語 / 「計画」= 設定画面のヒント(「…より狭い計画は出しません」)の語。
//   ★主語を書く理由: 脚の注記と3行目が隣り合うと、同じ「不採用」が違う階層を指してしまう。
describe('§コードが抑止した回は「計画は不採用」と書き分ける', () => {
  it('★実測7件の形(サニティ不通過): 目線と理由が出て、3行目は「計画は不採用: …」', () => {
    // ★reasonText は server(planNote.ts の GATE_TEXT)が運んでくる。web は写しを持たない。
    expect(buildWaitNoteLines({
      at: AT, bias: 'sell', why: '強いサポートを下抜けることで下落が期待できる',
      reason: 'sanity', suppressed: true, reasonText: 'エントリーが現在値から遠い',
    })).toEqual([
      `${HM} 売り目線 ／ 強いサポートを下抜けることで下落が期待できる`,
      '計画は不採用: エントリーが現在値から遠い',
    ]);
  });

  it('★④ 脚の注記が理由の行に混ざっても、階層が読み分けられる(主語が違う)', () => {
    // 実データ(2026-08-18 の1件)と同じ形: 理由の行がコードの脚注記だけになる回。
    const lines = buildWaitNoteLines({
      at: AT, bias: 'sell', why: '（指値は不採用: エントリーが現在値の逆側）',
      reason: 'sanity', suppressed: true, reasonText: 'エントリーが現在値から遠い',
    });
    expect(lines[0]).toContain('指値は不採用');                          // ← 脚1本の話
    expect(lines[1]).toBe('計画は不採用: エントリーが現在値から遠い');   // ← サイクル全体の話
    // ★主語が違うこと自体を固定する(どちらも「不採用」だけ、にはしない)。
    expect(lines[1]!.startsWith('不採用')).toBe(false);
    expect(lines[1]!.startsWith('計画は')).toBe(true);
  });

  it('日本語が既存語彙に在るゲートはそれを添える', () => {
    expect(buildWaitNoteLines({ at: AT, bias: 'buy', reason: 'stale', reasonText: '現在値が既にエントリーを通過', suppressed: true }))
      .toEqual([`${HM} 買い目線`, '計画は不採用: 現在値が既にエントリーを通過']);
    expect(buildWaitNoteLines({ at: AT, bias: 'buy', reason: 'armBlocked', reasonText: '連続失効', suppressed: true }))
      .toEqual([`${HM} 買い目線`, '計画は不採用: 連続失効']);
  });

  it('★「見送り」とは必ず別の語になる(AI が止めたのか こちらが止めたのかが読める)', () => {
    const sup = buildWaitNoteLines({ at: AT, reason: 'stale', reasonText: '現在値が既にエントリーを通過', suppressed: true });
    const none = buildWaitNoteLines({ at: AT, reason: 'stale', reasonText: '現在値が既にエントリーを通過' });
    expect(sup[0]).toBe(`${HM} 計画は不採用: 現在値が既にエントリーを通過`);
    expect(none[0]).toBe(`${HM} 見送り: 現在値が既にエントリーを通過`);
    expect(sup[0]).not.toBe(none[0]);
  });

  it('★待機枠に実際に出る(buildSignalView 経由)', () => {
    const v = buildSignalView({
      phase: 'flat', updatedAt: 0, waitReason: { kind: 'level' },
      lastNone: {
        at: AT, bias: 'sell', why: '下降トレンドが続く',
        reason: 'sanity', suppressed: true, reasonText: 'エントリーが現在値から遠い',
      },
    });
    expect(v.main).toBe('シグナル待機（節目クロス待ち）');
    expect(v.rationale.split('\n'))
      .toEqual([`${HM} 売り目線 ／ 下降トレンドが続く`, '計画は不採用: エントリーが現在値から遠い']);
  });
});

// ★reasonText が来ない回(旧 server / 表に無いゲート)でも「計画は不採用」は必ず出す。
//   ★黙って消えない=無言の失敗を作らない(server/signalTrade/planNote.ts の防御と対になる規約)。
describe('§reasonText が来なくても「計画は不採用」は消えない', () => {
  it('reasonText 欠落 → 「計画は不採用」だけ(旧 server / 未知のゲートへの防御)', () => {
    expect(buildWaitNoteLines({ at: AT, bias: 'sell', reason: 'unknownGate', suppressed: true }))
      .toEqual([`${HM} 売り目線`, '計画は不採用']);
  });
});
