interface StatusResponse {
  yahoo: { fallback: boolean; skipUntil: number };
  llm: Array<{ name: string; enabled: boolean; paused: boolean; pausedUntil: number }>;
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
    const res = await fetch('/api/status');
    if (!res.ok) { container.textContent = ''; return; }
    data = await res.json() as StatusResponse;
  } catch {
    container.textContent = '';
    return;
  }
  const now = Date.now();
  const yahooState: 'ok' | 'paused' = data.yahoo.fallback ? 'paused' : 'ok';
  const yahooTip = data.yahoo.fallback
    ? `Yahoo: fallback中 (残${fmtRemaining(data.yahoo.skipUntil, now)} / ${fmtClock(data.yahoo.skipUntil)} 復帰予定)`
    : 'Yahoo: 利用可';
  const yahoo = renderDot('Y', yahooState, yahooTip);
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
  container.innerHTML = yahoo + llm;
}

export function initApiStatusPane(container: HTMLElement, intervalMs: number = 5000): void {
  void refreshApiStatus(container);
  setInterval(() => { void refreshApiStatus(container); }, intervalMs);
}
