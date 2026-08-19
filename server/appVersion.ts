// アプリの版(single source of truth)。
//
// ■ なぜ独立したモジュールにするか
//   版は server/index.ts のローカル定数だったので、**記録側(台帳)からは触れなかった**。
//   その結果「この行はどの版が書いたか」が台帳のどこにも無く、解析では
//   `collector_status_<host>.txt` の起動ログの時刻や「機能列がいつ初めて埋まったか」からの
//   **間接推定**に頼るしかなかった(実際に切り分けの定数を2時間ずらして誤った結論を出しかけた)。
//   → 版を葉モジュールに出し、台帳・meta・HTTP 応答が同じ値を使う。
//
// ■ 解決の順序(index.ts の従来ロジックと同一・byte 等価)
//   ① ビルド時 define(__APP_VERSION__)… scripts/build-server.mjs / build-generator.mjs /
//      build-collector.mjs が package.json の version を埋め込む(3つのバンドル全部に入る)。
//   ② 無ければ package.json を実行時に読む(開発時の tsx 実行・vitest)。
//   ★ここは依存ゼロの葉にする(node:fs / node:path のみ)。store.ts / llm から import されるので、
//     ここに何か重いものを import すると、それが全部の記録経路に載る。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

declare const __APP_VERSION__: string | undefined;

/** 実行中のアプリの版(例 '0.9.92')。★台帳・meta・/api/health は必ずこの値を使う。 */
export const APP_VERSION: string = (typeof __APP_VERSION__ === 'string')
  ? __APP_VERSION__
  : (() => {
      try {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version?: unknown };
        return typeof pkg.version === 'string' ? pkg.version : 'unknown';
      } catch {
        // ★無音で落とさない: 版が読めないことは記録の欠測になるので、値としても 'unknown' を残す
        //   (NULL と区別できる=「列を持たない旧行」と「読めなかった回」が混ざらない)。
        return 'unknown';
      }
    })();
