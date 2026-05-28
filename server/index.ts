import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { streamHandler } from './routes/stream.js';
import { explainHandler } from './routes/explain.js';
import { chatHandler } from './routes/chat.js';
import { getSettingsHandler, postSettingsHandler } from './routes/settings.js';
import { startPriceLoop } from './loops/priceLoop.js';
import { startNewsLoop } from './loops/newsLoop.js';
import { isLLMEnabled } from './llm/openai.js';

// esbuild が --define で埋め込む (本番バイナリ)
// dev (tsx) では undefined → package.json をフォールバック読み
declare const __APP_VERSION__: string | undefined;

const PORT = Number(process.env.PORT ?? 3000);

const APP_VERSION: string = (typeof __APP_VERSION__ === 'string')
  ? __APP_VERSION__
  : (() => {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
      return pkg.version;
    })();

console.log(`[server] JP225 Monitor v${APP_VERSION}`);

const app = express();
app.use(express.json({ limit: '256kb' }));
app.get('/api/stream', streamHandler);
app.post('/api/explain', explainHandler);
app.post('/api/chat', chatHandler);
app.get('/api/settings', getSettingsHandler);
app.post('/api/settings/keys', postSettingsHandler);
app.get('/api/health', (_req, res) => res.json({ ok: true, llm: isLLMEnabled(), version: APP_VERSION }));
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION, name: 'JP225 Monitor' }));

// 本番モード: dist/web があれば静的配信 (single binary or Tauri 用)
// 開発モード: Vite が別ポート (5173) で配信するのでスキップ
const isPkg = (process as unknown as { pkg?: unknown }).pkg !== undefined;
const distWeb = isPkg
  ? join(dirname(process.execPath), 'web')        // pkg バイナリと並ぶ web/
  : join(process.cwd(), 'dist', 'web');           // 開発・ビルド時は cwd/dist/web
if (existsSync(distWeb)) {
  app.use(express.static(distWeb));
  console.log(`[server] serving static frontend from ${distWeb}`);
}

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (LLM ${isLLMEnabled() ? 'enabled' : 'disabled'})`);
  startPriceLoop();
  startNewsLoop();
});
