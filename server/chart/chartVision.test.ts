import { describe, it, expect } from 'vitest';
import { isVisionCapableProvider, buildScalpUserContent } from '../llm/openai.js';

describe('isVisionCapableProvider', () => {
  it('gemini / openai はビジョン対応', () => {
    expect(isVisionCapableProvider('gemini', 'gemini-2.5-flash')).toBe(true);
    expect(isVisionCapableProvider('openai', 'gpt-4o-mini')).toBe(true);
  });

  it('groq(テキスト専用)は非対応', () => {
    expect(isVisionCapableProvider('groq', 'llama-3.3-70b-versatile')).toBe(false);
  });

  it('未知プロバイダは非対応', () => {
    expect(isVisionCapableProvider('mystery', 'x')).toBe(false);
  });

  it('画像非対応が明示されたモデル名は除外', () => {
    expect(isVisionCapableProvider('openai', 'whisper-1')).toBe(false);
    expect(isVisionCapableProvider('openai', 'text-embedding-3-small')).toBe(false);
  });
});

describe('buildScalpUserContent', () => {
  it('画像なしはプレーン文字列(テキストのみ・従来動作)', () => {
    expect(buildScalpUserContent('質問')).toBe('質問');
    expect(buildScalpUserContent('質問', null)).toBe('質問');
  });

  it('画像ありはテキスト+image_url の配列(OpenAI/Gemini 共通形式)', () => {
    const url = 'data:image/png;base64,AAAA';
    const c = buildScalpUserContent('質問', url) as any[];
    expect(Array.isArray(c)).toBe(true);
    expect(c[0]).toEqual({ type: 'text', text: '質問' });
    expect(c[1]).toEqual({ type: 'image_url', image_url: { url } });
  });
});
