import { apiUrl } from '../lib/apiBase.js';

interface StatusResponse {
  yahoo: { fallback: boolean; skipUntil: number };
  llm: Array<{ name: string; enabled: boolean; paused: boolean; pausedUntil: number }>;
  /** ★提案生成器(分析用)の台帳の死活。公開版(lite)や未導入の PC では返らない(=表示しない)。 */
  generatorLedger?: {
    available: boolean; lastRecordAt: number | null; ageMin: number | null; total: number;
    /** 直近1時間に **標本が取れた** 件数(status='plan')。台帳を読めない環境では無い。 */
    planLastHour?: number;
    /** 直近1時間に **取引時間内に** 投げた件数。0=標本を取る時間帯ではない。 */
    inSessionLastHour?: number;
    /** ★まだ効いている停止理由(最後の記録より後に止まったときだけ入る)。決済の実数値は含まれない。 */
    halt?: { at: number; phase: string; reason: string };
  };
  /** ★生成器サイドカーが有効化されているか(設定・既定 false)。公開版(lite)では返らない。 */
  generatorEnabled?: boolean;
  /** ★収集デーモン(collector)の死活。**両 variant 共通**(収集デーモンは lite でも走る)。
   *  判定は monitor(生きている側)が出す = 収集デーモンが死んでも判定は凍らない。
   *  測れない環境(旧 monitor)では返らない=表示しない。 */
  collector?: {
    /** 'ok'=収集中 / 'idle'=生存・取引時間外 / 'stuck'=★生きているが記録が止まっている /
     *  'dead'=★停止 / 'missing'=心拍が一度も無い。 */
    state: 'ok' | 'idle' | 'stuck' | 'dead' | 'missing';
    reason: string;
    heartbeatAt: number | null;
    ageMs: number | null;
    inPollWindow: boolean;
    pidAlive: boolean;
    at: number;
  };
}

/** 生成器が「止まった」と見なす無記録の分数。1サイクル=2分なので、数サイクル落ちても
 *  すぐ赤にはせず、明らかに止まっている領域で警告にする。
 *  ★これは **プロセスが生きているか** の指標でしかない(下の説明)。 */
const GENERATOR_STALE_MIN = 15;

/** ★死活の本体: 直近1時間に取れているべき標本の下限。
 *  1サイクル2分・1サイクル2〜3腕なので、正常なら1時間で 60〜90 件。ゲートに散発的に弾かれても
 *  この線は割らない。取引時間内でここを割ったら「溜まっていない」と言い切ってよい。 */
const GENERATOR_MIN_PLANS_PER_HOUR = 10;

/** ★「生成器」の1点表示(純関数)。
 *  1年かけて溜める実験の最悪の失敗形は「実は3か月動いていなかった」。生成器側だけの死活監視は
 *  生成器が死ぬと一緒に死ぬので、**ユーザーが毎日見る画面** に出す。
 *  台帳そのものが無い環境(未導入・公開版)では **何も出さない**(存在しない機構の警告を出さない)。
 *
 *  ★指標は「プロセスが生きているか」ではなく **「標本が溜まっているか」**。
 *    生成器はゲートに弾かれている間も2分ごとに status='skipped' を書き続けるので、
 *    「最終記録 N分前」は **止まっている間も新しいまま** = 画面は緑のまま(実売買PCの実ログで
 *    セッションの 91〜100% が停止していたのに一度も警告色にならなかった)。溜めたいのは提案なので、
 *    直近1時間の status='plan' の件数で判定する。
 *  ★planLastHour を返さない応答(台帳を読めない/古い monitor)だけ、従来の「最終記録 N分前」に落ちる。 */
export function renderGeneratorDot(
  ledger: StatusResponse['generatorLedger'],
  enabled?: StatusResponse['generatorEnabled'],
): string {
  // ★「無効だから動いていない」と「止まった」は別物。まず前者を先に言い切る
  //   (無効なのに「止まっている」と警告したら、warnings が読まれなくなる)。
  //   enabled===undefined は **この情報を返さない monitor**(公開版 lite / 旧版)= 従来どおり無言。
  if (enabled === false) {
    return renderDot('Ge', 'off', '提案生成器: 無効（設定 ⚙️「提案生成器」で有効にすると動き出します）');
  }
  // ★止まった理由は、記録が有る/無いに関わらず最優先で出す。運用PCではコンソールを見られないので、
  //   ここに出ないと「なぜ止まったか」は永遠に分からない(理由はログにしか無かった)。
  if (ledger?.halt) {
    return renderDot('Ge', 'halted',
      `提案生成器: ★停止しました（${ledger.halt.phase}）— ${ledger.halt.reason}`);
  }
  if (!ledger || !ledger.available) {
    // 有効化されているのに台帳がまだ無い=サイドカーが1行も書いていない(起動直後 or 起動していない)。
    return enabled === true
      ? renderDot('Ge', 'paused', '提案生成器: 有効だが記録がまだありません（起動直後、または生成器が起動していません）')
      : '';
  }
  if (ledger.ageMin === null) {
    return renderDot('Ge', 'off', '提案生成器: 台帳はあるが記録が1件もありません');
  }
  const age = `最終記録 ${ledger.ageMin}分前 (通算 ${ledger.total} 件)`;
  if (typeof ledger.planLastHour === 'number') {
    const plans = ledger.planLastHour;
    const inSession = ledger.inSessionLastHour ?? 0;
    const head = `提案生成器: 直近1時間の標本 ${plans} 件 / ${age}`;
    // 取引時間外は「取れなくて当たり前」。常態を警告色にすると警告が読まれなくなるので灰にする。
    if (inSession === 0 && plans < GENERATOR_MIN_PLANS_PER_HOUR) {
      return renderDot('Ge', 'off', `${head} — 取引時間外(標本を取る時間帯ではありません)`);
    }
    if (plans < GENERATOR_MIN_PLANS_PER_HOUR) {
      return renderDot('Ge', 'paused',
        `${head} — ★標本が溜まっていません(プロセスは動いていても、ゲートで止められている可能性)`);
    }
    return renderDot('Ge', 'ok', head);
  }
  const stale = ledger.ageMin >= GENERATOR_STALE_MIN;
  return renderDot('Ge', stale ? 'paused' : 'ok',
    `提案生成器: ${age}`
    + (stale ? ' — ★止まっている可能性があります' : ''));
}

/** ★「収集デーモン(Co)」の1点表示(純関数)。生成器の Ge ドットと **同じ流儀**。
 *
 *  ■ 何を防ぐか
 *    実運用で collector のプロセスが 10:13:44 に停止し、ティック保管も台帳の毎時書き出しも
 *    止まったのに、**画面には何も出なかった**。1年かけてティックを溜めている最中なので、
 *    黙って死ぬとデータが虫食いになり、それに1年後に気づく。
 *
 *  ■ ★「取引時間外だから止まっている」と「死んでいる」を取り違えない
 *    心拍(collector_heartbeat)は取引時間外でも打たれる(場中2秒/場外30秒)。だから
 *    **心拍の凍結だけ** を死亡の根拠にし、セッションは「生きている時の言い方」を分けるためだけに使う。
 *    ティックが増えない/書き出しが走らないは時間外でも正常なので、根拠にしない。
 *
 *  ■ ★判定は monitor(生きている側)が出す
 *    収集デーモン自身に状態を書かせると、死んだ瞬間に「最後に生きていた時の状態」が固まる。
 *    それが今回の誤診断の直接原因だった。 */
export function renderCollectorDot(c: StatusResponse['collector']): string {
  // 測れない環境(旧 monitor / 状態を返さない応答)は従来どおり無言。
  if (!c) return '';
  if (c.state === 'dead') {
    return renderDot('Co', 'halted',
      `データ収集: ★停止しています — ${c.reason}`
      + '（アプリを起動し直すと収集デーモンも起動します）');
  }
  // ★「生きているが仕事をしていない」。プロセスは居るので dead とは直し方が違うが、
  //   データが虫食いになるという被害は同じなので **見逃せない色(赤)** にする。
  if (c.state === 'stuck') {
    return renderDot('Co', 'halted',
      `データ収集: ★生きていますが記録が止まっています — ${c.reason}`
      + '（アプリを起動し直すと収集デーモンも起動し直します）');
  }
  if (c.state === 'missing') {
    return renderDot('Co', 'paused', `データ収集: ${c.reason}`);
  }
  if (c.state === 'idle') {
    // ★生きている。取引時間外に収集していないのは常態なので警告色にしない
    //   (常態を警告色にすると警告が読まれなくなる)。
    return renderDot('Co', 'off', `データ収集: 生存（取引時間外＝収集は待機中）— ${c.reason}`);
  }
  return renderDot('Co', 'ok', `データ収集: 稼働中 — ${c.reason}`);
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

// 'halted' = ★意図的に停止した(前提が崩れた)。黄(=一時的な待機)と同じ色にすると
//            「そのうち戻る」に見えてしまうので、赤で「戻らない・人が直すもの」を表す。
function renderDot(label: string, state: 'ok' | 'paused' | 'off' | 'halted', tooltip: string): string {
  const emoji = state === 'ok' ? '🟢' : state === 'paused' ? '🟡' : state === 'halted' ? '🔴' : '⚪';
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
  container.innerHTML = priceDot + llm
    + renderCollectorDot(data.collector)
    + renderGeneratorDot(data.generatorLedger, data.generatorEnabled);
}

export function initApiStatusPane(container: HTMLElement, intervalMs: number = 5000): void {
  void refreshApiStatus(container);
  setInterval(() => { void refreshApiStatus(container); }, intervalMs);
}
