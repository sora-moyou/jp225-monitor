import type { Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { getYahooStatus } from '../loops/priceLoop.js';
import { getProviderStatus } from '../llm/openai.js';
import { generatorGateSnapshot, generatorArmUsage } from '../llm/generatorGate.js';
import { loadExitImpl } from '../signalTrade/exit/index.js';
import { exitVariantImplKindAll, type ExitImplKind } from '../signalTrade/exitVariantImpl.js';
import { exitConfigHash, lookupExitConfigVersion } from '../signalTrade/exitConfigVersion.js';
import { openDb, resolveDbPath } from '../db/store.js';
import { readGeneratorLedgerStatus, resolveGeneratorDbPath } from '../db/generatorStore.js';
import { isAnalysisEnabled } from '../analysisGate.js';

// ─── ★決済実装の「実態」を外から観測できるようにする ────────────────────────
//
// 別プロセス(提案生成器)は monitor の中で決済仕様がどう解決されたかを知る手段が無かった。
// private が不在なら 'candidate-a' のプロンプトは公開フォールバック(数値なし)になり、
// 2本の生成器がほぼ同じ質問を投げる=実験は何も測っていないのに、記録には
// 「候補仕様で生成した」と残る。**測れていないことを外から確かめられる** ようにする。
//
// ★出すのは種別・版番号・一方向ハッシュだけ。決済の実数値は絶対に出さない
//   (hash は既に DB / 書き出し CSV に載っているのと同じ粒度)。

interface ExitStatus {
  /** 決済逆指値の実装種別。'private'=非公開実装 / 'fallback'=公開フォールバック(初期LC固定)。 */
  impl: ExitImplKind;
  /** ★変種(candidate-*)の説明文の実装種別。'fallback' なら変種は現行と実質同一 = 実験が測れていない。 */
  variantImpl: ExitImplKind;
  /** 決済設定の版(DB 台帳の採番。まだ一度も決済していなければ null)。 */
  configVersion: number | null;
  /** 決済設定の指紋(16桁hex・一方向)。 */
  configHash: string;
}

// 版は台帳を **読むだけ** で解決する(表示のために採番しない)。解決できたら以後は固定
// (指紋は起動中に変わらないため)。未採番のうちは毎回引くと DB を開き続けるので間隔を空ける。
const VERSION_RETRY_MS = 60_000;
let cachedVersion: number | null = null;
let lastVersionTry = 0;

function resolveConfigVersion(hash: string, now: number): number | null {
  if (cachedVersion !== null) return cachedVersion;
  if (lastVersionTry !== 0 && now - lastVersionTry < VERSION_RETRY_MS) return null;
  lastVersionTry = now;
  let db: DatabaseSync | null = null;
  try {
    db = openDb(resolveDbPath());
    cachedVersion = lookupExitConfigVersion(db, hash);
    return cachedVersion;
  } catch {
    return null;   // DB が開けない環境でも /api/status は落とさない(診断表示のため)。
  } finally {
    try { db?.close(); } catch { /* close 失敗は無視 */ }
  }
}

/** テスト用: 版キャッシュを捨てる。 */
export function _resetExitStatusCacheForTest(): void { cachedVersion = null; lastVersionTry = 0; }

/** 決済実装の実態(数値なし)。loadExitImpl は冪等なので、まだ走っていなければここで走る。
 *  ★診断表示なので、ここで例外を出して /api/status ごと 500 にしない
 *   (状態を見に来た画面が「サーバが死んでいる」ように見えるのが一番困る)。 */
export async function exitStatus(now: number = Date.now()): Promise<ExitStatus | { error: string }> {
  try {
    const kind = await loadExitImpl();
    const hash = exitConfigHash();
    return {
      impl: kind === 'private' ? 'private' : 'fallback',
      variantImpl: exitVariantImplKindAll(),
      configVersion: resolveConfigVersion(hash, now),
      configHash: hash,
    };
  } catch (e) {
    // 失敗を無音にしない: 「観測できなかった」ことを応答に残す(決済の数値は載らない)。
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[status] 決済実装の観測に失敗:', msg);
    return { error: 'exit-status-unavailable' };
  }
}

/** 提案生成器の台帳の死活(最終記録が何分前か)。**表示専用**なので、ここで例外を出して
 *  /api/status ごと 500 にしない(状態を見に来た画面が「サーバが死んでいる」ように見えるのが一番困る)。
 *  台帳が無い環境では available:false = 「この PC では一度も動いていない」を素直に返す。 */
function readGeneratorLedger(): ReturnType<typeof readGeneratorLedgerStatus> {
  try {
    return readGeneratorLedgerStatus(resolveGeneratorDbPath(), Date.now());
  } catch (e) {
    console.warn('[status] 生成器の台帳を読めません:', e instanceof Error ? e.message : String(e));
    return { available: false, lastRecordAt: null, ageMin: null, today: [], total: 0 };
  }
}

export async function statusHandler(_req: Request, res: Response): Promise<void> {
  // ★公開版(lite)は提案生成器を持たない=その状況を返しても意味が無い(存在しない機構の
  //   予算・従属停止・腕別消費が並ぶだけ)。**唯一のゲート** で丸ごと落とす。
  //   full では isAnalysisEnabled()===true なので従来と同じ全フィールドが返る(byte 不変)。
  const generator = isAnalysisEnabled()
    // ★提案生成器の予算/従属停止/backpressure の状況。
    //   「飛ばしたことを必ず記録する」= ログだけでなく画面/HTTP からも見えるようにする。API キーは含まない。
    //   ★予算は **腕ごと** に独立しているので、腕別の消費も出す(合計だけでは
    //     どの腕が枯れかけているか読めない)。回数のみでキーも決済値も含まない。
    // ★「1年後に、実は3か月動いていなかった」が最悪の失敗形。生成器側だけの死活監視は
    //   生成器が死んだら一緒に死ぬので、**ユーザーが見る画面** が読む /api/status に出す。
    //   専用DBを **readOnly** で読むだけ(台帳を作らない・書かない・例外を投げない)。
    ? {
      generator: generatorGateSnapshot(),
      generatorArms: generatorArmUsage(),
      generatorLedger: readGeneratorLedger(),
    }
    : {};
  res.json({
    yahoo: getYahooStatus(),
    // ★既存フィールドは不変: llm は従来どおり **default プール**(実弾につながる経路)の状態。
    llm: getProviderStatus(),
    ...generator,
    // ★追加(additive): 決済実装の実態(種別・版・指紋)。実数値は含まない。
    exit: await exitStatus(),
  });
}
