// 更新チェックの配信先 URL の **唯一の置き場**(SSOT)。
//
// ■ なぜ定数モジュールを作るのか
//   更新チェックそのものは Tauri の updater プラグインが行い、その URL は
//   `src-tauri/tauri.conf.json` / `tauri.lite.conf.json` の `plugins.updater.endpoints` にある。
//   サーバ側でも **同じ URL を自分で叩いて突き合わせる**(server/routes/updateCheck.ts)ため、
//   サーバにも URL が要る。ここで conf からコピペすると **二重管理** になり、
//   「宣言(conf)と実体(サーバの probe)が別の URL を見ている」= 記録が嘘をつく状態になる。
//   → 値はこのファイルにだけ書き、**conf と一致していることを endpoints.test.ts が固定する**
//     (ズレたら赤で止まる)。番人の作り方は server/sources/instrumentPriceRoutes.test.ts に倣った。
//
// ■ full / lite の選び分けは **既存の variant 判定をそのまま使う**(新しい判定を作らない)。
//   Rust(lib.rs)が identifier から決めた variant を環境変数 MONITOR_VARIANT でサイドカーに渡し、
//   server/variant.ts の resolveVariant() がそれを読む。ここはその結果で表を引くだけ。

import { resolveVariant, type MonitorVariant } from '../variant.js';

/** variant → updater の配信先。**この2行が唯一の出所**(conf は番人テストで一致を強制)。 */
export const UPDATER_ENDPOINTS: Record<MonitorVariant, string> = {
  full: 'https://github.com/sora-moyou/jp225-monitor2-releases/releases/latest/download/latest.json',
  lite: 'https://github.com/sora-moyou/jp225-monitor/releases/latest/download/latest.json',
};

/** variant → 一致を検査する tauri conf のパス(リポジトリルートからの相対)。
 *  番人テストが「どの conf を読むか」もここに1回だけ書く(テスト側に散らさない)。 */
export const UPDATER_CONF_FILES: Record<MonitorVariant, string> = {
  full: 'src-tauri/tauri.conf.json',
  lite: 'src-tauri/tauri.lite.conf.json',
};

export function updaterEndpointFor(variant: MonitorVariant): string {
  return UPDATER_ENDPOINTS[variant];
}

/** 実行中のこのプロセスが使う配信先。**variant の判定は resolveVariant にしか無い**。 */
export function resolveUpdaterEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return updaterEndpointFor(resolveVariant(env));
}
