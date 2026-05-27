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

## 手動テスト手順

1. `npm run dev` 起動
2. http://localhost:5173 を開く
3. 右上のステータスが「受信中」になる
4. 8枚のカードに価格が表示される（数秒以内）
5. 「🔔 サウンドを有効化」をクリック → ボタンが消える
6. ニュースフィードに10ソースの記事が並ぶ
7. DevTools → Network → `/api/stream` を見て、EventSource 接続が `prices` イベントを継続受信していることを確認
8. アラート発火テスト: `web/lib/changeDetector.ts` の閾値を一時的に `0.001` に下げてリロード → 価格更新ごとにビープ + ハイライトが出る
9. LLM動作テスト: `.env` に `OPENAI_API_KEY` を設定 → 上記アラート時にバナーに日本語説明が追記される
10. 切断テスト: サーバを Ctrl+C で止める → ステータスが「切断」に変わる → 再起動で「受信中」へ復帰

## 既知の制限

- Yahoo Finance はレート制限・cookie要件の変化に弱い。`yahoo-finance2` がエラーを返した場合、Investing.com スクレイピングへフォールバック。両方失敗時はその銘柄が `---` 表示
- 米10年債は `^TNX` の小数点位置に注意（4.35 = 4.35%）
- 銘柄追加・閾値変更は `server/config.ts` を編集（UI からの変更は v0.1 では非対応）
