import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installLogCapture, getLogs, resetLogBuffer, BUFFER_SIZE, setLogFile } from './logBuffer.js';

describe('logBuffer', () => {
  beforeEach(() => {
    resetLogBuffer();
  });

  it('setLogFile を設定するとファイルへも追記する(未設定なら書かない)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jp225-log-'));
    const file = join(dir, 'server.log');
    try {
      installLogCapture();
      console.log('before-sink');          // setLogFile 前=ファイルに出ない
      expect(existsSync(file)).toBe(false);
      setLogFile(file);
      console.log('sink-line-abc');
      console.warn('warn-xyz');
      const txt = readFileSync(file, 'utf-8');
      expect(txt).toContain('[log] sink-line-abc');
      expect(txt).toContain('[warn] warn-xyz');
      expect(txt).not.toContain('before-sink');
    } finally {
      resetLogBuffer();                    // logFilePath を null に戻す
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures console.log into buffer', () => {
    installLogCapture();
    console.log('hello world');
    const logs = getLogs();
    const last = logs[logs.length - 1];
    expect(last?.msg).toContain('hello world');
    expect(last?.level).toBe('log');
    expect(typeof last?.ts).toBe('number');
  });

  it('captures console.warn and console.error with correct level', () => {
    installLogCapture();
    console.warn('a warning');
    console.error('an error');
    const logs = getLogs();
    expect(logs[logs.length - 2]?.level).toBe('warn');
    expect(logs[logs.length - 1]?.level).toBe('error');
  });

  it('keeps at most BUFFER_SIZE entries (ring)', () => {
    installLogCapture();
    for (let i = 0; i < BUFFER_SIZE + 50; i++) console.log(`entry ${i}`);
    const logs = getLogs();
    expect(logs.length).toBe(BUFFER_SIZE);
    expect(logs[0]?.msg).toContain(`entry 50`);
    expect(logs[logs.length - 1]?.msg).toContain(`entry ${BUFFER_SIZE + 49}`);
  });

  it('formats objects via util.format', () => {
    installLogCapture();
    console.log('user', { id: 1 });
    const last = getLogs()[getLogs().length - 1];
    expect(last?.msg).toContain('user');
    expect(last?.msg).toContain("id: 1");
  });

  it('installLogCapture is idempotent (calling twice does not double-wrap)', () => {
    installLogCapture();
    installLogCapture();
    console.log('once');
    const matching = getLogs().filter(l => l.msg.includes('once'));
    expect(matching.length).toBe(1);
  });

  it('getLogs(since) filters by timestamp', async () => {
    installLogCapture();
    console.log('old');
    await new Promise(r => setTimeout(r, 5));
    const cutoff = Date.now();
    await new Promise(r => setTimeout(r, 5));
    console.log('new');
    const recent = getLogs(cutoff);
    expect(recent.some(l => l.msg.includes('new'))).toBe(true);
    expect(recent.some(l => l.msg.includes('old'))).toBe(false);
  });
});
