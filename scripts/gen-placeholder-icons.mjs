#!/usr/bin/env node
// 単色 PNG/ICO のプレースホルダー生成
// 後で `npx @tauri-apps/cli icon icon.png` で本物に置き換える想定

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

const ICONS_DIR = 'src-tauri/icons';
const COLOR = [13, 17, 23];  // ダーク背景色 (#0d1117) と同じ

mkdirSync(ICONS_DIR, { recursive: true });

// ─── PNG ジェネレータ ────────────────────────
const crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crc32Table[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function solidPNG(size, [r, g, b]) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const rowBytes = 3 * size;
  const raw = Buffer.alloc(size * (1 + rowBytes));
  for (let y = 0; y < size; y++) {
    const off = y * (1 + rowBytes);
    raw[off] = 0;
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ─── ICO (PNG埋め込み形式) ────────────────────
function pngToIco(pngBuf, size) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4);  // color planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);  // image offset (6+16=22)
  return Buffer.concat([dir, entry, pngBuf]);
}

// ─── ICNS (macOS) は省略 — 一旦 PNG 代用、bundle時に警告出るかも ──

// ─── 出力 ─────────────────────────────────────
const targets = [
  { name: '32x32.png',     size: 32 },
  { name: '128x128.png',   size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png',      size: 512 },
];

for (const { name, size } of targets) {
  const png = solidPNG(size, COLOR);
  writeFileSync(join(ICONS_DIR, name), png);
  console.log(`✓ ${ICONS_DIR}/${name} (${size}×${size}, ${png.length} bytes)`);
}

// ICO は 256x256 PNG を埋め込む
const icoSource = solidPNG(256, COLOR);
const ico = pngToIco(icoSource, 256);
writeFileSync(join(ICONS_DIR, 'icon.ico'), ico);
console.log(`✓ ${ICONS_DIR}/icon.ico (256×256, ${ico.length} bytes)`);

// .icns は省略 (macOSビルド時のみ必要、Windowsターゲットなら不要)

console.log(`\n💡 本物のアイコンに置き換える場合:`);
console.log(`   1. 1024x1024 の icon.png を用意`);
console.log(`   2. npx @tauri-apps/cli icon /path/to/source.png`);
