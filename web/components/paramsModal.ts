import { apiUrl } from '../lib/apiBase.js';

// 詳細パラメータ (定期ポーリング / アラートクールダウン等)。設定モーダルとは別の専用モーダル。
// 値は /api/settings から取得し、変更分だけ /api/settings/keys に POST する。
// 将来パラメータを追加するときは PARAMS 配列に1行足すだけでよい。

interface ParamSpec { key: string; inputId: string; }

const PARAMS: ParamSpec[] = [
  { key: 'pricePollMs', inputId: 'params-price-poll' },
  { key: 'newsPollMs',  inputId: 'params-news-poll' },
  { key: 'port',        inputId: 'params-port' },
  { key: 'cooldownMin', inputId: 'params-cooldown-min' },
  { key: 'shock1Yen',         inputId: 'params-shock1' },
  { key: 'shock2Yen',         inputId: 'params-shock2' },
  { key: 'shockAccelYen',     inputId: 'params-shock-accel' },
  { key: 'shockMove1Yen',     inputId: 'params-shock-move1' },
  { key: 'shockMove2Yen',     inputId: 'params-shock-move2' },
  { key: 'shockAvgMult',      inputId: 'params-shock-avgmult' },
  { key: 'shockScoreNeed',    inputId: 'params-shock-score' },
  { key: 'shockCooldownBars', inputId: 'params-shock-cooldown-bars' },
  { key: 'openGuardBars',     inputId: 'params-open-guard-bars' },
  { key: 'flashYen',          inputId: 'params-flash-yen' },
  { key: 'granvilleMaMid',    inputId: 'params-granville-ma-mid' },
  { key: 'granvilleMaLong',   inputId: 'params-granville-ma-long' },
  { key: 'levelTol',             inputId: 'params-level-tol' },
  { key: 'levelShowN',           inputId: 'params-level-shown' },
  { key: 'levelSelectWindowYen', inputId: 'params-level-window' },
  { key: 'fibConfluenceBonus',   inputId: 'params-fib-confluence' },
  { key: 'levelTestBonus',       inputId: 'params-level-testbonus' },
  { key: 'levelLookbackSessions',  inputId: 'params-level-lookback' },
  { key: 'levelLookbackSessions2', inputId: 'params-level-lookback2' },
  // ★検知チューニング(40日ライブ分析: break継続0pt / slope+52pt)。
  { key: 'breakScore',           inputId: 'params-break-score' },
  { key: 'slopeConfluenceBonus', inputId: 'params-slope-bonus' },
];

// ★検知チューニング: double 形成通知(boolean・既定OFF)。数値と別扱いのチェックボックス。
const DOUBLE_FORMING_ID = 'params-double-forming';

export interface ParamsElements {
  openBtn: HTMLButtonElement;
  modal: HTMLElement;
  backdrop: HTMLElement;
  closeBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  portWarning: HTMLElement;
  status: HTMLElement;
  // ★v0.8.3: 設定モーダル分割で 🎛️ に移設したフィールド(Web検索モデル/AIエントリー/データ)の
  //   読込・保存は設定モーダル側のコントローラに委譲する(id 参照なので同じハンドラで動く)。
  //   開いた時に onOpen で移設フィールドを反映し、保存時に onSave で同じ /api/settings/keys に保存する。
  onOpen?: () => Promise<void> | void;
  onSave?: () => Promise<void> | void;
}

export function initParamsModal(el: ParamsElements): void {
  let current: Record<string, number> | null = null;

  const inputOf = (id: string): HTMLInputElement | null =>
    document.getElementById(id) as HTMLInputElement | null;

  async function refresh() {
    el.status.textContent = '';
    el.portWarning.classList.add('hidden');
    try {
      const res = await fetch(apiUrl('/api/settings'));
      const s = await res.json() as Record<string, number>;
      current = s;
      for (const p of PARAMS) {
        const input = inputOf(p.inputId);
        if (input && typeof s[p.key] === 'number') input.value = String(s[p.key]);
      }
      // ★double 形成通知(boolean)をチェックボックスへ反映。
      const cb = inputOf(DOUBLE_FORMING_ID);
      if (cb) cb.checked = (s as Record<string, unknown>).doubleFormingEnabled === true;
    } catch {
      el.status.textContent = '取得失敗';
    }
  }

  function open() {
    el.modal.classList.remove('hidden');
    void refresh();
    // ★v0.8.3: 移設フィールド(Web検索モデル/AIエントリー/データ)を設定コントローラで反映。
    void el.onOpen?.();
  }
  function close() { el.modal.classList.add('hidden'); }

  el.openBtn.addEventListener('click', open);
  el.closeBtn.addEventListener('click', close);
  el.backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modal.classList.contains('hidden')) close();
  });

  el.saveBtn.addEventListener('click', async () => {
    el.saveBtn.disabled = true;
    const orig = el.saveBtn.textContent ?? '保存';
    el.saveBtn.textContent = '保存中...';
    try {
      // ★v0.8.3: 先に移設フィールド(Web検索モデル/AIエントリー/データ操作は id 参照)を
      //   設定コントローラ経由で保存(⚙️ 保存と同じ /api/settings/keys・同じ項目)。
      await el.onSave?.();
      const body: Record<string, number | boolean> = {};
      for (const p of PARAMS) {
        const input = inputOf(p.inputId);
        if (!input) continue;
        const v = Number(input.value);
        if (current && v !== current[p.key]) body[p.key] = v;
      }
      // ★double 形成通知(boolean)。変更時のみ送る(true/false を明示送信)。
      const cb = inputOf(DOUBLE_FORMING_ID);
      if (cb && current && cb.checked !== ((current as Record<string, unknown>).doubleFormingEnabled === true)) {
        body.doubleFormingEnabled = cb.checked;
      }
      const res = await fetch(apiUrl('/api/settings/keys'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json() as { ok?: boolean; error?: string; portRequiresRestart?: boolean };
      if (res.ok && d.ok !== false) {
        el.status.textContent = '保存しました';
        if (d.portRequiresRestart) el.portWarning.classList.remove('hidden');
        await refresh();
      } else {
        el.status.textContent = `保存失敗: ${d.error ?? `HTTP ${res.status}`}`;
      }
    } catch (err) {
      el.status.textContent = `保存失敗: ${err instanceof Error ? err.message : 'unknown'}`;
    } finally {
      el.saveBtn.disabled = false;
      el.saveBtn.textContent = orig;
    }
  });
}
