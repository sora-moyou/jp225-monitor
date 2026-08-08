import { describe, it, expect, vi } from 'vitest';
import {
  buildTranslationPrompt, parseTranslationBatch, translateTitles, looksLikeProviderNotice,
  TRANSLATE_BATCH_SIZE, TRUNCATED_MARK, isSoftBatchError,
} from './translateNews.js';

describe('buildTranslationPrompt', () => {
  it('1始まりの番号付きにする', () => {
    expect(buildTranslationPrompt(['A', 'B'])).toBe('1. A\n2. B');
  });
  it('改行を潰す(行のズレを作らない)', () => {
    expect(buildTranslationPrompt(['A\nB  C'])).toBe('1. A B C');
  });
});

describe('parseTranslationBatch', () => {
  it('素直な形を読む', () => {
    expect(parseTranslationBatch('1. あ\n2. い', 2)).toEqual(['あ', 'い']);
  });
  it('番号の区切りは . ) : でも読む', () => {
    expect(parseTranslationBatch('1) あ\n2: い', 2)).toEqual(['あ', 'い']);
  });
  it('前置きや空行は読み飛ばす', () => {
    expect(parseTranslationBatch('訳は以下です:\n\n1. あ\n\n2. い\n', 2)).toEqual(['あ', 'い']);
  });
  it('順序が入れ替わっていても番号で正しい位置に入る', () => {
    expect(parseTranslationBatch('2. い\n1. あ', 2)).toEqual(['あ', 'い']);
  });

  // ★ここが本命: ズレは「誤訳」より重い(別記事の訳が別の見出しに付く)ので必ず捨てる。
  it('★件数が足りなければ null(部分採用しない)', () => {
    expect(parseTranslationBatch('1. あ', 2)).toBeNull();
  });
  it('★件数が多ければ null', () => {
    expect(parseTranslationBatch('1. あ\n2. い\n3. う', 2)).toBeNull();
  });
  it('★番号が重複していれば null', () => {
    expect(parseTranslationBatch('1. あ\n1. い', 2)).toBeNull();
  });
  it('★範囲外の番号があれば null', () => {
    expect(parseTranslationBatch('1. あ\n9. い', 2)).toBeNull();
  });
  it('★空の訳文があれば null', () => {
    expect(parseTranslationBatch('1. あ\n2.   ', 2)).toBeNull();
  });
  it('番号が1つも無ければ null', () => {
    expect(parseTranslationBatch('あ\nい', 2)).toBeNull();
  });
});

describe('★キー未設定の案内文を訳文として保存しない', () => {
  it('案内文を検出する', () => {
    expect(looksLikeProviderNotice('(LLM disabled — APIキーが未設定です。右上⚙️から設定してください)')).toBe(true);
    expect(looksLikeProviderNotice('1. 日銀が利上げ')).toBe(false);
  });

  it('★案内文が返ってきたら訳は付かず、理由が残る', async () => {
    const call = vi.fn(async () => '(LLM disabled — APIキーが未設定です。右上⚙️から設定してください)');
    const { results, error } = await translateTitles(['BOJ raises rates'], call);
    expect(results).toEqual([null]);
    expect(error).toBe('LLM未設定');
  });
});

describe('translateTitles', () => {
  it('訳せたら入力と同じ長さで返る', async () => {
    const call = vi.fn(async () => '1. 日銀が利上げ\n2. 原油が急騰');
    const { results, error } = await translateTitles(['BOJ hikes', 'Oil surges'], call);
    expect(results).toEqual(['日銀が利上げ', '原油が急騰']);
    expect(error).toBeNull();
  });

  it('空配列は呼び出さない(無駄な費用を出さない)', async () => {
    const call = vi.fn(async () => '');
    const { results } = await translateTitles([], call);
    expect(results).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it('★まとめて投げる(1件1リクエストにしない=レート制限で取引側を巻き添えにしない)', async () => {
    const n = TRANSLATE_BATCH_SIZE;
    const call = vi.fn(async (p: string) => {
      const c = p.split('\n').length;
      return Array.from({ length: c }, (_, i) => `${i + 1}. 訳${i}`).join('\n');
    });
    await translateTitles(Array.from({ length: n }, (_, i) => `t${i}`), call);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('バッチ超過分は次のリクエストへ', async () => {
    const call = vi.fn(async (p: string) => {
      const c = p.split('\n').length;
      return Array.from({ length: c }, (_, i) => `${i + 1}. 訳`).join('\n');
    });
    await translateTitles(Array.from({ length: TRANSLATE_BATCH_SIZE + 1 }, (_, i) => `t${i}`), call);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('★例外を投げない(取得ループを止めない)', async () => {
    const call = vi.fn(async () => { throw new Error('429 rate limited'); });
    const { results, error } = await translateTitles(['a', 'b'], call);
    expect(results).toEqual([null, null]);
    expect(error).toContain('429');
  });

  it('★例外が出たら以降のバッチを叩かない(ブレーカーを深く開けない)', async () => {
    const call = vi.fn(async () => { throw new Error('401 invalid key'); });
    await translateTitles(Array.from({ length: TRANSLATE_BATCH_SIZE * 3 }, (_, i) => `t${i}`), call);
    expect(call).toHaveBeenCalledTimes(1);
  });

  // ★実呼び出しで踏んだ事故の回帰: 出力が max_tokens で切れて行数が減っていた。
  it('★長さ切れは そのバッチだけ捨てて次へ進む(429 とは区別する)', async () => {
    const call = vi.fn(async () => { throw new Error(`${TRUNCATED_MARK} 出力が長さ上限で切れました`); });
    const n = TRANSLATE_BATCH_SIZE * 3;
    const { results, error } = await translateTitles(Array.from({ length: n }, (_, i) => `t${i}`), call);
    expect(call).toHaveBeenCalledTimes(3);      // 中断していない
    expect(results.every(r => r === null)).toBe(true);
    expect(error).toContain('長さ上限');
  });

  it('長さ切れの目印は他のエラーと混ざらない', () => {
    expect(isSoftBatchError(`${TRUNCATED_MARK} x`)).toBe(true);
    expect(isSoftBatchError('429 rate limited')).toBe(false);
  });

  it('行がずれたバッチは丸ごと捨てる(誤った対応付けを画面に出さない)', async () => {
    const call = vi.fn(async () => '1. 訳だけ');
    const { results, error } = await translateTitles(['a', 'b'], call);
    expect(results).toEqual([null, null]);
    expect(error).toBe('訳文の行がずれた');
  });
});
