import { openDb, resolveDbPath, getSessionOHLC } from '../server/db/store.js';
import { computeADR, projectTargets } from '../server/forecast.js';

const SYMBOL = 'NIY=F';
const N = 20;

const db = openDb(resolveDbPath());
const sessions = getSessionOHLC(db, SYMBOL, N + 6);
const days = sessions.filter(s => s.session === 'Day');

console.log('=== 直近 Day セッション(新しい順) ===');
for (const s of days.slice(0, N + 3)) {
  console.log(`${s.sessionDate}  open=${s.open}  high=${s.high}  high-open=${(s.high - s.open).toFixed(1)}`);
}

const adr = computeADR(sessions, N, 'Day');
console.log('\nadrUp(Day, median high-open) =', adr.adrUp, ' samples=', adr.samples);

// 6/15 Day 実測 open=68310 にこの式を当てると
const OPEN_0615 = 68310;
const t = projectTargets(OPEN_0615, adr);
console.log('\n6/15 Day open=68310 に同じ式を当てると:');
console.log('projHigh = 68310 +', adr.adrUp, '=', t.projHigh);
console.log('実測 high=69845 (high-open=1535) → 投影上限を大きく超過');

db.close();
