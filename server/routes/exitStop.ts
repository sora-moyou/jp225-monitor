import type { Request, Response } from 'express';
import { computeExitStop, exitImplStatus, type ExitState } from '../signalTrade/exit/index.js';

// 決済逆指値の **権威**(trade2 の孤児建玉保護用)。
//
// ■ なぜこの経路が要るか(消すとまた複製が生えるので理由を残す)
//   trade2 は monitor のシグナルを完全追従し、エントリー価格も通常の決済逆指値も monitor の値を
//   そのまま使う。ただし **孤児建玉**(約定漏れ=ブローカー側にだけ在る建玉)だけは monitor に
//   対応する建玉が無いため、trade2 が単独で保護逆指値を維持していた。そこだけ trade2 が
//   決済定数の **複製** を持っており、monitor 側の床を動かすと孤児建玉だけが別の益をロックし始める
//   (しかも気づく手段が無い)。→ 状態を受けて価格を返すこの経路に一本化する。
//
// ■ ★通信路に決済のパラメータを一切出さない
//   受けるのは **建玉の状態だけ**(方向・建値・初期LC・含み益ピーク)。返すのは **価格だけ**。
//   閾値/床/トレール幅といった決済パラメータはリクエストにもレスポンスにもエラーメッセージにも
//   現れない。trade2 が複製を抱えていた従来より秘匿は厳密に良くなる(値がプロセス外へ出ない)。
//
// ■ ★既存の決済関数をそのまま使う(再実装しない)
//   computeExitStop = monitor 自身の建玉(hold.exitStop)を算出しているのと **同じ関数・同じ値**。
//   孤児建玉であっても monitor の建玉と1バイトも違わない床で守られることが、この経路の要点。

/** 状態(リクエスト)の検証結果。失敗は **400 で声を出す**(黙って既定へ倒さない=静かに別物にならない)。 */
export type ParseExitStopResult =
  | { ok: true; state: ExitState }
  | { ok: false; error: string };

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * リクエスト body → ExitState の純関数。
 *  - direction : 'buy' | 'sell'(必須)
 *  - entryPrice: 有限数(必須)
 *  - initialStop: 有限数(必須・絶対価格)。★trade2 は roundToTick(建値∓初期LC)を送る。
 *  - peakProfit: 有限かつ 0 以上(必須)
 * ★未知/欠落を黙って既定に倒さない: 倒すと「別の状態で算出した価格」が正しい顔で返り、
 *   孤児建玉が意図と違う逆指値で守られる(最悪の壊れ方=静かに間違う)。
 */
export function parseExitStopRequest(body: unknown): ParseExitStopResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body が JSON オブジェクトではありません' };
  const b = body as Record<string, unknown>;
  const direction = b.direction;
  if (direction !== 'buy' && direction !== 'sell') {
    const got = typeof direction === 'string' ? direction.slice(0, 32) : typeof direction;
    return { ok: false, error: `direction は 'buy' | 'sell' のみ(受信: ${got})` };
  }
  const entryPrice = finite(b.entryPrice);
  if (entryPrice === null) return { ok: false, error: 'entryPrice は有限数が必須' };
  const initialStop = finite(b.initialStop);
  if (initialStop === null) return { ok: false, error: 'initialStop は有限数が必須' };
  const peakProfit = finite(b.peakProfit);
  if (peakProfit === null || peakProfit < 0) return { ok: false, error: 'peakProfit は 0 以上の有限数が必須' };
  return { ok: true, state: { direction, entryPrice, initialStop, peakProfit } };
}

/** 状態 → 価格。**monitor 自身の建玉と同一の関数**(computeExitStop)で算出する。
 *  null = 有効な逆指値なし(初期LC が非有限などの異常時)。呼び出し側(trade2)は null を
 *  「未取得」と同じ扱い=直近の逆指値を維持する。 */
export function exitStopResponse(state: ExitState): { exitStop: number | null } {
  return { exitStop: computeExitStop(state) };
}

// ─── ★権威でないときは値を返さない(503) ───────────────────────────────────────
//
// ■ 直した欠陥(消すとまた同じ壊れ方をする)
//   このルートは app.listen の時点で生きているが、非公開の決済実装のロード(loadExitImpl)は
//   startSignalEngine() の中で走る。SIGNAL_TRADE=0 なら **一度も走らない**。ロード前に引くと
//   computeExitStop は公開フォールバック(初期LC固定)で、**全 peak が initialStop と同値**(distinct=1)。
//   実測: ロード後は同じ6サンプルで distinct=5(=4/6 が不一致)。それが 200 で権威の顔をして返り、
//   呼び出し側(trade2)には見分ける手段が無かった(status().ok は true のまま)= 静かに間違う。
//   → **権威(private)でなければ価格を返さない**。trade2 は非2xx を「未取得」として扱い、
//     直近の逆指値を維持する(広げない・外さない)=劣化配置に落ちない。

/** 権威として答えられるか(数値なし)。false のとき返す 503 の本文。 */
export type ExitStopReadiness = { ready: true } | { ready: false; error: string };

export function exitStopReadiness(status = exitImplStatus()): ExitStopReadiness {
  if (status === 'private') return { ready: true };
  return {
    ready: false,
    error: status === 'unloaded'
      ? '決済ロジックが未ロードのため、決済逆指値の権威として応答できません(公開フォールバックの値は権威ではありません)'
      : '決済ロジックが公開フォールバックのため、決済逆指値の権威として応答できません',
  };
}

// ─── ★この経路だけ無認証のオラクルにしない ───────────────────────────────────
//
// ■ 直した欠陥
//   server/index.ts は全ルートへ `Access-Control-Allow-Origin: *` を付けていた。コメントは
//   「サイドカーは localhost 専用なので * で安全」だが、**この経路は秘密のパラメータを引ける**
//   ので成立しない(実測: 121 リクエストで段構造を完全復元)。ブラウザで任意のページを開いている
//   だけで、その頁の JS がループバックへ POST して応答を読めてしまう。
//   → **Origin/Referer を持つ要求(=ブラウザ文脈)はこの経路だけ拒否する**。
//     trade2 は Node の fetch(Origin/Referer を送らない)なので従来どおり引ける。

/** アクセス可否(ブラウザ文脈からの取得を塞ぐ)。**判定に値は一切出てこない**。 */
export type ExitStopAccess = { ok: true } | { ok: false; error: string };

function headerOf(headers: Record<string, unknown> | undefined, name: string): string | null {
  const v = headers?.[name];
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (Array.isArray(v) && typeof v[0] === 'string' && v[0].length > 0) return v[0];
  return null;
}

/**
 * ブラウザ文脈(Origin / Referer / Sec-Fetch-Site を伴う要求)を拒否する純関数。
 *  - ブラウザは fetch/XHR の **POST では同一オリジンでも必ず Origin を送る** ので、この1点で
 *    「頁の JS から引く」経路は塞がる(応答を読ませない=段構造を復元させない)。
 *  - trade2(Node fetch)/curl はこれらを送らない → 従来どおり通る。
 *  ★ここで「許可する Origin」を作らない: この経路を必要とするブラウザ頁は存在しない。
 *    許可リストを作ると、そこに何かを足した瞬間に元の穴へ戻る。
 */
export function exitStopAccessGate(headers: Record<string, unknown> | undefined): ExitStopAccess {
  for (const h of ['origin', 'referer', 'sec-fetch-site']) {
    if (headerOf(headers, h) !== null) {
      return { ok: false, error: `この経路はブラウザ文脈からは利用できません(${h})` };
    }
  }
  return { ok: true };
}

/** 503 を無音にしないための遷移ログ(洪水にしない: 状態が変わったときだけ出す)。 */
let lastNotReadyLogged: string | null = null;

/** POST /api/exit-stop → { exitStop }。状態を受けて価格だけを返す(パラメータは出さない)。
 *  ★順序: アクセス(403)→ 権威かどうか(503)→ 状態の検証(400)→ 価格。
 *   権威でない判定を検証より先に置く=「不正な状態」より先に「そもそも答える資格が無い」を返す。 */
export function exitStopHandler(req: Request, res: Response): void {
  const access = exitStopAccessGate(req.headers as unknown as Record<string, unknown>);
  if (!access.ok) {
    res.status(403).json({ error: access.error });
    return;
  }
  const readiness = exitStopReadiness();
  if (!readiness.ready) {
    if (lastNotReadyLogged !== readiness.error) {
      lastNotReadyLogged = readiness.error;
      console.warn(`[exit-stop] ${readiness.error} → 503(値は返しません)`);
    }
    res.status(503).json({ error: readiness.error });
    return;
  }
  lastNotReadyLogged = null;
  const parsed = parseExitStopRequest(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  res.json(exitStopResponse(parsed.state));
}
