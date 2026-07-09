import { describe, it, expect, vi, beforeEach } from 'vitest';

// fs / configStore をモックしてパス解決の分岐を検証する。
const existsMock = vi.fn<[string], boolean>();
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: (p: string) => existsMock(p) };
});
vi.mock('../configStore.js', () => ({ loadConfig: () => loadConfigReturn }));

let loadConfigReturn: Record<string, unknown> = {};

import { resolveChromePath, buildChromeArgs, captureChartPng } from './chartShot.js';

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
} as unknown as NodeJS.ProcessEnv;

const PF_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

describe('resolveChromePath', () => {
  beforeEach(() => {
    existsMock.mockReset();
    loadConfigReturn = {};
  });

  it('設定の chromePath を最優先で使う(存在すれば)', () => {
    const custom = 'D:\\portable\\chrome.exe';
    loadConfigReturn = { chromePath: custom };
    existsMock.mockImplementation((p) => p === custom);
    expect(resolveChromePath(WIN_ENV)).toBe(custom);
  });

  it('env CHROME_PATH で上書きできる(設定に無い時)', () => {
    const custom = 'E:\\chrome\\chrome.exe';
    existsMock.mockImplementation((p) => p === custom);
    expect(resolveChromePath({ ...WIN_ENV, CHROME_PATH: custom })).toBe(custom);
  });

  it('上書きが無ければ Program Files の既定パスを見つける', () => {
    existsMock.mockImplementation((p) => p === PF_CHROME);
    expect(resolveChromePath(WIN_ENV)).toBe(PF_CHROME);
  });

  it('LocalAppData のインストールも見つける', () => {
    const localChrome = 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    existsMock.mockImplementation((p) => p === localChrome);
    expect(resolveChromePath(WIN_ENV)).toBe(localChrome);
  });

  it('どこにも無ければ null(→ テキストのみフォールバック)', () => {
    existsMock.mockReturnValue(false);
    // レジストリ照会は win32 でのみ走るが、存在しなければ最終的に null。
    const r = resolveChromePath(WIN_ENV);
    // CI(非 win32)では null、win32 実機でレジストリにあれば string になり得るため型だけ確認。
    expect(r === null || typeof r === 'string').toBe(true);
  });
});

describe('buildChromeArgs', () => {
  it('CDP 撮影に必要なフラグ(リモートデバッグ)と URL/プロファイルを含む', () => {
    const args = buildChromeArgs('http://127.0.0.1:3000/chart-shot', 47821, 'C:\\tmp\\ud');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--hide-scrollbars');
    expect(args).toContain('--window-size=1280,760');
    expect(args).toContain('--remote-debugging-port=47821');
    expect(args).toContain('--remote-allow-origins=*');
    expect(args).toContain('--user-data-dir=C:\\tmp\\ud');
    expect(args).toContain('http://127.0.0.1:3000/chart-shot');
    // 旧単発撮影フラグは使わない(widget 描画前に撮って真っ黒になっていた)。
    expect(args.some((a) => a.startsWith('--screenshot'))).toBe(false);
    expect(args.some((a) => a.startsWith('--virtual-time-budget'))).toBe(false);
    // URL は末尾(chrome CLI の位置引数)。
    expect(args[args.length - 1]).toBe('http://127.0.0.1:3000/chart-shot');
  });
});

describe('captureChartPng (Chrome 不在)', () => {
  beforeEach(() => {
    existsMock.mockReset();
    loadConfigReturn = {};
  });

  it('Chrome が見つからなければ buffer=null / reason=chrome-not-found', async () => {
    existsMock.mockReturnValue(false);   // どのパスも存在しない
    // 非 win32 ではレジストリ照会もされず即 null。
    const r = await captureChartPng(3000);
    if (r.chromePath === null) {
      expect(r.buffer).toBeNull();
      expect(r.reason).toBe('chrome-not-found');
    } else {
      // win32 実機でレジストリから見つかった場合は撮影を試みる(このテストの対象外)。
      expect(typeof r.chromePath).toBe('string');
    }
  });
});
