// オフライン再生(別プロセス)。**取引しない・ライブ経路に一切関わらない**。
//
//   npm run replay:dev
//
// 記録済みの提案(generator_proposals.db)と保管ティック(ticks_archive.db)から、
// 影の決済30通りを再生して shadow_exits.db に記録する。
//
// ■ ★入力は必ず readOnly(生成器/価格ループが書いている最中に読む可能性がある)
// ■ ★冪等・再開可能(追記のみ): 何度走らせても記録は増えない。取引日ごとに完了印を残す。
// ■ ★覆えなかった範囲は必ず出す(何件・なぜ)。無音の失敗は欠陥。
//
// 環境変数(既定は本番の解決関数に従う):
//   JP225_GENERATOR_DB / JP225_TICK_ARCHIVE_DB / JP225_SHADOW_DB … 各DBのパス
//   REPLAY_MAX_DAYS  … 1回の実行で再生する取引日の上限(既定=無制限)
//   REPLAY_ONLY_DAY  … その取引日だけ再生(検証用)
//   REPLAY_FORCE=1   … ★完了印を無視して **本当に再計算して置き換える**。行数は増えない
//                      (一意鍵が同じなら1行のまま)が、中身は新しい計算結果で上書きされる。
//                      何行を上書きし、そのうち何行の結末が変わったかを必ず出す
//                      (「新規0件」だけを出して成功に見せない)。

import { isAnalysisEnabled } from '../analysisGate.js';
import { resolveGeneratorDbPath } from '../db/generatorStore.js';
import { resolveTickArchiveDbPath, ARCHIVED_SYMBOLS } from '../db/tickArchive.js';
import { openShadowDb, resolveShadowDbPath, readShadowLadderMeta } from '../db/shadowStore.js';
import { loadExitImpl, getShadowExitLadder } from '../signalTrade/exit/index.js';
import { openReadOnly, countProposalsByDirection } from './source.js';
import { runReplay, type ReplayDeps } from './replay.js';
import { coverageTotals } from './store.js';

const log = (m: string): void => console.log(`[replay] ${m}`);

function posInt(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

async function main(): Promise<void> {
  if (!isAnalysisEnabled()) {
    console.error('[replay] ★走りません: このビルドは分析用の経路を持ちません(公開版 lite) — server/analysisGate.ts');
    process.exitCode = 1;
    return;
  }
  // ★決済の実装は **import して関数として呼ぶ**(非公開ファイルをテキスト走査しない)。
  const impl = await loadExitImpl();
  const ladder = getShadowExitLadder();
  if (impl !== 'private' || ladder.specs.length === 0) {
    console.error(`[replay] ★走りません: 決済実装=${impl} / 影の仕様=${ladder.specs.length}件。`
      + '非公開の決済ラダーが読み込めていないので、再生しても意味のある記録は作れません');
    process.exitCode = 1;
    return;
  }
  log(`決済実装=${impl} 影ラダー epoch=${ladder.epoch} 仕様=${ladder.specs.length}件`);

  const genPath = resolveGeneratorDbPath();
  const tickPath = resolveTickArchiveDbPath();
  const shadowPath = resolveShadowDbPath();
  log(`提案(readOnly) ${genPath}`);
  log(`ティック(readOnly) ${tickPath}`);
  log(`影の記録 ${shadowPath}`);

  const gen = openReadOnly(genPath);
  const ticks = openReadOnly(tickPath);
  const shadow = openShadowDb(shadowPath);
  try {
    const dep: ReplayDeps = {
      gen, ticks, shadow,
      symbol: ARCHIVED_SYMBOLS[0]!,
      now: Date.now,
      log,
    };
    const started = Date.now();
    // ★母数を先に出す(「影が少ない」の答え合わせは母数から始まる)。
    log(`台帳の提案: ${countProposalsByDirection(gen).map(d => `${d.direction}=${d.n}`).join(' ') || '(0件)'}`);
    const res = runReplay(dep, {
      maxDays: posInt(process.env.REPLAY_MAX_DAYS),
      onlyDay: process.env.REPLAY_ONLY_DAY?.trim() || undefined,
      force: process.env.REPLAY_FORCE === '1',
    });
    for (const d of res.days) {
      if (d.skipped) continue;
      const cov = d.coverage.map(c => `${c.reason}=${c.n}`).join(' ');
      // ★force のときは「新規0件」で終わらせない。上書きした数と、そのうち結末が変わった数を必ず出す。
      const forced = d.replaced === undefined ? ''
        : ` 上書き${d.replaced}(★結末が変わった行=${d.changed} / 覆域の件数が変わった行=${d.coverageChanged})`;
      log(`${d.sessionDate} 提案=${d.proposals} 影を開いた提案=${d.opened} 行=${d.rows}(新規${d.inserted})${forced} `
        + `tick=${d.ticks} | ${cov || '(なし)'}`);
    }
    // ★覆えなかった範囲を必ず出す。
    if (res.pendingDays.length > 0) {
      log(`まだ再生しない取引日 ${res.pendingDays.length}件(地平ぶんのティックが出揃っていない): `
        + res.pendingDays.slice(0, 10).join(' ') + (res.pendingDays.length > 10 ? ' …' : ''));
    }
    if (res.withoutSessionDate > 0) {
      // ★台帳の session_date は要求時刻から付く。武装時刻(応答時刻)が取引日に入るものは上の日で覆われて
      //   いるので、これは「取引日の列が空の提案の数」であって、そのまま欠測件数ではない。
      log(`台帳の取引日が空の提案 ${res.withoutSessionDate}件(武装時刻が取引日に入るものは上の日で覆われている)`);
    }
    const totals = coverageTotals(shadow, res.ladderEpoch);
    log(`覆域(この影ラダーの版の累計): ${totals.map(t => `${t.reason}=${t.n}`).join(' ') || '(なし)'}`);
    const variantSpecs = readShadowLadderMeta(shadow, ladder.epoch);
    log(`変種↔spec の対応: ${variantSpecs ? JSON.stringify(variantSpecs) : '(未記録)'}`);
    log(`完了 ${res.days.filter(d => !d.skipped).length}日 / ${Math.round((Date.now() - started) / 1000)}秒`);
  } finally {
    for (const db of [gen, ticks, shadow]) { try { db.close(); } catch { /* close 失敗は無視 */ } }
  }
}

main().catch((e) => {
  console.error('[replay] 異常終了:', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
