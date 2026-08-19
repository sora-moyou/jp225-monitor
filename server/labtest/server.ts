// 検証台の HTTP サーバ(本番の server/index.ts とは **別プロセス・別ポート**)。
// ルートは 2 本だけ: ページと、実行。自動では何も回さない(= 放置しても課金は増えない)。

import express from 'express';
import { runOnce, rerunB, newestRunFile, type SignalMode } from './run.js';
import { PAGE_HTML } from './page.js';
import { getSandbox } from './sandbox.js';

const DEFAULT_PORT = 5199;

export async function startLabtestServer(): Promise<void> {
  const port = Number(process.env.LABTEST_PORT ?? DEFAULT_PORT);
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => {
    res.type('html').send(PAGE_HTML);
  });

  // 砂箱の素性(実 DB に触っていないことを外から確認できるように)。
  app.get('/api/sandbox', (_req, res) => {
    try { res.json(getSandbox()); }
    catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  // 直近の実行記録をそのまま返す(★LLM を呼ばない)。過去の回を画面で読み返すため。
  app.get('/api/last', async (_req, res) => {
    const file = newestRunFile();
    if (!file) { res.status(404).json({ error: 'まだ1回も実行していません' }); return; }
    try {
      const { readFileSync } = await import('node:fs');
      res.type('json').send(readFileSync(file, 'utf8'));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ★LLM を **呼ばずに** ①のデータだけを組み立てる(組み立ての確認とコスト見積もり用)。
  //   外部 HTTP は価格取得の 1 GET だけ。課金は発生しない。
  app.get('/api/context', async (_req, res) => {
    try {
      const { buildLabContext } = await import('./context.js');
      const { buildPromptB, QUESTION_A } = await import('./run.js');
      const promptB = buildPromptB();
      const built = await buildLabContext(`${QUESTION_A}\n${promptB}`);
      res.json({ ...built, promptB, chars: built.text.length });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ★LLM を呼ぶ唯一の入口。ボタンを押したときだけ走る。
  app.post('/api/run', async (req, res) => {
    const raw = (req.body ?? {}) as { signalMode?: unknown };
    const signalMode: SignalMode = raw.signalMode === 'none' ? 'none' : 'dummy';
    try {
      const result = await runOnce(signalMode);
      res.json(result);
    } catch (e) {
      console.error('[labtest] 実行に失敗:', e instanceof Error ? (e.stack ?? e.message) : String(e));
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ★B の質問文だけを差し替えて比べたいときの入口。過去の記録からデータと A の返答を流用するので
  //   LLM 呼び出しは **1 回だけ**、かつ動く変数は「B の質問文」1 つだけになる。
  app.post('/api/rerun-b', async (req, res) => {
    const raw = (req.body ?? {}) as { file?: unknown };
    const file = typeof raw.file === 'string' && raw.file ? raw.file : newestRunFile();
    if (!file) { res.status(400).json({ error: '元になる実行記録がありません(先に1回実行してください)' }); return; }
    try {
      res.json(await rerunB(file));
    } catch (e) {
      console.error('[labtest] B の投げ直しに失敗:', e instanceof Error ? (e.stack ?? e.message) : String(e));
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve) => {
    const srv = app.listen(port, '127.0.0.1', () => {
      console.log(`[labtest] http://127.0.0.1:${port} で待受(実行ボタンを押した時だけ LLM を 2 回呼びます)`);
      resolve();
    });
    srv.on('error', (err) => {
      console.error('[labtest] listen 失敗:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  });
}
