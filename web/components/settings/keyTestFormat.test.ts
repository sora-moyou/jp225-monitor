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

  // ★実害: 一覧は <details> に入れていたが **既定で閉じていた**ため、画面には
  //   「このキーで使えるモデル (4件)」の1行しか出ず、肝心のモデル名が見えなかった
  //   (ユーザー報告「4行はありません」)。この分岐の存在理由そのものが隠れていた。
  //   ★否定対照: 修正前の `<details class="model-list">` には open が無いので下記は赤。
  it('★モデル一覧は既定で開いている(open が付く=モデル名が実際に見える)', () => {
    const r = formatKeyTestLine({
      name: 'kimi', ok: false, keyOk: true, modelOk: false, reason: 'model',
      model: 'kimi-latest', models: ['kimi-k2-turbo-preview', 'moonshot-v1-8k'], modelsTotal: 2,
    });
    expect(r.html).toContain('<details class="model-list" open>');
    // 実際に生成される HTML で、summary の後ろに <li> が並んでいること
    expect(r.html).toContain('<li><code>kimi-k2-turbo-preview</code></li>');
    expect(r.html).toContain('<li><code>moonshot-v1-8k</code></li>');
  });

  it('★open が付くのは reason==="model" だけ(他の分岐の表示は変えない)', () => {
    const others = [
      formatKeyTestLine({ name: 'openai', ok: false, keyOk: false, reason: 'key', model: 'gpt-4o-mini', error: '401' }),
      formatKeyTestLine({ name: 'gemini', ok: true, keyOk: true, modelOk: true, reason: 'ok', model: 'gemini-flash-latest' }),
      formatKeyTestLine({ name: 'groq', ok: true, via: 'ping', reason: 'ok', model: 'llama-3.3-70b-versatile' }),
      formatKeyTestLine({ name: 'kimi', ok: false, notset: true }),
      formatKeyTestLine({ name: 'kimi', ok: false, reason: 'unknown', model: 'x', error: 'なにか' }),
    ];
    for (const o of others) {
      expect(o.html).not.toContain('<details');
      expect(o.html).not.toMatch(/<\w+[^>]*\sopen[\s>]/);   // どのタグにも open 属性を足していない
    }
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
