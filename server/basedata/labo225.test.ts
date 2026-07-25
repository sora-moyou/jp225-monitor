import { describe, it, expect } from 'vitest';
import { buildLoginBody, classifyDownload } from './labo225.js';

describe('buildLoginBody', () => {
  it('op/xoops_redirect/uname/pass を URL エンコードして含む', () => {
    const body = buildLoginBody('taro', 'secret');
    const p = new URLSearchParams(body);
    expect(p.get('op')).toBe('login');
    expect(p.get('xoops_redirect')).toBe('/');
    expect(p.get('uname')).toBe('taro');
    expect(p.get('pass')).toBe('secret');
  });

  it('特殊文字を URL エンコードする(& = 等)', () => {
    const body = buildLoginBody('a b&c', 'p=w&d');
    expect(body).toContain('uname=a+b%26c');
    expect(body).toContain('pass=p%3Dw%26d');
    // デコードして往復一致(区切り文字の誤解釈が無い)。
    const p = new URLSearchParams(body);
    expect(p.get('uname')).toBe('a b&c');
    expect(p.get('pass')).toBe('p=w&d');
  });
});

describe('classifyDownload', () => {
  it('PK マジックバイトは zip(コンテナ扱い・中身検査は別工程)', () => {
    expect(classifyDownload('application/octet-stream', Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    expect(classifyDownload('application/zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
  });

  it('<html/<!DOCTYPE で始まれば html(未ログイン)', () => {
    expect(classifyDownload('text/html; charset=utf-8', Buffer.from('<!DOCTYPE html><html>'))).toBe('html');
    expect(classifyDownload(null, Buffer.from('  <html>'))).toBe('html');
  });

  it('Content-Type が spreadsheet/excel なら xlsx(バイト不明でも)', () => {
    expect(classifyDownload('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from([0x00, 0x01]))).toBe('xlsx');
  });

  it('判別不能は unknown', () => {
    expect(classifyDownload('application/json', Buffer.from('{}'))).toBe('unknown');
  });
});
