// ─── 分析用コードの単一ゲート ────────────────────────────────────────────────
//
// 「決済パラメータの分析」のために足した機構(ティック長期保管 / 提案生成器 / 影の決済模擬)は、
// **公開版(lite)には要らない**。要らないものを走らせると、公開版のユーザーの PC で
// ディスクとネットワークと API キーを黙って消費する。だから走らせない。
//
// ★名前は「なぜ止めるのか」で付ける(どの variant かではない)。
//   将来 lite でも一部の分析を使いたくなったときに、呼び出し側を読み直さずに
//   「これは分析用だから止まっている」と意味で判断できるようにするため。
//
// ★新しい設定機構は作らない: 判定材料は既存の MonitorVariant(server/variant.ts)だけ。
//   MONITOR_VARIANT は Rust(src-tauri/src/lib.rs)が identifier から決めて、
//   サイドカー(server)と収集デーモン(collector)の両方へ環境変数で渡す。
//
// ★未設定は full(=分析あり)。variant.ts と同じ安全側の倒し方を使う
//   (dev/テスト/既存の呼び出し経路は今までどおり動く = full の挙動は1ミリも変わらない)。
//
// ★取引経路(紙エンジン)には **絶対に置かない**。lite と full でエンジンの挙動を分岐させると
//   「full では動くが lite で壊れる」種類のバグを作る(variant.ts の設計注記)。
//   例: server/signalTrade/exitConfigVersion.ts の版記録は engine.ts から呼ばれる取引経路の中なので、
//       分析用の見た目でもゲートしない。

import { resolveVariant } from './variant.js';

/** 分析用コードを走らせてよいか。lite(公開版)だけ false。 */
export function isAnalysisEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveVariant(env) === 'full';
}
