// ★「出さないと述べたレッグ」と「実際に発注されるレッグ」の突き合わせ(純関数)の単体テスト。
//
// ■ 何を守っているか
//   AI は根拠文に「ブレイク新規は下限に届かないので省略した」と書きながら、下限を満たす
//   **有効な価格対** を出すことがある。その場合コードは何も落とさないので、そのレッグは発注される。
//   = AI の意図と実際の注文が食い違ったまま素通りする。ここはそれを **数えるだけ** の道具。
//
// ■ ★誤検出をしないこと(このファイルの主目的)
//   「指値レッグは出したが、ブレイク新規は省略した」という **正しい表明** を拾ってはいけない。
//   表明の語は、同じ文の中で直前にある見出しのレッグにだけ割り当てる。同じ文に2種類の見出しが
//   先行するときは決められないので **捨てる**(推測しない)。否定形(省略しない)も表明ではない。
//
// ■ ★否定対照: このモジュール自体が新規。git show HEAD:server/llm/ に rationaleOmission.ts は無い。

import { describe, it, expect } from 'vitest';
import { parseOmissionClaims, auditOmissionClaims } from './rationaleOmission.js';

const BOTH = { limit: true, stop: true };
const LIMIT_ONLY = { limit: true, stop: false };

describe('parseOmissionClaims(どのレッグについて「出さない」と述べたか)', () => {
  it('★実データの形: ブレイク新規の省略を stop に割り当てる(指値には割り当てない)', () => {
    const rat = 'ブレイク新規レッグのLC幅が55円未満のため省略。指値レッグは65480円で設定。';
    expect(parseOmissionClaims(rat)).toEqual([{ leg: 'stop', word: '省略' }]);
  });

  it('★正しい表明を誤検出しない: 「指値レッグは出したが、ブレイク新規は省略した」', () => {
    const rat = '指値レッグは出したが、ブレイク新規は省略した。';
    // 直前の見出しは「ブレイク新規」= stop 1本だけ。指値には付かない。
    expect(parseOmissionClaims(rat)).toEqual([{ leg: 'stop', word: '省略' }]);
  });

  it('★指値側の表明も同じ規則で読む(語順が逆でもレッグ名で対応付ける)', () => {
    const rat = 'ブレイク新規は65380円で設定。両方とも幅を満たしていないため、指値は省略します。';
    expect(parseOmissionClaims(rat)).toEqual([{ leg: 'limit', word: '省略' }]);
  });

  it('「見送り」も表明として読む(実データで最も多い語)', () => {
    const rat = '直近サポートが近いためブレイク新規は見送り、指値のみで対応します。';
    expect(parseOmissionClaims(rat)).toEqual([{ leg: 'stop', word: '見送' }]);
  });

  it('★同じ句に2種類の見出しが在ったら決めない(「指値やブレイク新規の場面が無いため見送り」)', () => {
    // 実台帳に実在する形。どちらのレッグの話でもあるので、近い方(ブレイク新規)に寄せない。
    expect(parseOmissionClaims('指値やブレイク新規の価格設定も適切に行えないため見送りとする。')).toEqual([]);
    expect(parseOmissionClaims('指値とブレイク新規の良いエントリー場面が無いため見送りとします。')).toEqual([]);
    expect(parseOmissionClaims('指値やブレイク新規の良いエントリー場面が無いため、見送りとします。')).toEqual([]);
  });

  it('句を跨いでも、その文の見出しが1種類だけなら読む(「ブレイク新規レッグ LC=25円で、…ため省略」)', () => {
    expect(parseOmissionClaims('LC幅はブレイク新規レッグ LC=25円で、条件を満たさないため省略。'))
      .toEqual([{ leg: 'stop', word: '省略' }]);
  });

  it('★プラン全体の見送り(見出しが同じ文に無い)はどのレッグにも割り当てない', () => {
    expect(parseOmissionClaims('明確なトレンドが無いため見送りとします。')).toEqual([]);
    // 見出しが **前の文** にあっても跨がない。
    expect(parseOmissionClaims('指値レッグを検討した。優位性が無いため見送る。')).toEqual([]);
  });

  it('★否定形は表明ではない(「省略しない」「見送らない」)', () => {
    expect(parseOmissionClaims('ブレイク新規レッグは省略しない。')).toEqual([]);
    expect(parseOmissionClaims('ブレイク新規は見送らない。')).toEqual([]);
  });

  it('両レッグについて別々に述べていれば2件返る(レッグの固定順)', () => {
    const rat = 'ブレイク新規は省略します。指値レッグも出さない。';
    expect(parseOmissionClaims(rat)).toEqual([
      { leg: 'limit', word: '出さない' },
      { leg: 'stop', word: '省略' },
    ]);
  });

  it('同じレッグに複数の表明があっても1件にまとめる(同じ事実を二重に数えない)', () => {
    const rat = 'ブレイク新規は省略。ブレイク新規レッグは見送り。';
    expect(parseOmissionClaims(rat)).toEqual([{ leg: 'stop', word: '省略' }]);
  });

  it('空/未指定/見出し無しは空配列(例外を投げない)', () => {
    expect(parseOmissionClaims(null)).toEqual([]);
    expect(parseOmissionClaims(undefined)).toEqual([]);
    expect(parseOmissionClaims('')).toEqual([]);
    expect(parseOmissionClaims('省略します')).toEqual([]);
  });
});

describe('auditOmissionClaims(表明 vs 実際に発注されるレッグ)', () => {
  it('★矛盾: 「省略した」と述べたレッグが最終プランに在る(=そのまま発注される)', () => {
    const rat = '両方とも55円以上のLC幅を満たしていないため、指値は省略します。';
    expect(auditOmissionClaims(rat, LIMIT_ONLY)).toEqual([
      { leg: 'limit', word: '省略', present: true, status: 'contradiction' },
    ]);
  });

  it('一致: 「省略した」と述べたレッグは実際に無い(コードが落とした回も含む)', () => {
    const rat = 'ブレイク新規レッグのLC幅が55円未満のため省略。';
    expect(auditOmissionClaims(rat, LIMIT_ONLY)).toEqual([
      { leg: 'stop', word: '省略', present: false, status: 'consistent' },
    ]);
  });

  it('表明が読めなければ空配列(=列に何も書かない。「観測できた」と「0件」を混ぜない)', () => {
    expect(auditOmissionClaims('上下に反応帯。両レッグを配置。', BOTH)).toEqual([]);
  });
});
