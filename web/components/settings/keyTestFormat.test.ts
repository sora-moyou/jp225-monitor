import { describe, it, expect } from 'vitest';
import { formatKeyTestLine } from './keyTest.js';

// ─── ★「キーを検証」の表示が『キーが無効』と『モデルが使えない』を区別する ────────────
//
// 実運用の症状 `kimi: 404 Not found the model kimi-latest or Permission denied` は、
// 従来 ❌ の1行にしかならず、**次に何をすればよいか画面から分からなかった**。
//
// ★否定対照(修正前のコードで赤くなること): 修正前の keyTest.ts に formatKeyTestLine は無く、
//   描画はクリックハンドラ内のインラインで `✅ 有効 / ❌ <error>` の2択だった。
//   「⚠️ キーは有効・モデル不可 + 使えるモデル一覧」は表現自体が存在しない。

describe('formatKeyTestLine', () => {
  it('★キーは有効・モデルが使えない → ⚠️ と「使えるモデル一覧」と次の一手を出す', () => {
    const r = formatKeyTestLine({
      name: 'kimi', ok: false, keyOk: true, modelOk: false, reason: 'model',
      model: 'kimi-latest', models: ['kimi-k2-turbo-preview', 'moonshot-v1-8k'], modelsTotal: 2,
      error: 'モデル "kimi-latest" はこのキーでは使えません(一覧 2 件に無し)',
    });
    expect(r.mark).toBe('⚠️');
    expect(r.html).toContain('キーは有効');
    expect(r.html).toContain('kimi-latest');
    expect(r.html).toContain('kimi-k2-turbo-preview');   // 選べる候補が画面に出る
    expect(r.html).toContain('moonshot-v1-8k');
    expect(r.html).toContain('モデル');                   // どこを直すかが書いてある
  });

  it('★キーが無効 → ❌ で「モデル以前の問題」と書く(モデル欄をいじらせない)', () => {
    const r = formatKeyTestLine({
      name: 'openai', ok: false, keyOk: false, reason: 'key', model: 'gpt-4o-mini',
      error: '401 Incorrect API key provided',
    });
    expect(r.mark).toBe('❌');
    expect(r.html).toContain('キーが無効');
    expect(r.html).toContain('401');
  });

  it('キーもモデルもOK → ✅ と使用モデル名', () => {
    const r = formatKeyTestLine({ name: 'gemini', ok: true, keyOk: true, modelOk: true, reason: 'ok', model: 'gemini-flash-latest', isDefaultModel: true, via: 'models' });
    expect(r.mark).toBe('✅');
    expect(r.html).toContain('gemini-flash-latest');
    expect(r.html).toContain('既定');
  });

  it('一覧非対応で ping 判定した場合はその旨を書く(何で判定したかを隠さない)', () => {
    const r = formatKeyTestLine({ name: 'groq', ok: true, via: 'ping', reason: 'ok', model: 'llama-3.3-70b-versatile' });
    expect(r.mark).toBe('✅');
    expect(r.html).toContain('ping');
  });

  it('未設定は ⚪(従来どおり)', () => {
    const r = formatKeyTestLine({ name: 'kimi', ok: false, notset: true });
    expect(r.mark).toBe('⚪');
    expect(r.html).toContain('未設定');
  });

  it('モデル名/エラーは HTML エスケープする', () => {
    const r = formatKeyTestLine({ name: 'kimi', ok: false, reason: 'unknown', model: '<script>x</script>', error: '<b>bad</b>' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<b>bad</b>');
  });
});
