// 検証台の 1 ページ(素朴でよい)。
// ★AI 生成文字列は必ず textContent で描く(innerHTML には一切入れない)。
//   このファイルの中の HTML は **こちらが書いた固定文字列だけ**。

export const PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>プロンプト検証台(臨時)</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 16px; background: #14161a; color: #dfe3e8;
         font: 13px/1.6 "Meiryo", "Yu Gothic UI", system-ui, sans-serif; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .sub { color: #8b93a1; font-size: 12px; margin-bottom: 12px; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
         background: #1c1f26; border: 1px solid #2c313b; border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; }
  button { background: #2f6feb; color: #fff; border: 0; border-radius: 5px;
           padding: 8px 18px; font-size: 14px; cursor: pointer; }
  button:disabled { background: #3a4048; color: #888; cursor: default; }
  label { color: #b8c0cc; }
  section { border: 1px solid #2c313b; border-radius: 6px; margin-bottom: 14px; background: #1a1d23; }
  section > h2 { font-size: 13px; margin: 0; padding: 8px 12px; background: #232830;
                 border-bottom: 1px solid #2c313b; border-radius: 6px 6px 0 0; color: #9fd0ff; }
  pre { margin: 0; padding: 10px 12px; white-space: pre-wrap; word-break: break-word;
        font: 12px/1.55 "Consolas", "Meiryo", monospace; max-height: 60vh; overflow: auto; }
  .msg { border-bottom: 1px solid #262b33; }
  .msg:last-child { border-bottom: 0; }
  .role { padding: 4px 12px; background: #20242b; color: #c8a; font-size: 11px; }
  .ans { background: #16211a; }
  .err { background: #2a1a1a; color: #ff9a9a; }
  .meta { padding: 6px 12px; color: #8b93a1; font-size: 11px; background: #191c22; }
  .warn { color: #ffcc66; }
  .ok { color: #7fd18a; }
</style>
</head>
<body>
<h1>プロンプト検証台(臨時)</h1>
<div class="sub">本番の monitor には触りません。売買しません。実 DB には書きません(APPDATA を砂箱へ差し替え済み)。
ボタンを押したときだけ LLM を 2 回呼びます(A と B)。</div>

<div class="bar">
  <button id="go">実行</button>
  <label><input type="radio" name="sig" value="dummy" checked> シグナル: 固定ダミー</label>
  <label><input type="radio" name="sig" value="none"> 何もしない</label>
  <button id="last" style="background:#3a4048">直近の記録を読む</button>
  <span id="status" class="sub" style="margin:0"></span>
</div>

<section><h2>出所と欠落(この回に何が取れたか)</h2><pre id="diag">未実行</pre></section>
<section><h2>① AI に渡したデータ(本番と同じ組み立ての全文)</h2><pre id="data">未実行</pre></section>
<section><h2>② プロンプト A(送信した全文)</h2><div id="pa"></div></section>
<section><h2>② A の返答(全文)</h2><pre id="ra" class="ans">未実行</pre><div id="ma" class="meta"></div></section>
<section><h2>③ プロンプト B(送信した全文)</h2><div id="pb"></div></section>
<section><h2>③ B の返答(全文)</h2><pre id="rb" class="ans">未実行</pre><div id="mb" class="meta"></div></section>
<section><h2>④ シグナル表示</h2><pre id="sig">未実行</pre></section>

<script>
const $ = (id) => document.getElementById(id);

function renderMessages(host, messages) {
  host.textContent = '';
  for (const m of messages) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    const r = document.createElement('div');
    r.className = 'role';
    r.textContent = '[' + m.role + ']';
    const p = document.createElement('pre');
    p.textContent = m.content;          // ★AI へ送った全文をそのまま(整形しない)
    wrap.appendChild(r); wrap.appendChild(p);
    host.appendChild(wrap);
  }
}

function renderLeg(preId, metaId, leg) {
  const pre = $(preId);
  pre.className = leg.error ? 'err' : 'ans';
  pre.textContent = leg.error ? ('失敗: ' + leg.error) : leg.answer;   // ★textContent のみ
  const u = leg.usage;
  $(metaId).textContent =
    'provider=' + (leg.provider || '-') + ' / model=' + (leg.model || '-') +
    ' / ' + (leg.ms / 1000).toFixed(1) + 's' +
    (u ? (' / tokens in=' + (u.prompt ?? '?') + ' out=' + (u.completion ?? '?') + ' total=' + (u.total ?? '?')) : ' / tokens 不明');
}

function renderDiag(r) {
  const d = r.diag;
  const mb = (r.source.srcBytes / 1024 / 1024).toFixed(1);
  const age = Math.round((r.at - r.source.srcMtime) / 60000);
  const lines = [];
  lines.push('種 DB: ' + r.source.srcDb);
  lines.push('       ' + mb + ' MB / 更新 ' + new Date(r.source.srcMtime).toLocaleString('ja-JP') + ' (' + age + '分前)');
  lines.push('現在値(NIY=F): ' + (d.price === null ? '取得できず' : d.price) + ' / 価格 ' + d.priceCount + '銘柄');
  lines.push('DB 足: ' + d.barCount + '本 / 最新 ' + (d.lastBarT ? new Date(d.lastBarT).toLocaleString('ja-JP') : '—'));
  lines.push('節目: 上 ' + d.levelsUp + ' / 下 ' + d.levelsDown + '   ニュース: ' + d.newsCount + '件');
  lines.push('ブロック: ' + Object.entries(d.blocks).map(([k, v]) => (v ? '○' : '×') + k).join('  '));
  lines.push(d.problems.length === 0 ? '問題なし' : '問題:\\n  - ' + d.problems.join('\\n  - '));
  lines.push('system プロンプト: ' + r.systemPromptUsed);
  lines.push('記録: ' + (r.savedTo || '(保存できず)'));
  $('diag').textContent = lines.join('\\n');
}

function show(r) {
  renderDiag(r);
  $('data').textContent = r.data;
  renderMessages($('pa'), r.a.messages);
  renderLeg('ra', 'ma', r.a);
  renderMessages($('pb'), r.b.messages);
  renderLeg('rb', 'mb', r.b);
  $('sig').textContent = r.signal ? JSON.stringify(r.signal, null, 2) : '何もしない(シグナルを出さない設定)';
}

// ★LLM を呼ばずに直近の記録を読み返す(課金ゼロ)。?replay=1 付きで開くと自動で読む。
async function loadLast(auto) {
  $('status').textContent = '直近の記録を読み込み中…';
  const res = await fetch('/api/last');
  const r = await res.json();
  if (!res.ok) { $('status').textContent = (auto ? '' : '失敗: ') + (r.error || res.status); return; }
  show(r);
  $('status').textContent = '直近の記録(' + new Date(r.at).toLocaleString('ja-JP') + ') ※LLM は呼んでいません';
}
$('last').addEventListener('click', () => loadLast(false));
if (new URLSearchParams(location.search).get('replay') === '1') loadLast(true);

$('go').addEventListener('click', async () => {
  const btn = $('go');
  btn.disabled = true;
  $('status').textContent = '実行中…(データ組み立て → A → B)';
  try {
    const mode = document.querySelector('input[name=sig]:checked').value;
    const res = await fetch('/api/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signalMode: mode }),
    });
    const r = await res.json();
    if (!res.ok) { $('status').textContent = '失敗: ' + (r.error || res.status); btn.disabled = false; return; }
    show(r);
    $('status').textContent = '完了 ' + new Date(r.at).toLocaleTimeString('ja-JP');
  } catch (e) {
    $('status').textContent = '失敗: ' + (e && e.message ? e.message : String(e));
  }
  btn.disabled = false;
});
</script>
</body>
</html>
`;
