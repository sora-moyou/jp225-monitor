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

import { callWithFallback, UnusableResponseError } from './providers.js';

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
/** 200 で返ったのに本文が空だったときの目印。 */
export const EMPTY_MARK = 'empty:';
export function isSoftBatchError(msg: string): boolean {
  return msg.startsWith(TRUNCATED_MARK);
}

// ─── temperature の扱い ────────────────────────────────────────────────────
//
// ★事故(2026-08-10): Kimi のモデルを kimi-k3 にした途端、翻訳が
//   `400 invalid temperature: only 1 is allowed for this model` で全滅した(430件)。
//   temperature を **既定値以外に指定できないモデル** が存在する。
//
// ★方針: 「一律に外す」でも「モデル名の表を持つ」でもなく、**拒否されたモデルだけ外す**。
//   - 一律に外すと、受け付けるモデル(gemini/groq/openai)まで既定 temperature(≒1.0)になる。
//     翻訳は決定的であってほしいうえ、この処理の出力は「N. 訳文」という **形式の縛りが本体** で、
//     ばらつくと行がずれて **バッチ丸ごと破棄**(=訳が付かない)に直結する。品質を捨てる理由がない。
//   - モデル名の表は、モデルが差し替わるたびに黙って古くなる(kimi-latest → kimi-k3 で実際に起きた)。
//   - だから **実際に拒否されたときだけ** temperature を落として同じ要求をもう一度出し、
//     そのモデル名を記憶して以後は最初から付けない(無駄な往復は初回の1回だけ)。
/** 翻訳の temperature。低いほど訳文と **行の形式** がぶれない。 */
export const TRANSLATE_TEMPERATURE = 0.1;

export type TranslateMessage = { role: 'system'; content: string } | { role: 'user'; content: string };
export interface TranslateParams {
  model: string;
  max_tokens: number;
  temperature?: number;
  messages: TranslateMessage[];
}
export interface TranslateResponse {
  choices?: ReadonlyArray<{ finish_reason?: string | null; message?: { content?: string | null } | null } | null | undefined> | null;
}
/** chat.completions.create の差し替え口(実クライアントも偽サーバも同じ形で渡せる)。 */
export type CompletionFn = (params: TranslateParams) => Promise<TranslateResponse>;

/** temperature を受け付けないと判明したモデル(プロセス内の記憶)。 */
const noTemperatureModels = new Set<string>();
/** テスト用: 記憶を消す。 */
export function resetTemperatureMemoForTest(): void { noTemperatureModels.clear(); }
/** そのモデルは temperature を付けずに呼ぶことになっているか(診断/テスト用)。 */
export function modelSkipsTemperature(model: string): boolean { return noTemperatureModels.has(model); }

/** 「temperature が受け付けられない」ことを示すエラー文か(純関数)。
 *  ★狭く判定する: `temperature` の語が出ていて、かつ「不正/非対応/この値しか許されない」と
 *    言っている場合だけ。429 や 413 を横取りしないよう、語の共起を必須にしている。 */
export function isTemperatureRejection(msg: string): boolean {
  if (!/temperature/i.test(msg)) return false;
  return /invalid|unsupported|not support|not allowed|is allowed|must be|cannot|unexpected|unrecognized|only/i.test(msg);
}

/**
 * 応答から訳文本文を取り出す。
 *
 * ★「使えない応答」は必ず **UnusableResponseError** で投げる = callWithFallback が次のプロバイダへ回す。
 *   ここが 400 の隣にあった同型の穴だった(2026-08-11):
 *     - `truncated:` は素の Error だったので classifyLLMError=null → **即 throw**(次を試さない)。
 *     - 本文が空のときは `''` を返しており、**空応答が成功として記録**されていた
 *       (recordSuccess で circuit reset まで走る = 事故が計測にも残らない)。
 *   実測(Kimi): temperature を外すと 200 で返るが中身が空。片方だけ直しても症状は消えない。
 *
 * ★`TRANSLATE_MAX_TOKENS=3000` は安全域ではない: 実測で 1 文あたり思考込み 554〜647 字を出すモデルがあり、
 *   8 見出し/リクエストなら 3000 に到達しうる。モデルを選び直しても踏む穴なので、
 *   「切れたら次のプロバイダ」を経路として持っておく。
 */
function readTranslationChoice(completion: TranslateResponse): string {
  const choice = completion.choices?.[0];
  const content = choice?.message?.content?.trim() ?? '';
  // ★切れた出力を「短い正常な返答」として扱わない。行数が合わないだけで捨ててはいるが、
  //   理由が分からないと同じ事故を何度でも踏む(実際にこれで 12→8 件に切れていた)。
  if (choice?.finish_reason === 'length') {
    throw new UnusableResponseError(
      `${TRUNCATED_MARK} 出力が長さ上限(${TRANSLATE_MAX_TOKENS})で切れました(本文${content.length}字)`);
  }
  // ★空を成功にしない。空文字を返すと parseTranslationBatch が null を返して
  //   「訳文の行がずれた」という **嘘の理由** が記録され、しかもプロバイダは成功扱いになる。
  if (content === '') {
    throw new UnusableResponseError(
      `${EMPTY_MARK} 応答が空でした(finish_reason=${choice?.finish_reason ?? '-'})`);
  }
  return content;
}

/**
 * 1バッチぶんの翻訳要求を出す。temperature を拒否されたら **そのモデルだけ** 外して1回だけ出し直す。
 * ★出し直しは 1 回きり(拒否メッセージのときだけ)。それ以外の失敗は素通しで投げ直し、
 *   従来どおり callWithFallback のフォールバック判定に委ねる。
 */
export async function runTranslationCompletion(
  create: CompletionFn, model: string, prompt: string,
): Promise<string> {
  const base: TranslateParams = {
    model,
    max_tokens: TRANSLATE_MAX_TOKENS,
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  };
  const useTemp = !noTemperatureModels.has(model);
  try {
    return readTranslationChoice(await create(useTemp ? { ...base, temperature: TRANSLATE_TEMPERATURE } : base));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!useTemp || !isTemperatureRejection(msg)) throw err;
    noTemperatureModels.add(model);
    console.warn(`[newsTranslate] ${model} は temperature を受け付けません → 以後 temperature 無しで訳します (${msg.slice(0, 120)})`);
    return readTranslationChoice(await create(base));
  }
}

const defaultCaller: BatchCaller = (prompt) => callWithFallback(
  // プール順は gemini→groq→kimi→openai = 無料/安い順(既存の並び)
  (p) => runTranslationCompletion((params) => p.client!.chat.completions.create(params), p.config.model, prompt),
  'translate-news',
);

// ─── ★失敗の帰属(2026-08-11) ────────────────────────────────────────────────
//
// 「その記事が訳せない」と「LLM の連鎖が落ちている」は **まったく別の事実**なのに、
// 以前はどちらも同じ `translate_error` として記録し、再訳の回数を消費していた。
// その結果、プロバイダ側の障害が続くと窓の中の記事が全部 4 回で焼き切れ、
// **救済機能そのものが恒久的に失われる**(実 SQLite で再現済み)。
//
//   'provider' … 連鎖が全滅した / 応答が空 / 長さ切れ / キー未設定 / そもそも試していない。
//                その記事について何も分かっていない ⇒ **回数を消費しない**(次のパスでまた試す)。
//   'item'     … プロバイダは健全に答えた(200・非空・非切れ)のに、**その行の訳が使えなかった**。
//                = その記事に固有の理由 ⇒ 回数を消費し、上限で打ち止める。
export type TranslateFailureKind = 'provider' | 'item';

export interface TranslateTitlesResult {
  /** 入力と同じ長さ。訳せなかった要素は null。 */
  results: (string | null)[];
  /** 入力と同じ長さ。訳せた要素は null、失敗した要素はその帰属。 */
  failures: (TranslateFailureKind | null)[];
  /** 最初に起きた失敗の理由(表示・ログ用)。 */
  error: string | null;
}

/**
 * 見出し配列を訳す。
 * ★例外を投げない(呼び出し側の取得ループを絶対に止めないため)。
 */
export async function translateTitles(
  titles: readonly string[],
  call: BatchCaller = defaultCaller,
): Promise<TranslateTitlesResult> {
  const results = new Array<string | null>(titles.length).fill(null);
  // ★既定は 'provider'。**試していない要素**(break で残ったぶん)がここに残るので、
  //   「1回の呼び出し失敗で最大24件が一斉に回数消費」という増幅がそもそも起きない。
  const failures = new Array<TranslateFailureKind | null>(titles.length).fill('provider');
  if (titles.length === 0) return { results, failures, error: null };
  let firstError: string | null = null;

  for (let start = 0; start < titles.length; start += TRANSLATE_BATCH_SIZE) {
    const chunk = titles.slice(start, start + TRANSLATE_BATCH_SIZE);
    try {
      const text = await call(buildTranslationPrompt(chunk));
      if (looksLikeProviderNotice(text)) {
        firstError ??= 'LLM未設定';
        continue;   // 案内文を訳文として保存しない(帰属は provider のまま)
      }
      const parsed = parseTranslationBatch(text, chunk.length);
      if (!parsed) {
        // ★プロバイダは健全に答えている(200・非空・非切れ)。使えなかったのは **この見出しの並びに対する訳**。
        //   だから 'item' に帰属させ、回数を消費させる(でないと同じ見出しを無限に叩き続ける)。
        firstError ??= '訳文の行がずれた';
        for (let i = 0; i < chunk.length; i++) failures[start + i] = 'item';
        continue;   // ★部分採用しない
      }
      for (let i = 0; i < chunk.length; i++) {
        results[start + i] = parsed[i]!;
        failures[start + i] = null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      firstError ??= msg.slice(0, 120);
      // ★ここへ来た時点で **全プロバイダが駄目だった**(空/長さ切れ/400 等は callWithFallback が
      //   既に次を試している)。よって帰属は 'provider' のまま = 回数を消費しない。
      // 長さ切れはそのバッチ固有(見出しが長い)なので次のバッチへ進む。
      // それ以外(429/キー無効/空)はまとめて起きるので、叩き続けるとブレーカーを深く開く
      // = 取引側(scalp-plan)を巻き添えにするため即中断。
      if (isSoftBatchError(msg)) continue;
      break;
    }
  }
  return { results, failures, error: firstError };
}
