import { describe, it, expect } from 'vitest';
import { getUpdateStatus } from './updater.js';

describe('getUpdateStatus', () => {
  it('returns unsupported outside the Tauri runtime', async () => {
    // vitest の node 環境では window が無い (= Tauri 外) ため unsupported になる。
    const status = await getUpdateStatus();
    expect(status).toEqual({ state: 'unsupported' });
  });
});
