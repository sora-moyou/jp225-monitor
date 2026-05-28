import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installLogCapture } from './logBuffer.js';
installLogCapture();   // 最初に install してすべての console を捕捉

import { streamHandler } from './routes/stream.js';
import { explainHandler } from './routes/explain.js';
import { chatHandler } from './routes/chat.js';
import { getSettingsHandler, postSettingsHandler } from './routes/settings.js';
import { statusHandler } from './routes/status.js';
import { logsHandler } from './routes/logs.js';
import { startPriceLoop } from './loops/priceLoop.js';
import { startNewsLoop } from './loops/newsLoop.js';
import { isLLMEnabled } from './llm/openai.js';
import { resolvePort } from './configStore.js';

declare const __APP_VERSION__: string | undefined;

const PORT = resolvePort();

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
app.get('/api/status', statusHandler);
app.get('/api/logs', logsHandler);
app.get('/api/health', (_req, res) => res.json({ ok: true, llm: isLLMEnabled(), version: APP_VERSION }));
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION, name: 'JP225 Monitor' }));

const isPkg = (process as unknown as { pkg?: unknown }).pkg !== undefined;
const distWeb = isPkg
  ? join(dirname(process.execPath), 'web')
  : join(process.cwd(), 'dist', 'web');
if (existsSync(distWeb)) {
  app.use(express.static(distWeb));
  console.log(`[server] serving static frontend from ${distWeb}`);
}

const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (LLM ${isLLMEnabled() ? 'enabled' : 'disabled'})`);
  startPriceLoop();
  startNewsLoop();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port ${PORT} already in use — another jp225-monitor is running. Exiting.`);
    process.exit(0);
  }
  console.error('[server] fatal listen error:', err);
  process.exit(1);
});
