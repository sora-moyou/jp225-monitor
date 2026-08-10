import { describe, it, expect } from 'vitest';
import { redactSecrets, sanitizeErrorForOutput, stripParsedInputSnippet } from './redact.js';

// ─── ★伏字規則の両方向テスト ─────────────────────────────────────────────
//
// 症状: 旧実装は `\b(sk|gsk|…)` / `\bAIza` で、**直前が単語文字だと伏字が効かなかった**。
//   key:gsk_… → 伏せる / xxgsk_… → 伏せない
// ログを 60→240 字へ広げた以上、広げた側で塞ぐべき穴(漏れても気づく手段が無い)。
//
// ★このプロジェクトの実績: 誤爆を潰す修正は取りこぼしを増やし、逆も同じ。
//   だから「拾わねばならない表」と「拾ってはいけない表」を**両方**固定する。
// ★実在のキーは1文字も書かない。すべて架空の文字列。

/** ★否定対照: `git show HEAD:server/llm/modelCheck.ts` の redactSecrets(修正前)をそのまま写した実装。
 *  これと新実装の差分が「今回何を塞いだか」の機械的な証拠になる。 */
function redactSecretsOld(msg: string): string {
  return msg
    .replace(/\b(sk|gsk|sk-proj|sk-ant)[-_][A-Za-z0-9*_-]{6,}/g, '<キー伏字>')
    .replace(/\bAIza[A-Za-z0-9*_-]{6,}/g, '<キー伏字>');
}

/** 架空のキー本体(実在のキーではない)。 */
const FAKE = {
  groq: 'gsk_FAKEkey0123456789abcdef',
  openaiProj: 'sk-proj-FAKE0123456789abcdefGHIJ',
  anthropic: 'sk-ant-FAKE0123456789abcdefGHIJ',
  google: 'AIzaSyFAKE0123456789abcdefGHIJ',
  openaiLegacy: 'sk-FAKE0123456789abcdefGHIJ',
} as const;

describe('redactSecrets — 拾わねばならない(直前が単語文字でも伏せる)', () => {
  const glued: Array<[string, string]> = [
    ['xx', FAKE.groq],
    ['key', FAKE.groq],
    ['1', FAKE.groq],
    ['X', FAKE.openaiProj],
    ['token', FAKE.openaiProj],
    ['9', FAKE.anthropic],
    ['1', FAKE.google],
    ['abc', FAKE.google],
  ];
  for (const [lead, key] of glued) {
    it(`「${lead}」に接着した ${key.slice(0, 7)}… を伏せる`, () => {
      const out = redactSecrets(`upstream said: ${lead}${key} — check it`);
      expect(out).not.toContain(key);
      expect(out).not.toContain(key.slice(0, 12));   // 断片も残さない
      expect(out).toContain('<キー伏字>');
      // ★否定対照: 修正前は同じ入力でキーがそのまま残っていた
      expect(redactSecretsOld(`upstream said: ${lead}${key} — check it`)).toContain(key);
    });
  }

  it('従来どおり区切りの後ろ(語頭)も伏せる=取りこぼしを増やしていない', () => {
    for (const key of Object.values(FAKE)) {
      const msg = `401 Incorrect API key provided: ${key}. See docs`;
      expect(redactSecrets(msg)).not.toContain(key);
      expect(redactSecretsOld(msg)).not.toContain(key);   // 旧でも伏せていた=挙動を落としていない
    }
  });

  it('提供元がキーを一部伏せてエコーバックした形も従来どおり伏せる', () => {
    // 実測形: `Incorrect API key provided: sk-proj-****…Y9EA`
    const out = redactSecrets('401 Incorrect API key provided: sk-proj-****…Y9EA');
    expect(out).toContain('<キー伏字>');
    expect(out).not.toContain('sk-proj-****');
  });
});

describe('redactSecrets — 拾ってはいけない(診断値を黙って消さない)', () => {
  // ★ここが緩むと「伏字による無言の情報喪失」= 今回直したばかりの欠陥の再発になる。
  const keep = [
    '404 not found the model kimi-latest',
    '404 Not found the model kimi-latest or Permission denied',
    '413 Request too large for model `llama-3.3-70b-versatile` in organization `org_xxx` '
      + 'service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 13500, '
      + 'please reduce your message size and try again.',
    'models/gemini-flash-latest is not found for API version v1beta, or is not supported for generateContent',
    '401 Unauthorized. You can find your API key at https://platform.openai.com/account/api-keys',
    '503 status code (no body) — upstream temporarily unavailable',
    'model gpt-4o-mini / moonshot-v1-8k / kimi-k2-turbo-preview は使えません',
    // ★裸の sk- が英単語に含まれる形(左境界を一律に外すと壊れるもの)
    'task-manager-restart failed',
    'risk-free-rate is unavailable',
    'disk-usage-warning: 91%',
    'asterisk-separated-values could not be parsed',
    'kiosk_mode_disabled by policy',
  ];
  for (const msg of keep) {
    it(`そのまま残す: ${msg.slice(0, 42)}…`, () => {
      expect(redactSecrets(msg)).toBe(msg);
    });
  }

  // ★検討した2案が、なぜどちらも不採用かを**実測で**残す(次に触る人が同じ道を辿らないため)。
  //   案A: \b → (?<![A-Za-z0-9]) … 穴が塞がらない。\b も (?<![A-Za-z0-9]) も
  //        「直前が英数字なら不一致」で、差は **直前が `_` の時だけ**。xxgsk_… は依然として漏れる。
  //   案B: 左境界を一律に撤去   … 穴は塞がるが、裸の sk- が英単語(task/risk/disk)を伏せる。
  it('★案A(\\b → (?<![A-Za-z0-9]))では穴が塞がらない=採らなかった理由', () => {
    const caseA = (s: string) => s
      .replace(/(?<![A-Za-z0-9])(sk|gsk|sk-proj|sk-ant)[-_][A-Za-z0-9*_-]{6,}/g, '<キー伏字>')
      .replace(/(?<![A-Za-z0-9])AIza[A-Za-z0-9*_-]{6,}/g, '<キー伏字>');
    for (const [lead, key] of [['xx', FAKE.groq], ['key', FAKE.groq],
      ['X', FAKE.openaiProj], ['1', FAKE.google]] as const) {
      expect(caseA(`${lead}${key}`)).toContain(key);        // 案Aでは漏れたまま
      expect(redactSecrets(`${lead}${key}`)).not.toContain(key);   // 採用版は塞ぐ
    }
    // 案Aで唯一変わるのは「直前が _ 」の場合だけ。採用版はこれも塞ぐ。
    expect(redactSecrets(`_${FAKE.groq}`)).not.toContain(FAKE.groq);
  });

  it('★案B(左境界を一律に撤去)は英単語を伏せる=採らなかった理由', () => {
    const caseB = (s: string) => s
      .replace(/(sk|gsk|sk-proj|sk-ant)[-_][A-Za-z0-9*_-]{6,}/g, '<キー伏字>');
    expect(caseB('task-manager-restart failed')).toContain('<キー伏字>');
    expect(caseB('risk-free-rate is unavailable')).toContain('<キー伏字>');
    expect(caseB('disk-usage-warning: 91%')).toContain('<キー伏字>');
    // 採用版は消さない(診断値を黙って落とさない)
    expect(redactSecrets('task-manager-restart failed')).toBe('task-manager-restart failed');
    expect(redactSecrets('risk-free-rate is unavailable')).toBe('risk-free-rate is unavailable');
    expect(redactSecrets('disk-usage-warning: 91%')).toBe('disk-usage-warning: 91%');
  });

  // ★一度入れて**落とした**規則(3)(語中の裸 sk- を「大文字+数字を含む」条件で拾う)の記録。
  //   落とした理由: 穴を塞ぎきれない(小文字だけの旧式キーは素通しのまま)のに、
  //   普通の英語 slug を伏せてしまう=誤爆だけが残る形だったため。ここに両方向を固定する。
  it('★規則(3)を落とした結果(誤爆しない側): 英語 slug は伏せない', () => {
    for (const s of ['disk-Usage2024 exceeded', 'task-queue-Worker3 stalled',
      'risk-adjusted-Return2024 recalculated', 'kiosk-Mode-2 disabled',
      'asterisk-Delimited-3 parse error', 'disk-antivirus_Scan2 running']) {
      expect(redactSecrets(s)).toBe(s);
    }
  });
  it('★規則(3)を落とした結果(未カバー側・既知): 語中に接着した裸の sk- は素通しになる', () => {
    // 実キー形式(gsk_/sk-proj-/sk-ant-/AIza)ではないので、いま使うプロバイダでは発生しない形。
    // 発生源が増えたら規則(1)に接頭辞を足すのが正しい直し方(高エントロピー推定に戻さない)。
    const glued = `prefix${FAKE.openaiLegacy}`;
    expect(redactSecrets(glued)).toBe(glued);
    // 語頭(区切りの後ろ)なら従来どおり伏せる=旧挙動は落ちていない
    expect(redactSecrets(`provided: ${FAKE.openaiLegacy}`)).not.toContain(FAKE.openaiLegacy);
  });

  // ★冪等性: /api/scalp-plan は **発生源(llm/scalpPlan の catch)と境界(route)の両方**で通す。
  //   二重適用で文字列が変わらないことが、その設計の前提になっている。
  it('★冪等(二重適用しても文字列が変わらない)', () => {
    for (const s of [`401 provided: ${FAKE.openaiProj}`, `key=${FAKE.google}`,
      '404 not found the model kimi-latest', 'task-manager-restart failed']) {
      const once = redactSecrets(s);
      expect(redactSecrets(once)).toBe(once);
    }
  });

  it('伏せるのはキー部分だけで、周りの診断値は残る', () => {
    const out = redactSecrets(`401 Incorrect API key provided: ${FAKE.openaiProj}. `
      + 'You can find your API key at https://platform.openai.com/account/api-keys');
    expect(out).toContain('401');
    expect(out).toContain('Incorrect API key provided');
    expect(out).toContain('https://platform.openai.com/account/api-keys');
    expect(out).not.toContain(FAKE.openaiProj);
  });
});

// ─── ★sanitizeErrorForOutput: プロセスの外へ出る文字列の唯一の入口(順序の SSOT) ──────
//
// なぜ V8 断片まで落とすか(ノイズ除去ではなく**秘密**の話):
//   scalp-plan のプロンプトには describeExitLogic() が **非公開の決済ロジックの実数値** を
//   実行時注入しており、モデルは根拠文でその数値を言い直すことがある。パース失敗時の
//   30字窓がそれを含む可能性は否定できず、断片は /api/scalp-plan の応答 → trade2 →
//   chrono_kabu.log → 同期フォルダ、と外へ出る。気づく手段が無いので落とす側に倒す。
// ★このファイルには実数値を書かない(検査そのものが漏洩になっては本末転倒)。
//   下の数値はすべて**架空**で、「数値を含む断片が丸ごと消える」ことだけを見る。
describe('sanitizeErrorForOutput — 順序は 伏字 → 断片除去', () => {
  const FAKE_EXIT_NOTE = '含み益+9999円で逆指値を+8888円へ、以降1111円刻み';   // ★架空の数値

  /** 実際に JSON.parse を失敗させて V8 のメッセージを得る(形をハードコードしない)。 */
  function v8Message(input: string): string {
    try { JSON.parse(input); throw new Error('パースが成功してしまった'); }
    catch (e) { return e instanceof Error ? e.message : String(e); }
  }

  it('★モデル生出力の断片(架空の決済数値を含む)が丸ごと消える', () => {
    const msg = `parse failed after retry: JSON parse failed: ${
      v8Message(`{"pad":"${'y'.repeat(200)}","legs":["${FAKE_EXIT_NOTE}",あ]}`)}`;
    // 前提: 断片にアプリのデータが実際に入っている(窓は約30字なので入る数値は形次第)
    expect(/9999|8888|1111|刻み/.test(msg)).toBe(true);
    const out = sanitizeErrorForOutput(msg);
    expect(out).toContain('<入力省略>');
    expect(out).toContain('parse failed after retry');   // 失敗した事実は残る
    expect(out).toContain('Unexpected token');           // 例外の種類も残る
    for (const n of ['9999', '8888', '1111', '刻み', '逆指値']) {
      if (msg.includes(n)) expect(out).not.toContain(n);
    }
  });

  it('★順序が 伏字 → 断片除去 であること(合成そのものを固定)', () => {
    for (const s of [
      `401 provided: ${FAKE.openaiProj}`,
      v8Message(`{"k":"${FAKE.groq}",あ}`),                       // 断片の中にキーがある形
      `${v8Message('あ')} / key=${FAKE.google}`,                   // 断片の外にキーがある形
      '404 not found the model kimi-latest',
    ]) {
      expect(sanitizeErrorForOutput(s)).toBe(stripParsedInputSnippet(redactSecrets(s)));
    }
  });

  it('★断片の中にキーの断片が入っても外に出ない', () => {
    // V8 の窓(約30字)は接頭辞を含まないキーの**尾**を写すことがある(実測: `..."89abcdef",あ]}"`)。
    // 尾だけでは伏字の接頭辞規則に掛からない=断片除去の側が最後の防波堤になる。
    const msg = v8Message(`{"pad":"${'y'.repeat(200)}","legs":["${FAKE.groq}",あ]}`);
    const tail = FAKE.groq.slice(-8);
    expect(msg).toContain(tail);                       // 前提: 尾がメッセージに写っている
    expect(redactSecrets(msg)).toContain(tail);        // ★伏字だけでは落ちない(尾に接頭辞が無い)
    expect(sanitizeErrorForOutput(msg)).not.toContain(tail);
  });

  it('★プロバイダの実エラー文は1文字も変わらない', () => {
    for (const s of [
      '413 Request too large for model `llama-3.3-70b-versatile` in organization `org_xxx` '
        + 'service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 13500, '
        + 'please reduce your message size and try again.',
      '404 Not found the model kimi-latest or Permission denied',
      'models/gemini-flash-latest is not found for API version v1beta, or is not supported for generateContent',
      '503 status code (no body)',
      '429 rate_limit_exceeded: Limit 6000, Used 6000, Requested 512',
      'chart-not-generated', 'LLM未設定',
    ]) {
      expect(sanitizeErrorForOutput(s)).toBe(s);
    }
  });

  it('★冪等(発生源と境界の二重適用で文字列が変わらない)', () => {
    for (const s of [
      `401 provided: ${FAKE.openaiProj}`,
      `parse failed: ${v8Message(`{"legs":["${FAKE_EXIT_NOTE}",あ]}`)}`,
      '404 not found the model kimi-latest',
    ]) {
      const once = sanitizeErrorForOutput(s);
      expect(sanitizeErrorForOutput(once)).toBe(once);
    }
  });
});
