'use strict';
/* 极简 ZIP 读取实现：只做 natives jar 所需的解压，避免依赖 PowerShell / 第三方库 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function parseZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件：' + file);

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

function readEntry(z, entry) {
  const buf = z.buf;
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== SIG_LOCAL) throw new Error('zip 条目损坏：' + entry.name);
  const method = buf.readUInt16LE(p + 8);
  const compressedSize = buf.readUInt32LE(p + 18);
  const uncompressedSize = buf.readUInt32LE(p + 22);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + (compressedSize || Math.max(0, buf.length - start)));
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  if (uncompressedSize === 0) return Buffer.alloc(0);
  throw new Error('不支持的压缩方式（' + method + '）：' + entry.name);
}

/**
 * 解压到目标目录
 * @param filter 返回 false 表示跳过该文件（用于 extract.exclude）
 * @returns 写入的文件数
 */
function extractAll(zipFile, destDir, filter) {
  const z = parseZip(zipFile);
  const dest = path.resolve(destDir);
  let written = 0;
  for (const entry of z.entries) {
    if (entry.name.endsWith('/')) continue;
    if (filter && !filter(entry.name)) continue;
    const target = path.resolve(dest, entry.name);
    if (target !== dest && !target.startsWith(dest + path.sep)) continue; // 防 zip slip
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let data;
    try {
      data = readEntry(z, entry);
    } catch (e) {
      continue; // 单个条目损坏不影响其余文件
    }
    fs.writeFileSync(target, data);
    written++;
  }
  return written;
}

/** 列出 zip 内的文件名（调试/排查用） */
function listEntries(zipFile) {
  return parseZip(zipFile).entries.map((e) => e.name);
}

/** 读取 zip 内某文本条目的内容（如 manifest.json） */
function readText(zipFile, name) {
  const z = parseZip(zipFile);
  const e = z.entries.find((en) => en.name === name || en.name.replace(/\/$/, '') === name);
  if (!e) return null;
  return readEntry(z, e).toString('utf8');
}

/**
 * 解压到目标目录，名称可通过 mapFn 重写（返回 null 跳过该条目）。
 * @param mapFn (entryName) => targetRel | null
 * @returns 写入的文件数
 */
function extractMapped(zipFile, destDir, mapFn) {
  const z = parseZip(zipFile);
  const dest = path.resolve(destDir);
  let written = 0;
  for (const entry of z.entries) {
    if (entry.name.endsWith('/')) continue;
    const targetRel = mapFn ? mapFn(entry.name) : entry.name;
    if (targetRel === null || targetRel === undefined) continue;
    const target = path.resolve(dest, targetRel);
    if (target !== dest && !target.startsWith(dest + path.sep)) continue; // 防 zip slip
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let data;
    try {
      data = readEntry(z, entry);
    } catch (e) {
      continue;
    }
    fs.writeFileSync(target, data);
    written++;
  }
  return written;
}

module.exports = { extractAll, extractMapped, listEntries, parseZip, readText };
