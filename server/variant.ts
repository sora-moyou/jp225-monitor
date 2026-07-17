// 製品バリアント(full=monitor2 / lite=monitor)の解決。
// Rust(lib.rs)が identifier から決めた variant をサイドカー spawn 時に
// 環境変数 MONITOR_VARIANT で渡す。server はそれを読むだけ(エンジンは不変・
// lite は web 側の表示を隠すだけ)。未設定/その他は full(=現行と完全同一・安全側)。

export type MonitorVariant = 'full' | 'lite';

export function resolveVariant(env: NodeJS.ProcessEnv = process.env): MonitorVariant {
  return env.MONITOR_VARIANT === 'lite' ? 'lite' : 'full';
}
