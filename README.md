# Finance Monitor

日経先物トレーダー向け軽量市場ダッシュボード。

## 起動

```bash
npm install
cp .env.example .env  # OPENAI_API_KEY を設定（省略可、LLM説明が無効化されるだけ）
npm run dev
```

ブラウザで http://localhost:5173 を開く。

## 設計

`docs/superpowers/specs/2026-05-28-finance-monitor-design.md` を参照。
