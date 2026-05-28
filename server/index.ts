import express from 'express';
import { streamHandler } from './routes/stream.js';
import { explainHandler } from './routes/explain.js';
import { chatHandler } from './routes/chat.js';
import { startPriceLoop } from './loops/priceLoop.js';
import { startNewsLoop } from './loops/newsLoop.js';
import { isLLMEnabled } from './llm/openai.js';

const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json({ limit: '256kb' }));
app.get('/api/stream', streamHandler);
app.post('/api/explain', explainHandler);
app.post('/api/chat', chatHandler);
app.get('/api/health', (_req, res) => res.json({ ok: true, llm: isLLMEnabled() }));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (LLM ${isLLMEnabled() ? 'enabled' : 'disabled'})`);
  startPriceLoop();
  startNewsLoop();
});
