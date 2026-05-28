import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { streamHandler } from './routes/stream.js';
import { explainHandler } from './routes/explain.js';
import { chatHandler } from './routes/chat.js';
import { getSettingsHandler, postSettingsHandler } from './routes/settings.js';
import { startPriceLoop } from './loops/priceLoop.js';
import { startNewsLoop } from './loops/newsLoop.js';
import { isLLMEnabled } from './llm/openai.js';

const PORT = Number(process.env.PORT ?? 3000);

// package.json からバージョン取得
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string; name: string };
const APP_VERSION = pkg.version;
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

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (LLM ${isLLMEnabled() ? 'enabled' : 'disabled'})`);
  startPriceLoop();
  startNewsLoop();
});
