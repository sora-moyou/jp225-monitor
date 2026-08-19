// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  ②③ プロンプト A → B の連鎖 と、その記録
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ■ この検証台の目的(忘れるとすぐ制約を足したくなるので書いておく)
//   本番のプロンプトは 1 つの箱(rationale)に「LC幅の検算」「理由」「戦略ラベル」を同居させており、
//   実測で **根拠文の中央値 76 字のうち検算 76 字・理由 0 字**、98.1% が検算から書き始めていた。
//   ここは「1 プロンプト 1 仕事」に割ったら何が返るかを見る場所なので、
//   ★ユーザーが書いた質問文以外の制約(「必ず〜」「JSON で返せ」等)を **1 文字も足さない**。
//   足した瞬間にこの実験は何も測っていないことになる。
//
// ■ system プロンプト
//   本番の規則文(buildScalpSystemPrompt / strategySpec / JSON 契約 …)は **付けない**。
//   付けると測りたい制約がそのまま戻ってくる。system に載せるのは ① のデータ全文だけ
//   (本番も データは system 側に載せているので、置き場所は本番と同じ)。
//
// ■ A の答えを B に渡す(連鎖)
//   B は A の判断を踏まえて答える形にする。会話履歴として assistant 発話に A の全文を入れる。

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callWithFallback, isLLMEnabled } from '../llm/providers.js';
import { SCALP_STRATEGY_LABELS, scalpStrategyContract } from '../llm/scalpPlan.js';
import { buildLabContext, type ContextDiagnostics } from './context.js';
import { positionJsonContract, positionJsonContractSplit, productionLikeContract } from './jsonContract.js';
import { buildQuestionV8 } from './questionV8.js';
import { getSandbox, refreshSandbox } from './sandbox.js';

/** ★ユーザーが書いた質問文そのまま(1 文字も足さない・減らさない)。 */
// ★質問文 A の変遷。
//   v1(2026-08-19) 「…買い目線か、売り目線かを判断し、理由も添えてください。」= 二択。
//     → 7断面すべてでどちらかに倒し、「様子見」は 0 回。二択なので構造的にそうなる、という観察が出た。
//   v2(現行) 三択にする。レンジと答える断面が出るかを見る。
export const QUESTION_A = '与えられたデータより、今の相場は買い目線か、売り目線か、レンジ相場かを判断し、理由も添えてください。';
// ★質問文 B の変遷(記録として残す。どれで何が返ったかは scratchpad の実行記録を参照)。
//   v1(2026-08-19 04:03) 「…具体的な価格も含めた売買方法を提案して。価格の説明も加えてください。」
//     → 表形式でエントリー/TP1/TP2/LC。逆指値の脚なし。
//   v2(2026-08-19 04:05) 「…具体的なエントリー注文（指値注文/逆指値注文/TP/SL）を提案してください。…」
//     → 4つ聞いて **3つしか返らない**(売り指値・TP・SL。逆指値の脚が無い)。
//   v3(2026-08-19 04:11) TP を外す。理由: 本番の決済は phase-exit(コードが段階的に動かす)で AI に TP を
//     出させない。v2 のままだと **AI の固定 TP と phase-exit の2つの決済系が同じ建玉に乗る**。
//     → それでも逆指値の脚は返らず(指値1本)、しかも **聞いていない TP を勝手に書いてきた**。
//   v4(現行) 個数を明示し、脚ごとに SL を求める。v2(4項目)/v3(3項目) いずれでも片脚しか返らなかったので、
//     「項目が多くて落ちた」のではないことは確認済み。ここで返らなければ、自由文では2本組みが取れず
//     **フィールドを2つ用意する(構造で分ける)** 以外に道が無いことになる。
//   v5(現行) ラベルを **2つ** 選ばせ、合計4つの注文を出させる。7断面すべてが
//     「トレンド押し目・戻り」だったので、**2つ目に何が出るか** でアンカーの届く範囲を測る。
//     ★ユーザーの原文のまま(「ラベを」の表記も直さない)。
//   v6(2026-08-19) = v4 に戻す(ラベル1つ・指値と逆指値の2本)。節目なしの条件での測定に使用。
//   v7(現行) ★**設計の転換: AI にラベルを選ばせない**。
//     「現在価格より上/下を1つずつ」という **位置** で注文を求め、ラベル(買い/売り × 順張り/逆張り)は
//     返ってきた注文から **コード側で導出** する。よって **ラベル7語の一覧は添えない**。
//     ★ユーザーの原文のまま(句点が2つ続く「します。。」も、改行位置も直さない)。
//   ★v7 の本文は QUESTION_B_V4 として固定する。ニュースの関連度(formatNewsForChat)は
//     質問文とのバイグラム重なりで記事を選ぶので、質問文を変えると **渡すニュースまで変わる**。
//     pass6 系は「聞き方」だけを動かしたいので、ニュース選択には常にこの v4 本文を使う。
export const QUESTION_B_V4 = `現在価格より上の価格と下の価格一つづつを選び、それぞれに対して、エントリー注文を提案してください。
注文タイプは、逆指値注文または指値注文とします。。それぞれに、SLも提案し、価格の説明も加えてください。`;

export const QUESTION_B = QUESTION_B_V4;

/** 本番の戦略ラベル 7 語 + 語釈を、本番の契約文(SSOT)から抜き出す。
 *  ★ここでラベルや語釈を書き写さない(書き写すと本番が変わったときに黙ってズレる)。
 *  契約文の該当行は `    <ラベル> … <語釈>` の形。抜けなかったラベルは語だけを出す。 */
export function strategyLabelList(): { line: string; withGloss: number } {
  const contract = scalpStrategyContract();
  const glosses = new Map<string, string>();
  for (const raw of contract.split('\n')) {
    const m = /^\s{2,}(.+?) … (.+)$/.exec(raw);
    if (!m) continue;
    const label = m[1]!.trim();
    if (SCALP_STRATEGY_LABELS.includes(label)) glosses.set(label, m[2]!.trim());
  }
  const lines = SCALP_STRATEGY_LABELS.map(l => {
    const g = glosses.get(l);
    return g ? `  ${l} … ${g}` : `  ${l}`;
  });
  return { line: lines.join('\n'), withGloss: glosses.size };
}

/** B に実際に送る本文。
 *  ★v7 から **ラベル一覧を添えない**(AI に語を選ばせるのをやめ、注文からコード側で導出する)。
 *  strategyLabelList() は過去の記録を読み直すために残す(呼び出しはしない)。 */
/** B に実際に送る本文。
 *  ★LABTEST_B_MODE=json … v7 の本文の **後ろに** JSON 契約を足す(pass6a)。本文は1文字も変えない。
 *  strategyLabelList() は過去の記録を読み直すために残す(呼び出しはしない)。 */
export function buildPromptB(refPrice = 0): string {
  const mode = process.env.LABTEST_B_MODE ?? '';
  // pass8: ユーザー原文の v8(A の判断ごとに注文の型を指定・ストップ幅も提案させる)。散文で返させる。
  if (mode === 'v8') return buildQuestionV8();
  // pass7: 本番同型の契約。prod1line=「(1行・日本語)」入り / prodfree=「1行・」を落とした版。
  if (mode === 'prod1line' || mode === 'prodfree') {
    return `${QUESTION_B}

${productionLikeContract(refPrice, mode === 'prod1line')}`;
  }
  if (mode === 'json2') {
    return `${QUESTION_B}

${positionJsonContractSplit()}`;
  }
  if (mode === 'json') {
    return `${QUESTION_B}

${positionJsonContract()}`;
  }
  return QUESTION_B;
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface LegResult {
  /** 送った全文(role ごと・そのまま)。 */
  messages: ChatMessage[];
  /** 返ってきた全文(そのまま・整形しない)。失敗時は null。 */
  answer: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  ms: number;
  usage: { prompt?: number; completion?: number; total?: number } | null;
}

/** 固定ダミーのシグナル(★表示だけ。発注もDB書き込みも一切しない)。 */
export const DUMMY_SIGNAL = {
  note: 'これは固定のダミーです。発注も記録もしません。',
  direction: 'buy' as const,
  limitEntry: 0,
  stopLoss: 0,
  strategy: '(ダミー)',
};

export type SignalMode = 'dummy' | 'none';

export interface RunResult {
  at: number;
  atIso: string;
  /** ① AI に渡したデータの全文。 */
  data: string;
  diag: ContextDiagnostics;
  a: LegResult;
  b: LegResult;
  signalMode: SignalMode;
  signal: typeof DUMMY_SIGNAL | null;
  /** 種 DB の素性(どこの何を何時のものとして読んだか)。 */
  source: { srcDb: string; srcMtime: number; srcBytes: number };
  /** 記録の保存先。 */
  savedTo: string | null;
  /** B だけを投げ直した回は、その元になった記録のパス(通常の実行では未設定)。 */
  rerunOf?: string;
  systemPromptUsed: '本番の規則文は付けない(system にはデータ全文のみ)';
}

const MAX_TOKENS = 2000;
/** ★本番(buildScalpPlan)と同じ温度。プロンプトに足す制約ではなく、サンプリングの条件を揃えるだけ。 */
const TEMPERATURE = 0.4;

/** LLM を1回叩く。★キーが無い/全滅は **黙って空を返さず** 必ず error に理由を残す。 */
export async function callOnce(messages: ChatMessage[], label: string): Promise<LegResult> {
  const t0 = Date.now();
  const base: LegResult = { messages, answer: null, error: null, provider: null, model: null, ms: 0, usage: null };
  if (!isLLMEnabled()) {
    return { ...base, ms: 0, error: 'LLM のキーが未設定です(~/.jp225-monitor/config.json / .env のどちらにも有効なキーがありません)' };
  }
  let provider: string | null = null;
  let model: string | null = null;
  let usage: LegResult['usage'] = null;
  try {
    const text = await callWithFallback(async (p) => {
      const res = await p.client!.chat.completions.create({
        model: p.config.chatModel, temperature: TEMPERATURE, max_tokens: MAX_TOKENS,
        messages: messages as unknown as [],
      } as never) as unknown as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const out = res.choices?.[0]?.message?.content ?? '';
      provider = p.config.name;
      model = p.config.chatModel;
      usage = res.usage
        ? { prompt: res.usage.prompt_tokens, completion: res.usage.completion_tokens, total: res.usage.total_tokens }
        : null;
      return out;
    }, label);
    // ★プロバイダ不在時、callWithFallback は例外ではなく定型文を返す。黙って通さない。
    if (text.startsWith('(LLM disabled')) {
      return { ...base, ms: Date.now() - t0, error: `キー未設定: ${text}` };
    }
    if (text.trim() === '') {
      return { ...base, ms: Date.now() - t0, provider, model, usage, error: '返答が空でした(モデルが何も返さなかった)' };
    }
    return { messages, answer: text, error: null, provider, model, usage, ms: Date.now() - t0 };
  } catch (e) {
    return { ...base, ms: Date.now() - t0, provider, model, usage, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 記録の保存先(1 実行 1 ファイル・後で実行どうしを比べられる形)。 */
export function outDir(): string {
  return process.env.LABTEST_OUT ?? join(tmpdir(), 'jp225-labtest', 'runs');
}

function save(result: RunResult): string | null {
  try {
    const dir = outDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date(result.at).toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `run-${stamp}.json`);
    // ★保存先を **書き出す前に** 埋める(後から代入するとファイルの中だけ null が残り、
    //   記録を読み返したとき「保存できず」と嘘が表示される)。
    result.savedTo = file;
    writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
    return file;
  } catch (e) {
    console.warn('[labtest] 記録の保存に失敗:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** ★1 実行 = LLM 呼び出し 2 回(A と B)。ボタンを押した時だけ走る。 */
export async function runOnce(signalMode: SignalMode): Promise<RunResult> {
  // 種 DB を取り直す(稼働機の同期スナップショットは 30 分おきに更新されるため)。
  try { refreshSandbox(); } catch (e) { console.warn('[labtest] 砂箱の作り直しに失敗(前回のまま続行):', e instanceof Error ? e.message : String(e)); }

  const promptB = buildPromptB();
  // 本番はニュースの関連度に「その回の質問文」を使う。ラボは A と B の質問文を渡す。
  const { text: data, diag } = await buildLabContext(`${QUESTION_A}\n${promptB}`);

  const msgsA: ChatMessage[] = [
    { role: 'system', content: data },
    { role: 'user', content: QUESTION_A },
  ];
  const a = await callOnce(msgsA, 'labtest-A');

  const msgsB: ChatMessage[] = [
    { role: 'system', content: data },
    { role: 'user', content: QUESTION_A },
    { role: 'assistant', content: a.answer ?? '(A の返答が取れませんでした)' },
    { role: 'user', content: promptB },
  ];
  const b = await callOnce(msgsB, 'labtest-B');

  const sb = getSandbox();
  const at = Date.now();
  const result: RunResult = {
    at, atIso: new Date(at).toISOString(),
    data, diag, a, b,
    signalMode,
    signal: signalMode === 'dummy' ? DUMMY_SIGNAL : null,
    source: { srcDb: sb.srcDb, srcMtime: sb.srcMtime, srcBytes: sb.srcBytes },
    savedTo: null,
    systemPromptUsed: '本番の規則文は付けない(system にはデータ全文のみ)',
  };
  result.savedTo = save(result);
  return result;
}

/** 直近の実行記録のパス(無ければ null)。 */
export function newestRunFile(): string | null {
  try {
    const dir = outDir();
    const files = readdirSync(dir).filter(f => f.startsWith('run-') && f.endsWith('.json')).sort();
    const last = files[files.length - 1];
    return last ? join(dir, last) : null;
  } catch { return null; }
}

/** ★B だけを投げ直す(質問文 B を差し替えたときの比較用)。
 *  過去の実行記録から **データ全文と A の返答をそのまま流用** するので、
 *  変わるのは B の質問文だけ = 対比が清潔になる(そして LLM 呼び出しは 1 回で済む)。
 *  ★データはその記録が組まれた時刻のもの。新しく組み直さない(組み直すと市況が動いて対比が汚れる)。 */
export async function rerunB(prevFile: string): Promise<RunResult> {
  const prev = JSON.parse(readFileSync(prevFile, 'utf8')) as RunResult;
  const promptB = buildPromptB();
  const msgsB: ChatMessage[] = [
    { role: 'system', content: prev.data },
    { role: 'user', content: QUESTION_A },
    { role: 'assistant', content: prev.a.answer ?? '(A の返答が取れませんでした)' },
    { role: 'user', content: promptB },
  ];
  const b = await callOnce(msgsB, 'labtest-B-rerun');
  const at = Date.now();
  const result: RunResult = {
    ...prev, at, atIso: new Date(at).toISOString(), b, savedTo: null,
    rerunOf: prevFile,
  };
  result.savedTo = save(result);
  return result;
}
