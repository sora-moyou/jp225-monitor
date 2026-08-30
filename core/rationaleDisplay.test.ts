import { describe, it, expect } from 'vitest';
import { stripLcArithmetic, NO_REASON } from './rationaleDisplay.js';
// ★語彙の突き合わせ用。stripLcArithmetic は server/llm/rationaleLc.ts の語彙の **写し** なので、
//   同じサンプル文字列で「監査が LC 申告として読む」= 「表示から落ちる」ことを固定する。
//   片方だけ直すとここが落ちる(= 写しがずれたことに気づける)。
import { parseLcDeclarations } from '../server/llm/rationaleLc.js';

// ★ユーザーが実際に画面で見た文字列(2026-08-17)。これが何になるかを固定する。
const REAL = '指値レッグ 68725 と 68665 の引き算 → LC幅は60円。ブレイク新規レッグ 68780 と 68840 の引き算 → LC幅は60円。';

describe('stripLcArithmetic: LC幅の検算だけを落とす', () => {
  it('★実際に画面に出た LC検算だけの文字列は、丸ごと落ちて NO_REASON になる', () => {
    // 全部落ちると空になる。空にすると **無言の失敗**(AI が書かなかったのか剥がし過ぎたのか区別できない)に
    // なるので、理由が書かれていないという事実を印として出す。元文字列は戻さない
    // (実測: 直近セッションの根拠文は 19件中17件が検算だけ=元を戻すと画面がほぼ何も変わらない)。
    expect(stripLcArithmetic(REAL)).toBe(NO_REASON);
    expect(NO_REASON).toBe('（理由の記載なし）');
  });

  it('★理由の本文が在れば、LC検算の文だけが落ちて本文が残る', () => {
    const input = `21日線を上抜けて押し目待ち。${REAL}`;
    expect(stripLcArithmetic(input)).toBe('21日線を上抜けて押し目待ち。');
  });

  it('書式②(代入の式)も落ちる', () => {
    expect(stripLcArithmetic('押し目を待つ。指値レッグ 65540 + 55 = 65595。')).toBe('押し目を待つ。');
    expect(stripLcArithmetic('押し目を待つ。65015+LC幅(55)=65070')).toBe('押し目を待つ。');
  });

  it('幅の申告だけの文も落ちる', () => {
    expect(stripLcArithmetic('押し目を待つ。LC幅は60円。')).toBe('押し目を待つ。');
    expect(stripLcArithmetic('押し目を待つ。LC=55円')).toBe('押し目を待つ。');
    expect(stripLcArithmetic('押し目を待つ。lcWidthForStop = 60円')).toBe('押し目を待つ。');
  });

  it('★コード側が機械生成で足す注記は絶対に落とさない', () => {
    // rangeDropNote(行で分けて描かれる)
    const range = `${REAL}\n※上部(売り指値)は不採用: 損切り幅が設定の下限より狭い`;
    expect(stripLcArithmetic(range)).toBe('※上部(売り指値)は不採用: 損切り幅が設定の下限より狭い');
    // buildLegNote(本文と半角スペースで連結される)
    const leg = '戻り売りを狙う。 （逆指値なし: AIが提案せず）';
    expect(stripLcArithmetic(leg)).toBe(leg);
    expect(stripLcArithmetic('戻り売りを狙う。（逆指値は不採用: 損切り幅が設定の下限より狭い）'))
      .toBe('戻り売りを狙う。（逆指値は不採用: 損切り幅が設定の下限より狭い）');
  });

  it('★LC に触れていても理由が混ざる文は残す(判断理由の本文を落とさない側に倒す)', () => {
    const s = 'LC幅は60円とし、直近安値の外側に置く。';
    expect(stripLcArithmetic(s)).toBe(s);
  });

  // ★NO_REASON の安全性の根拠を固定する。isLcOnlyFragment は「実質の語が1つも残らない断片」しか
  //   落とさないので、理由が1語でも書かれていれば必ず残り、NO_REASON にはならない。
  //   ここが崩れると「AI は理由を書いたのに画面には『記載なし』と出る」= 嘘をつく表示になる。
  it('★理由が1語でも含まれていれば絶対に NO_REASON にならない', () => {
    const REASONS = [
      '上昇トレンド継続。',
      '押し目買い',
      'レジスタンス手前で戻り売り。',
      '方向感なし。',                       // 見送りの理由(短い)
      'ニュースで急伸。',
      'サポート S1 の内側に指値。',          // 節目の記号だけの理由
      '68700の節目を上抜け。',               // 価格を含む理由
      'LC幅は60円とし、直近安値の外側に置く。', // LC に触れているが理由が混ざる
      // ★穴埋め語(損切りの位置/エントリー価格)を filler に入れた副作用の検査。
      //   「損切りの位置」という語が入っていても、理由(直近安値/外側)が在れば必ず残る。
      '損切りの位置は直近安値の外側に置く。',
      'エントリー価格はサポートの内側に寄せる。',
    ];
    for (const r of REASONS) {
      // 理由だけ / 理由+検算 のどちらでも、理由は残り NO_REASON にはならない。
      expect(stripLcArithmetic(r)).not.toBe(NO_REASON);
      const withLc = stripLcArithmetic(`${r}${REAL}`);
      expect(withLc).not.toBe(NO_REASON);
      expect(withLc).toContain(r.replace(/。$/, ''));
    }
  });

  // ★プロンプト自身の穴埋め語(`(損切りの位置)` / `(エントリー価格)`)を AI が埋めずに写してくる回。
  //   実データ(signals_kabu.db・複製)の実物をそのまま入力にする。判断理由は1語も無いので落ちる。
  it('★穴埋め語を写しただけの検算は落ちる(実データの実物・id=2197/2203/2204)', () => {
    const REALS = [
      '指値レッグ (69105)と(損切りの位置)69105-69045の引き算 → LC幅は60円。ブレイク新規レッグ (69185)と(損切りの位置)69185-69125の引き算 → LC幅は60円。',
      '指値レッグ 69100と(損切りの位置)の引き算 → LC幅は60円。ブレイク新規レッグ 68950と(損切りの位置)の引き算 → LC幅は60円。',
      '指値レッグ 69000と(損切りの位置68860)の引き算 → LC幅は60円。ブレイク新規レッグ 68880と(損切りの位置68840)の引き算 → LC幅は60円。',
    ];
    for (const r of REALS) expect(stripLcArithmetic(r)).toBe(NO_REASON);
  });

  it('★穴埋め語と同じ言葉でも、理由が書かれていれば落ちない', () => {
    // 「損切りの位置」を filler にしても「直近安値」「外側」が残るので、この文は必ず生き残る。
    expect(stripLcArithmetic('損切りの位置は直近安値の外側に置く。')).toBe('損切りの位置は直近安値の外側に置く。');
    expect(stripLcArithmetic('損切りの位置は直近安値の外側。指値レッグ 65540 + 55 = 65595。'))
      .toBe('損切りの位置は直近安値の外側。');
  });

  // ★2026-08-17 に塞いだ2つの穴(旧「☆既知の穴」テストを置き換え)。
  //   置き換えた理由: 旧テストは「いま落ちない」ことを固定していたが、ユーザー判断
  //   「過去との整合性より、正しいシグナル表示を優先」により両方を塞いだ。穴が塞がった以上、
  //   旧テストは **実態と食い違う記述** になるので残さない(残すのが最悪という要件)。
  it('★括弧付き「LC幅は(55)円」も落ちる(旧・既知の穴①)', () => {
    expect(stripLcArithmetic('指値レッグ (68870)と(68625)の引き算 → LC幅は(55)円。')).toBe(NO_REASON);
    expect(stripLcArithmetic('押し目を待つ。LC幅は(55)円。')).toBe('押し目を待つ。');
    // 助詞なしの従来形(「LC幅(55)」)は今までどおり落ちる=回帰なし。
    expect(stripLcArithmetic('押し目を待つ。LC幅(55)')).toBe('押し目を待つ。');
  });

  it('★全角「ＬＣ＝５５円」も落ちる(旧・既知の穴②)', () => {
    expect(stripLcArithmetic('ＬＣ＝５５円')).toBe(NO_REASON);
    expect(stripLcArithmetic('押し目を待つ。ＬＣ幅は６０円。')).toBe('押し目を待つ。');
    // ★落とさない文は1バイトも書き換えない(正規化は判定にしか使わない)。
    expect(stripLcArithmetic('ＬＣ幅は６０円とし、直近安値の外側に置く。'))
      .toBe('ＬＣ幅は６０円とし、直近安値の外側に置く。');
  });

  it('★機械生成の注記が在れば NO_REASON にならない(注記が理由の代わりになる)', () => {
    expect(stripLcArithmetic(`${REAL}\n※上部(売り指値)は不採用: 損切り幅が設定の下限より狭い`))
      .not.toBe(NO_REASON);
  });

  it('LC を含まない普通の理由文は1バイトも変わらない', () => {
    const s = '上昇トレンド継続。68700のサポートで押し目買い。\n※下部のレッグなし: AIが提案せず';
    expect(stripLcArithmetic(s)).toBe(s);
  });

  it('空/未定義は空文字', () => {
    expect(stripLcArithmetic('')).toBe('');
    expect(stripLcArithmetic(null)).toBe('');
    expect(stripLcArithmetic(undefined)).toBe('');
  });
});

// ─── 語彙の突き合わせ(写しがずれたら落ちる) ───
describe('server/llm/rationaleLc.ts と同じ語彙を見ているか', () => {
  const SAMPLES = [
    '指値レッグ 68725 と 68665 の引き算 → LC幅は60円。',
    'ブレイク新規レッグ 68780 と 68840 の引き算 → LC幅は60円。',
    '指値レッグ 65540 + 55 = 65595',
    '65015+LC幅(55)=65070',
    'LC幅は60円',
    'LC=55円',
    // ★2026-08-17 に塞いだ2形。写しがずれたら(片方だけ直したら)ここで落ちる。
    '指値レッグ (68870)と(68625)の引き算 → LC幅は(55)円。',
    'ＬＣ＝５５円',
    'ＬＣ幅は６０円',
    // ★v0.9.104 に足した2形。現行プロンプトが実際に書かせている語(実測 v0.9.102)。
    '損切幅は60円',
    '（LC幅60円）',
    '(LC幅65円)',
  ];
  for (const s of SAMPLES) {
    it(`「${s}」: 監査は LC 申告として読み、表示からは落ちる`, () => {
      const d = parseLcDeclarations(s);
      const declared = d.limit.length + d.stop.length + d.unassigned.length + d.equations.length;
      expect(declared).toBeGreaterThan(0);            // 監査(server)は読める
      expect(stripLcArithmetic(`理由の本文。${s}`)).toBe('理由の本文。');   // 表示(core)は落とす
    });
  }
});
