import { describe, it, expect } from 'vitest';
import { initNewsOffHoursToggle, type CheckboxLike, type TextLike } from './newsOffHours.js';

// ★このトグルには「保存」ボタンが無い(ニュースパネル内の即時保存)。だから守るべきは:
//   ① 開いたときの表示が **server の実効値** と一致する(未設定は OFF)。
//   ② 変更したら 1項目だけ保存される。
//   ③ ★保存に失敗したらチェックを元に戻して理由を出す(見た目 ON・実際 OFF という無言の失敗を作らない)。

function makeCb(): CheckboxLike & { fire: () => void } {
  let handler: (() => void) | null = null;
  return {
    checked: false,
    disabled: false,
    addEventListener(_type, h) { handler = h; },
    fire() { handler?.(); },
  };
}
const makeStatus = (): TextLike => ({ textContent: '' });
const flush = async (): Promise<void> => { await new Promise(r => setTimeout(r, 0)); };

describe('initNewsOffHoursToggle', () => {
  it('設定が true なら ON で表示する', async () => {
    const cb = makeCb();
    await initNewsOffHoursToggle(cb, makeStatus(), {
      fetchSettings: async () => ({ newsOffHoursEnabled: true }),
      saveEnabled: async () => true,
    });
    expect(cb.checked).toBe(true);
  });

  it('設定が未設定なら OFF で表示する(既定=現行挙動)', async () => {
    const cb = makeCb();
    await initNewsOffHoursToggle(cb, makeStatus(), {
      fetchSettings: async () => ({}),
      saveEnabled: async () => true,
    });
    expect(cb.checked).toBe(false);
  });

  it('取得に失敗しても落ちず、OFF 側で表示して理由を出す', async () => {
    const cb = makeCb();
    const st = makeStatus();
    await initNewsOffHoursToggle(cb, st, {
      fetchSettings: async () => { throw new Error('boom'); },
      saveEnabled: async () => true,
    });
    expect(cb.checked).toBe(false);
    expect(st.textContent).toContain('読めません');
  });

  it('チェックしたら true が 1回だけ保存される', async () => {
    const cb = makeCb();
    const saved: boolean[] = [];
    await initNewsOffHoursToggle(cb, makeStatus(), {
      fetchSettings: async () => ({}),
      saveEnabled: async (v) => { saved.push(v); return true; },
    });
    cb.checked = true;
    cb.fire();
    await flush();
    expect(saved).toEqual([true]);
    expect(cb.checked).toBe(true);
    expect(cb.disabled).toBe(false);
  });

  it('★保存に失敗したらチェックを元に戻して理由を出す', async () => {
    const cb = makeCb();
    const st = makeStatus();
    await initNewsOffHoursToggle(cb, st, {
      fetchSettings: async () => ({}),
      saveEnabled: async () => false,
    });
    cb.checked = true;
    cb.fire();
    await flush();
    expect(cb.checked).toBe(false);           // 見た目だけ ON にしない
    expect(st.textContent).toContain('失敗');
    expect(cb.disabled).toBe(false);
  });

  it('★保存が例外で落ちてもチェックを元に戻す', async () => {
    const cb = makeCb();
    const st = makeStatus();
    await initNewsOffHoursToggle(cb, st, {
      fetchSettings: async () => ({ newsOffHoursEnabled: true }),
      saveEnabled: async () => { throw new Error('network'); },
    });
    expect(cb.checked).toBe(true);
    cb.checked = false;   // OFF にしようとして失敗
    cb.fire();
    await flush();
    expect(cb.checked).toBe(true);
    expect(st.textContent).toContain('失敗');
  });

  it('要素が無くても落ちない(部分DOM/lite 以外の版でも安全)', async () => {
    await expect(initNewsOffHoursToggle(null, null, {
      fetchSettings: async () => ({}),
      saveEnabled: async () => true,
    })).resolves.toBeUndefined();
  });
});
