// ─── LLM バレル(server/llm/openai.ts) ─────────────────────────────────
// このモジュールは歴史的経緯で全 LLM 機能の単一入口だった。責務は段階的に別モジュールへ抽出済み:
//   - providers.ts  : プロバイダのライフサイクル・サーキットブレーカー・フォールバック・ビジョン判定
//   - translate.ts  : 英文ニュースの日本語訳
//   - explain.ts    : アラート原因分析(explain)＋ニュースランキング(scoreNews/selectNewsPool 等)
//   - dataTools.ts  : chat/scalp が共有するデータ参照ツール・ツールループ・整形・monitor コンテキスト
//   - chat.ts       : チャット入口(chat)
//   - scalpPlan.ts  : スキャル計画(buildScalpPlan)＋プロンプト生成/パース/制約強制
// 既存 importer(index.ts・routes・signalTrade・tests 等)は従来どおり `./openai.js` から
// 全シンボルを import できるよう、ここで抽出先を再エクスポートする(バレル)。
//
// providers.ts の import 時副作用=プロバイダ構築 + `[LLM] enabled providers` ログは、
// この `export *` で providers.ts が(推移的に)読み込まれた時に一度だけ発火する。
export * from './providers.js';
export { translate } from './translate.js';
export * from './explain.js';
export * from './dataTools.js';
export * from './chat.js';
export * from './scalpPlan.js';
