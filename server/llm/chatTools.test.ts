import { describe, it, expect, vi } from 'vitest';
import { runChatWithTools } from './openai.js';

function fakeCreate(seq: any[]) {
  let i = 0;
  return vi.fn(async () => seq[i++]);
}

describe('runChatWithTools', () => {
  it('tool_calls 無し→単発で content 返す', async () => {
    const create = fakeCreate([{ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }]);
    const out = await runChatWithTools(create as any, [{ role: 'user', content: 'hi' }], [{}], async () => 'R', 3);
    expect(out).toBe('ok');
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('1回 tool_call→検索→最終回答', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'web_search', arguments: '{"query":"q"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: '最終' }, finish_reason: 'stop' }] },
    ]);
    const search = vi.fn(async () => 'SEARCHED');
    const out = await runChatWithTools(create as any, [{ role: 'user', content: 'hi' }], [{}], search, 3);
    expect(out).toBe('最終');
    expect(search).toHaveBeenCalledWith('q');
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('上限到達→tools無しで最終回答', async () => {
    const toolCall = { choices: [{ message: { content: null, tool_calls: [{ id: 't', function: { arguments: '{"query":"x"}' } }] }, finish_reason: 'tool_calls' }] };
    const create = fakeCreate([toolCall, toolCall, { choices: [{ message: { content: '打ち切り回答' } }] }]);
    const out = await runChatWithTools(create as any, [{ role: 'user', content: 'hi' }], [{}], async () => 'R', 2);
    expect(out).toBe('打ち切り回答');
    expect(create).toHaveBeenCalledTimes(3);
  });
});
