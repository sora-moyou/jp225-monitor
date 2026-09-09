import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { maybeShowUpdateToast } from './updateToast.js';
import { wireUpdateSection } from './settings/update.js';
import type { SettingsElements } from './settings/types.js';
import type { UpdateStatus } from '../lib/updater.js';

// ─────────────────────────────────────────────────────────────────────────────
// ★この版の価値は「更新チェックの結末がサーバに届くこと」に**まるごと**乗っている。
//   その結線に検査が無いと、呼び出しを1行消しただけで全テストが緑のまま通る
//   = 今回直そうとしている「宣言だけ残って根拠が残らない」形が、番人の側に残る。
//   (実測: 差し戻し時、2箇所の呼び出しを消しても 328 files / 4822 passed で無傷だった)
//
// ここで固定するもの:
//   ① 起動時トースト経路 × 4状態(available / latest / error / unsupported)で POST が1件出る
//   ② 設定の「更新をチェック」× 同じ4状態で POST が1件出る
//   ③ ★「後で」で抑制中(トーストを出さない)でも記録は残る
//   ④ ★記録の送信が詰まっても本体(トースト表示)は止まらない
//
// ★jsdom は導入しない(既存の web テストの流儀)。DOM は最小スタブで、
//   **本物の maybeShowUpdateToast / wireUpdateSection をそのまま呼ぶ**(配線を通す)。
// ─────────────────────────────────────────────────────────────────────────────

const checkMock = vi.fn();
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => checkMock() }));

// ─── 最小 DOM スタブ ──────────────────────────────────────
interface FakeEl {
  innerHTML: string; className: string; textContent: string | null; disabled: boolean;
  style: Record<string, string>;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  addEventListener: (ev: string, fn: () => void) => void;
  querySelector: (sel: string) => FakeEl | null;
  _classes: Set<string>;
  _listeners: Record<string, Array<() => void>>;
}
function el(): FakeEl {
  const classes = new Set<string>();
  const listeners: Record<string, Array<() => void>> = {};
  const node: FakeEl = {
    innerHTML: '', className: '', textContent: null, disabled: false, style: {},
    classList: { add: c => { classes.add(c); }, remove: c => { classes.delete(c); }, contains: c => classes.has(c) },
    addEventListener: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
    // render() が引く子要素はすべて同型のスタブを返す(存在すれば配線は通る)。
    querySelector: () => el(),
    _classes: classes, _listeners: listeners,
  };
  return node;
}
const fire = (node: FakeEl, ev: string): void => { for (const fn of node._listeners[ev] ?? []) fn(); };

function fakeLocalStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

// ─── fetch の記録 ────────────────────────────────────────
interface Post { url: string; body: Record<string, unknown> }
let posts: Post[] = [];

function stubFetch(opts: { hang?: boolean } = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes('/api/update-check')) {
      posts.push({ url: u, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      if (opts.hang) return new Promise(() => { /* ★永久に解決しない */ });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u.includes('/api/basedata/status')) return { ok: true, status: 200, json: async () => ({ ok: true, published: false }) };
    if (u.includes('/api/version')) return { ok: true, status: 200, json: async () => ({ version: '0.9.111' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  }));
}

/** 画面の4状態を、Tauri プラグインの応答として作る。**本物の getUpdateStatus を通す**。 */
function arrange(state: UpdateStatus['state']): void {
  if (state === 'unsupported') {
    vi.stubGlobal('window', {});                       // Tauri 外(開発ブラウザ)
    return;
  }
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  if (state === 'error') checkMock.mockRejectedValue(new Error('Could not fetch a valid release JSON'));
  else if (state === 'latest') checkMock.mockResolvedValue(null);
  else checkMock.mockResolvedValue({ version: '0.9.112', body: null, date: null });
}

const STATES: ReadonlyArray<UpdateStatus['state']> = ['available', 'latest', 'error', 'unsupported'];

beforeEach(() => {
  posts = [];
  checkMock.mockReset();
  vi.stubGlobal('localStorage', fakeLocalStorage());
  stubFetch();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('★① 起動時トースト経路 — 4状態すべてで POST /api/update-check が1件出る', () => {
  for (const state of STATES) {
    it(`${state}`, async () => {
      arrange(state);
      await maybeShowUpdateToast(el() as unknown as HTMLElement, 0);
      await vi.waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]!.url).toContain('/api/update-check');
      expect(posts[0]!.body).toMatchObject({ source: 'startup', verdict: state });
    });
  }

  it('★available のときプラグインが返した版がそのまま乗る', async () => {
    arrange('available');
    await maybeShowUpdateToast(el() as unknown as HTMLElement, 0);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body.pluginVersion).toBe('0.9.112');
  });

  it('★error のとき理由が乗る(旧実装はここが完全に無音だった)', async () => {
    arrange('error');
    await maybeShowUpdateToast(el() as unknown as HTMLElement, 0);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(String(posts[0]!.body.message)).toContain('Could not fetch a valid release JSON');
  });
});

describe('★③ 「後で」で抑制中でも記録は残る(表示の都合で記録を落とさない)', () => {
  it('dismiss 済みの版でもトーストは出ないが POST は出る', async () => {
    arrange('available');
    vi.stubGlobal('localStorage', fakeLocalStorage({
      jp225_update_dismissed_until: JSON.stringify({ version: '0.9.112', until: Date.now() + 3600_000 }),
    }));
    const toast = el();
    await maybeShowUpdateToast(toast as unknown as HTMLElement, 0);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(toast.innerHTML).toBe('');                    // 描画していない = 抑制は効いている
    expect(posts[0]!.body).toMatchObject({ source: 'startup', verdict: 'available' });
  });
});

describe('★④ 記録の送信が詰まっても本体(トースト表示)は止まらない', () => {
  it('解決しない fetch を食わせてもトーストが描画される', async () => {
    arrange('available');
    stubFetch({ hang: true });                           // ★POST は永久に解決しない
    const toast = el();
    await maybeShowUpdateToast(toast as unknown as HTMLElement, 0);
    expect(posts).toHaveLength(1);                       // 記録は撃たれている
    expect(toast.innerHTML).toContain('0.9.112');        // ★それでもトーストは出る
    expect(toast._classes.has('hidden')).toBe(false);
  });
});

// ─── 設定の「更新をチェック」経路 ────────────────────────
function settingsStub(): { el: SettingsElements; btn: FakeEl } {
  const btn = el();
  btn.textContent = '更新をチェック';
  const currentVersion = el();
  currentVersion.textContent = 'v0.9.111';
  const stub = { checkUpdateBtn: btn, updateResult: el(), currentVersion };
  return { el: stub as unknown as SettingsElements, btn };
}

describe('★② 設定の「更新をチェック」— 4状態すべてで POST /api/update-check が1件出る', () => {
  for (const state of STATES) {
    it(`${state}`, async () => {
      arrange(state);
      const { el: se, btn } = settingsStub();
      wireUpdateSection(se);
      fire(btn, 'click');                                // 本物のハンドラを走らせる
      await vi.waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]!.url).toContain('/api/update-check');
      expect(posts[0]!.body).toMatchObject({ source: 'settings', verdict: state });
    });
  }

  it('画面に出ている版が clientVersion として乗る(v は落とす)', async () => {
    arrange('latest');
    const { el: se, btn } = settingsStub();
    wireUpdateSection(se);
    fire(btn, 'click');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body.clientVersion).toBe('0.9.111');
  });
});

describe('★2経路そろっていること(片方だけの結線になっていない)', () => {
  it('起動時と設定の両方から source 違いの記録が出る', async () => {
    arrange('latest');
    await maybeShowUpdateToast(el() as unknown as HTMLElement, 0);
    const { el: se, btn } = settingsStub();
    wireUpdateSection(se);
    fire(btn, 'click');
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.map(p => String(p.body.source)).sort()).toEqual(['settings', 'startup']);
  });
});
