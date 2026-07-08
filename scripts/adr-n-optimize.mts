// ADR 窓幅 n の最適化バックテスト (2025-12 〜 現在の実DB)。
//
// 目的: forecastLoop の projHigh/projLow (= open ± adr) を「当日の実高安をどれだけ
// 当てるか」で評価し、最良の窓幅 n を実データで決める。live と同一の関数を流用:
//   computeADR(median up/down) / projectTargets / getSessionOHLC / isSessionComplete。
//
// ポイントイン時間: ターゲット・セッション T を予測するとき、T より前(openT < T.openT)
// の同種別(Day/Night)完了セッションのみで ADR を作る(未来リークなし)。
//
// adrUp/adrDown は「寄り→高安レンジ」の MEDIAN なので、校正が完璧なら未来でも
// 「実レンジ > 予測」が約 50% になるはず。よって評価は2軸:
//   (1) MAE  = 平均 |実レンジ - 予測レンジ| (pt)  … 50%分位の pinball/絶対誤差。小さいほど良
//   (2) 校正 = 実レンジ > 予測 となった割合。0.50 に近いほど良 (median の妥当性)
// あわせて「完全内包率」(実高<=projHigh かつ 実安>=projLow) も参考表示。

import { openDb, resolveDbPath, getSessionOHLC, type SessionOHLC } from '../server/db/store.js';
import { computeADR, projectTargets } from '../server/forecast.js';
import { isSessionComplete } from '../server/sessionOHLC.js';

const SYMBOL = 'NIY=F';
const MIN_SAMPLES = 5;            // これ未満の有効サンプルしか取れない n では予測を出さない(live と同じ閾値)
const FROM = Date.UTC(2025, 11, 1);   // 2025-12-01 以降に寄り付くセッションを評価対象に
const CANDS = [5, 7, 10, 12, 14, 16, 18, 20, 25, 30, 40, 50, 60];

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const db = openDb(resolveDbPath());
// 全セッションを新しい順で取得(getSessionOHLC は最大200日ぶんの bars を読む)。
const sessions = getSessionOHLC(db, SYMBOL, 1000);   // newest-first
console.log(`loaded ${sessions.length} sessions: ${sessions.at(-1)?.sessionDate} … ${sessions[0]?.sessionDate}`);

interface Row {
  n: number;
  cases: number;
  maeUp: number; maeDown: number; mae: number;
  calUp: number; calDown: number;     // 実レンジ>予測 の割合
  contain: number;                    // 完全内包率
  meanBandUp: number; meanBandDown: number;   // 平均予測幅(pt)
}

const out: Row[] = [];

for (const n of CANDS) {
  let cUp = 0, cDown = 0, cases = 0;
  let sumAbsUp = 0, sumAbsDown = 0;
  let exceedUp = 0, exceedDown = 0, contained = 0;
  let sumBandUp = 0, sumBandDown = 0;

  for (let i = 0; i < sessions.length; i++) {
    const T = sessions[i];
    if (T.openT < FROM) continue;
    if (!isSessionComplete(T)) continue;        // 寄り欠けセッションは実高安が不正確 → 評価対象外
    // T より前(=配列で後ろ)の同種別セッションだけで ADR。computeADR が complete & slice(0,n) を担当。
    const prior = sessions.slice(i + 1);
    const adr = computeADR(prior, n, T.session);
    if (adr.samples < MIN_SAMPLES) continue;
    const { projHigh, projLow } = projectTargets(T.open, adr);

    const realUp = T.high - T.open;
    const realDown = T.open - T.low;
    cases++;
    sumAbsUp += Math.abs(realUp - adr.adrUp);
    sumAbsDown += Math.abs(realDown - adr.adrDown);
    sumBandUp += adr.adrUp;
    sumBandDown += adr.adrDown;
    if (realUp > adr.adrUp) exceedUp++;
    if (realDown > adr.adrDown) exceedDown++;
    if (T.high <= projHigh && T.low >= projLow) contained++;
  }
  if (!cases) continue;
  out.push({
    n, cases,
    maeUp: sumAbsUp / cases, maeDown: sumAbsDown / cases,
    mae: (sumAbsUp + sumAbsDown) / cases / 2,
    calUp: exceedUp / cases, calDown: exceedDown / cases,
    contain: contained / cases,
    meanBandUp: sumBandUp / cases, meanBandDown: sumBandDown / cases,
  });
}

const f = (x: number, d = 1) => x.toFixed(d);
console.log('\n n | cases | MAEup | MAEdn | MAE  | calUp | calDn | 内包率 | bandUp | bandDn');
console.log('---+-------+-------+-------+------+-------+-------+--------+--------+-------');
for (const r of out) {
  console.log(
    `${String(r.n).padStart(2)} |  ${String(r.cases).padStart(4)} | ` +
    `${f(r.maeUp).padStart(5)} | ${f(r.maeDown).padStart(5)} | ${f(r.mae).padStart(4)} | ` +
    `${f(r.calUp, 2).padStart(5)} | ${f(r.calDown, 2).padStart(5)} | ` +
    `${f(r.contain * 100, 1).padStart(5)}% | ${f(r.meanBandUp).padStart(6)} | ${f(r.meanBandDown).padStart(6)}`,
  );
}

const bestMae = [...out].sort((a, b) => a.mae - b.mae)[0];
const bestCal = [...out].sort((a, b) =>
  (Math.abs(a.calUp - 0.5) + Math.abs(a.calDown - 0.5)) -
  (Math.abs(b.calUp - 0.5) + Math.abs(b.calDown - 0.5)))[0];
console.log(`\n最小MAE : n=${bestMae.n} (MAE=${f(bestMae.mae)}pt, 内包率=${f(bestMae.contain * 100, 1)}%)`);
console.log(`最良校正: n=${bestCal.n} (calUp=${f(bestCal.calUp, 2)}, calDn=${f(bestCal.calDown, 2)})`);
