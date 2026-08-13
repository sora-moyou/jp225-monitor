// ─── 呼び出し元の識別子(LlmCaller) ──────────────────────────────────────
//
// **この1つの識別子**が3つの分離を駆動する(新しい概念は増やさない):
//   ① プロバイダ・プールの選択      … providers.ts(プール別の circuitOpenUntil / 将来はプール別キー)
//   ② backpressure の適用可否       … routes/scalpPlan.ts(生成中なら generator だけ 429)
//   ③ 予算の計上先                  … generatorGate.ts(generator だけ日次予算+従属停止)
//
//   'default'   = 実取引(A)につながる既存の全経路。シグナルエンジン(server/signalTrade/engine.ts)・
//                 POST /api/scalp-plan の既存呼び出し・手動診断。**挙動は一切変えない**。
//   'generator' = 分析用の「分析用」(別プロセス・2分間隔でチャート画像つき LLM を叩く実験系)。
//                 実験系が実取引の経路を劣化させてはならない、というこのプロジェクトの一貫した原則により、
//                 プロバイダ状態・backpressure・予算のすべてで default から隔離し、かつ default に従属させる。
//
// ★別プロセス化では隔離にならない: /api/scalp-plan を叩くと LLM 呼び出しは monitor のプロセス内で起き、
//   モジュール単位のシングルトンだった circuitOpenUntil が共有される(=分析用の429で実取引が最大8時間止まる)。
//   だから「プロセス」ではなく「呼び出し元」で分ける。

export type LlmCaller = 'default' | 'generator';

/** 省略時の呼び出し元。既存の呼び出し元は必ずこれ(=従来の挙動)。 */
export const DEFAULT_CALLER: LlmCaller = 'default';

export type NormalizeCallerResult =
  | { ok: true; caller: LlmCaller }
  | { ok: false; error: string };

/** 外部入力(HTTP body/query)を LlmCaller へ正規化する純関数。
 *  - 未指定 / null / 空文字 → 'default'(★仕様: 省略時は default。既存呼び出し元は byte 不変)
 *  - 'default' / 'generator' → そのまま
 *  - それ以外 → **エラー(400)**。
 *
 *  ★未知の値を黙って 'default' に倒さない理由: 分析用が caller を打ち間違えた時、それを default 扱いすると
 *    実験系が実取引のプール・予算・backpressure をそのまま使ってしまう(=この機能が守ろうとしたものが壊れる)。
 *    黙って安全側に落ちるように見えて、実際は最も危険な側に落ちる。だから **失敗は声を出す**。 */
export function normalizeCaller(v: unknown): NormalizeCallerResult {
  if (v === undefined || v === null || v === '') return { ok: true, caller: DEFAULT_CALLER };
  if (v === 'default' || v === 'generator') return { ok: true, caller: v };
  return { ok: false, error: `caller は 'default' | 'generator' のみ(受信: ${typeof v === 'string' ? v.slice(0, 32) : typeof v})` };
}
