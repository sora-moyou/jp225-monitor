import { apiUrl } from '../lib/apiBase.js';

interface StatusResponse {
  yahoo: { fallback: boolean; skipUntil: number };
  llm: Array<{ name: string; enabled: boolean; paused: boolean; pausedUntil: number }>;
  /** ★提案生成器(分析用)の台帳の死活。公開版(lite)や未導入の PC では返らない(=表示しない)。 */
  generatorLedger?: { available: boolean; lastRecordAt: number | null; ageMin: number | null; total: number };
}

/** 生成器が「止まった」と見なす無記録の分数。1サイクル=2分なので、数サイクル落ちても
 *  すぐ赤にはせず、明らかに止まっている領域で警告にする。 */
const GENERATOR_STALE_MIN = 15;

/** ★「生成器 最終記録 N分前」の1点表示(純関数)。
 *  1年かけて溜める実験の最悪の失敗形は「実は3か月動いていなかった」。生成器側だけの死活監視は
 *  生成器が死ぬと一緒に死ぬので、**ユーザーが毎日見る画面** に出す。
 *  台帳そのものが無い環境(未導入・公開版)では **何も出さない**(存在しない機構の警告を出さない)。 */
export function renderGeneratorDot(ledger: StatusResponse['generatorLedger']): string {
  if (!ledger || !ledger.available) return '';
  if (ledger.ageMin === null) {
    return renderDot('Ge', 'off', '提案生成器: 台帳はあるが記録が1件もありません');
  }
  const stale = ledger.ageMin >= GENERATOR_STALE_MIN;
  return renderDot('Ge', stale ? 'paused' : 'ok',
    `提案生成器: 最終記録 ${ledger.ageMin}分前 (通算 ${ledger.total} 件)`
    + (stale ? ' — ★止まっている可能性があります' : ''));
}

function fmtRemaining(target: number, now: number): string {
  const sec = Math.max(0, Math.round((target - now) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function fmtClock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function renderDot(label: string, state: 'ok' | 'paused' | 'off', tooltip: string): string {
  const emoji = state === 'ok' ? '🟢' : state === 'paused' ? '🟡' : '⚪';
  return `<span class="dot" title="${tooltip}">${emoji}<span class="label">${label}</span></span>`;
}

export async function refreshApiStatus(container: HTMLElement): Promise<void> {
  let data: StatusResponse;
  try {
    const res = await fetch(apiUrl('/api/status'));
    if (!res.ok) { container.textContent = ''; return; }
    data = await res.json() as StatusResponse;
  } catch {
    container.textContent = '';
    return;
  }
  const now = Date.now();
  const priceState: 'ok' | 'paused' = data.yahoo.fallback ? 'paused' : 'ok';
  const priceTip = data.yahoo.fallback
    ? `価格フィード (225225.jp HTTP): 取得失敗・リトライ中 (残${fmtRemaining(data.yahoo.skipUntil, now)} / ${fmtClock(data.yahoo.skipUntil)} 再試行) — 直近価格を保持 (stale)`
    : '価格フィード (225225.jp HTTP ajax_cme/ajax_fx): 利用可';
  const priceDot = renderDot('P', priceState, priceTip);
  const llm = data.llm.map(p => {
    const state: 'ok' | 'paused' | 'off' = !p.enabled ? 'off' : p.paused ? 'paused' : 'ok';
    const tooltip = !p.enabled
      ? `${p.name}: 未設定`
      : p.paused
        ? `${p.name}: 待機中 (残${fmtRemaining(p.pausedUntil, now)} / ${fmtClock(p.pausedUntil)} 復帰予定)`
        : `${p.name}: 利用可`;
    const labelShort = p.name === 'gemini' ? 'G' : p.name === 'groq' ? 'Gr' : 'O';
    return renderDot(labelShort, state, tooltip);
  }).join('');
  container.innerHTML = priceDot + llm + renderGeneratorDot(data.generatorLedger);
}

export function initApiStatusPane(container: HTMLElement, intervalMs: number = 5000): void {
  void refreshApiStatus(container);
  setInterval(() => { void refreshApiStatus(container); }, intervalMs);
}
