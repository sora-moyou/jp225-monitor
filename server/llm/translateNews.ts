// server/llm/translateNews.ts — ニュース見出しの一括翻訳。
//
// ★なぜ「1件ずつ」ではなく「まとめて」訳すのか(重要):
//   翻訳は default プール(explain / chat / **scalp-plan** と同じプール)を使う。プロバイダごとの
//   サーキットブレーカーはプール単位で共有されているので、1回の取得で英語記事 40 件を
//   40 リクエストに分けて投げると、無料枠の RPM 制限(groq 30/min 等)を叩いて **429 でブレーカーが開き、
//   その巻き添えで scalp-plan(取引の判断)まで止まる**。翻訳は表示の便宜であって、
//   取引の可用性を削ってよい機能ではない。だから 1 リクエストにまとめ、上限も掛ける。
//
// ★行のズレは「誤訳」より重い:
//   番号がずれると **別の記事の訳が別の見出しに付く**。それは間違った情報を正しい顔で出すことなので、
//   1件でも整合しなければ **バッチ丸ごと捨てる**(原文表示にフォールバック)。部分採用はしない。

import { callWithFallback } from './providers.js';

/** 1リクエストに詰める見出し数。
 *  ★実測で 12 件は失敗した: 出力が max_tokens で切れて 8 行しか返らず、8 行目は文の途中で
 *    途切れていた(gemini-flash 実呼び出し)。日本語は 1 文字あたり 3 トークン前後を食うので、
 *    「英語見出し 12 本ぶんの訳」は 1200 トークンに収まらない。8 件 + 大きめの上限に改めた。 */
export const TRANSLATE_BATCH_SIZE = 8;
/** 出力の上限。8 件 × 約45字 × 約3tok/字 ≒ 1100tok に対して 3 倍近い余裕を取る。 */
export const TRANSLATE_MAX_TOKENS = 3000;
/** ★1回の取得で訳す上限(費用の歯止め)。新規英語記事が急増しても青天井にしない。 */
export const TRANSLATE_MAX_PER_FETCH = 24;

export const TRANSLATE_SYSTEM_PROMPT =
  '英文ニュース見出しを日本語に訳すアシスタント。入力は「N. 原文」の番号付き行。'
  + '**入力と同じ番号・同じ順序・同じ行数**で「N. 訳文」だけを返す。'
  + '見出しなので主語の省略可・簡潔に・改行なし。説明や前置き、空行、原文の再掲は書かない。';

/** 番号付きの入力を作る(純関数)。 */
export function buildTranslationPrompt(titles: readonly string[]): string {
  return titles.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ').trim()}`).join('\n');
}

/**
 * LLM の返答を訳文配列へ。★1件でも整合しなければ null(=バッチ破棄)。純関数。
 * 受け入れる形は「N. 訳文」または「N) 訳文」「N: 訳文」。番号は 1..count が昇順で過不足なく揃うこと。
 */
export function parseTranslationBatch(text: string, count: number): string[] | null {
  if (count <= 0) return null;
  const out = new Array<string>(count);
  let seen = 0;
  for (const raw of text.split('\n')) {
    const m = /^\s*(\d+)\s*[.):：、]\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;                       // 前置き等の余分な行は読み飛ばす
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 1 || idx > count) return null;   // 範囲外=信用しない
    if (out[idx - 1] !== undefined) return null;                          // 同じ番号が2回=信用しない
    out[idx - 1] = m[2]!;
    seen++;
  }
  if (seen !== count) return null;          // 過不足=丸ごと捨てる
  for (const v of out) if (!v || v.trim() === '') return null;
  return out;
}

/**
 * ★callWithFallback は「キー未設定」のとき **例外ではなく案内文を返す**(既存仕様)。
 *   それをそのまま訳文として保存すると、全見出しが案内文に化ける = 最悪の無言の失敗。
 *   ここで必ず弾く。
 */
export function looksLikeProviderNotice(text: string): boolean {
  return text.trim().startsWith('(LLM disabled') || text.includes('APIキーが未設定');
}

/** LLM 呼び出しの差し替え口(テストで実呼び出しをせずに検証するため)。 */
export type BatchCaller = (prompt: string) => Promise<string>;

/** 出力が長さ上限で切れたときの目印。★これを他のエラーと混ぜない:
 *  429/キー無効は「叩き続けるとブレーカーが深く開く」ので即中断すべきだが、
 *  長さ切れは **そのバッチ固有** なので、次のバッチまで巻き添えで止める理由がない。 */
export const TRUNCATED_MARK = 'truncated:';
export function isSoftBatchError(msg: string): boolean {
  return msg.startsWith(TRUNCATED_MARK);
}

const defaultCaller: BatchCaller = (prompt) => callWithFallback(async (p) => {
  const completion = await p.client!.chat.completions.create({
    model: p.config.model,          // プール順は gemini→groq→kimi→openai = 無料/安い順(既存の並び)
    temperature: 0.1,
    max_tokens: TRANSLATE_MAX_TOKENS,
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });
  const choice = completion.choices[0];
  // ★切れた出力を「短い正常な返答」として扱わない。行数が合わないだけで捨ててはいるが、
  //   理由が分からないと同じ事故を何度でも踏む(実際にこれで 12→8 件に切れていた)。
  if (choice?.finish_reason === 'length') {
    throw new Error(`${TRUNCATED_MARK} 出力が長さ上限(${TRANSLATE_MAX_TOKENS})で切れました`);
  }
  return choice?.message?.content?.trim() ?? '';
}, 'translate-news');

/**
 * 見出し配列を訳す。戻り値は入力と同じ長さで、訳せなかった要素は null。
 * ★例外を投げない(呼び出し側の取得ループを絶対に止めないため)。
 */
export async function translateTitles(
  titles: readonly string[],
  call: BatchCaller = defaultCaller,
): Promise<{ results: (string | null)[]; error: string | null }> {
  const results = new Array<string | null>(titles.length).fill(null);
  if (titles.length === 0) return { results, error: null };
  let firstError: string | null = null;

  for (let start = 0; start < titles.length; start += TRANSLATE_BATCH_SIZE) {
    const chunk = titles.slice(start, start + TRANSLATE_BATCH_SIZE);
    try {
      const text = await call(buildTranslationPrompt(chunk));
      if (looksLikeProviderNotice(text)) {
        firstError ??= 'LLM未設定';
        continue;   // 案内文を訳文として保存しない
      }
      const parsed = parseTranslationBatch(text, chunk.length);
      if (!parsed) {
        firstError ??= '訳文の行がずれた';
        continue;   // ★部分採用しない
      }
      for (let i = 0; i < chunk.length; i++) results[start + i] = parsed[i]!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      firstError ??= msg.slice(0, 120);
      // 長さ切れはそのバッチ固有なので次へ進む。それ以外(429/キー無効)はまとめて起きるので、
      // 叩き続けるとブレーカーを深く開く = 取引側(scalp-plan)を巻き添えにするため即中断。
      if (isSoftBatchError(msg)) continue;
      break;
    }
  }
  return { results, error: firstError };
}
