'use strict';
/* 极简 ZIP 写入器：仅用于整合包导出（#5）。
 * 单文件内存占用（逐文件读取+压缩，不一次性载入全部），写入流式文件。
 * 采用 deflate 压缩（zlib.deflateRawSync），兼容所有解压器。 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// CRC32 表
const CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * 把一个目录打成 zip。
 * @param srcDir 源目录（.minecraft 内容）
 * @param outPath 输出 zip 路径
 * @param hooks { onCount(total), onProgress(done) }
 * @returns 输出路径
 */
function zipDir(srcDir, outPath, hooks) {
  hooks = hooks || {};
  const files = []; // { rel, abs }
  (function walk(dir, rel) {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of list) {
      const abs = path.join(dir, it.name);
      const r = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) walk(abs, r);
      else if (it.isFile()) files.push({ rel: r, abs });
    }
  })();

  if (hooks.onCount) hooks.onCount(files.length);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath);
  const central = [];
  const td = new Date();
  const tm = dosTime(td);
  let done = 0;
  let pos = 0; // 手动跟踪写入位置（out.bytesWritten 在缓冲写入下不可靠）

  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f.abs); } catch (e) { continue; }
    const rel = f.rel.split(/[\\/]/).join('/');
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(buf);
    const comp = zlib.deflateRawSync(buf);
    const localOffset = pos;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(8, 8); // method deflate
    header.writeUInt16LE(tm.time, 10);
    header.writeUInt16LE(tm.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(comp.length, 18);
    header.writeUInt32LE(buf.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    out.write(header);
    out.write(nameBuf);
    out.write(comp);
    pos += header.length + nameBuf.length + comp.length;

    central.push({
      crc,
      compSize: comp.length,
      uncompSize: buf.length,
      nameBuf,
      localOffset,
    });

    done++;
    if (hooks.onProgress) hooks.onProgress(done);
  }

  // 中央目录
  const centralOffset = pos;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(SIG_CENTRAL, 0);
    h.writeUInt16LE(20, 4); // version made by
    h.writeUInt16LE(20, 6); // version needed
    h.writeUInt16LE(0, 8); // flags
    h.writeUInt16LE(8, 10); // method
    h.writeUInt16LE(tm.time, 12);
    h.writeUInt16LE(tm.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.compSize, 20);
    h.writeUInt32LE(c.uncompSize, 24);
    h.writeUInt16LE(c.nameBuf.length, 28);
    h.writeUInt16LE(0, 30); // extra
    h.writeUInt16LE(0, 32); // comment
    h.writeUInt16LE(0, 34); // disk
    h.writeUInt16LE(0, 36); // internal attr
    h.writeUInt32LE(0, 38); // external attr
    h.writeUInt32LE(c.localOffset, 42);
    out.write(h);
    out.write(c.nameBuf);
    pos += h.length + c.nameBuf.length;
  }
  const centralSize = pos - centralOffset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  out.write(eocd);

  return new Promise((resolve, reject) => {
    out.on('finish', () => resolve(outPath));
    out.on('error', reject);
    out.end();
  });
}

/**
 * 用预先收集好的文件列表写 zip（不重新遍历目录）。
 * @param files [{ rel, abs }]
 */
function writeZipFiles(outPath, files, hooks) {
  hooks = hooks || {};
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath);
  const central = [];
  const td = new Date();
  const tm = dosTime(td);
  let done = 0;
  let pos = 0; // 手动跟踪写入位置（out.bytesWritten 在缓冲写入下不可靠）
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f.abs); } catch (e) { continue; }
    const rel = String(f.rel).split(/[\\/]/).join('/');
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(buf);
    const comp = zlib.deflateRawSync(buf);
    const localOffset = pos;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(tm.time, 10);
    header.writeUInt16LE(tm.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(comp.length, 18);
    header.writeUInt32LE(buf.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    out.write(header);
    out.write(nameBuf);
    out.write(comp);
    pos += header.length + nameBuf.length + comp.length;
    central.push({ crc, compSize: comp.length, uncompSize: buf.length, nameBuf, localOffset });
    done++;
    if (hooks.onProgress) hooks.onProgress(done);
  }
  const centralOffset = pos;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(SIG_CENTRAL, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(8, 10);
    h.writeUInt16LE(tm.time, 12);
    h.writeUInt16LE(tm.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.compSize, 20);
    h.writeUInt32LE(c.uncompSize, 24);
    h.writeUInt16LE(c.nameBuf.length, 28);
    h.writeUInt16LE(0, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt16LE(0, 38);
    h.writeUInt32LE(c.localOffset, 42);
    out.write(h);
    out.write(c.nameBuf);
    pos += h.length + c.nameBuf.length;
  }
  const centralSize = pos - centralOffset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  out.write(eocd);
  return new Promise((resolve, reject) => {
    out.on('finish', () => resolve(outPath));
    out.on('error', reject);
    out.end();
  });
}

module.exports = { zipDir, writeZipFiles, crc32 };
