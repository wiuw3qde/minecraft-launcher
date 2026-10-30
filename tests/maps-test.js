'use strict';
/* 地图本地安装（src/maps.installWorldZip）纯 Node 单测：内置最小 zip 构造，无外部依赖。 */
const fs = require('fs');
const path = require('path');
const { installWorldZip } = require('../src/maps');

/* ---- 内置最小 zip(stored) 创建，避免依赖系统 zip 工具 ---- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const name of Object.keys(files)) {
    const data = Buffer.from(files[name], 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // method 0=store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localFull = Buffer.concat([local, nameBuf, data]);
    chunks.push(localFull);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += localFull.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.log('FAIL:', name); }
}

const root = path.join(__dirname, 'tmp');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

// 1. 正常地图 zip（含 MyWorld/level.dat）
const zip1 = path.join(root, 'map1.zip');
fs.writeFileSync(zip1, makeZip({ 'MyWorld/level.dat': 'LEVEL', 'MyWorld/region/r.0.0.mca': 'DATA', 'MyWorld/readme.txt': 'hi' }));
const gdir = path.join(root, 'gamedir');
const saves1 = path.join(gdir, 'saves');
const r1 = installWorldZip(zip1, saves1);
assert('正常地图安装 ok', r1.ok === true);
assert('识别世界名 MyWorld', r1.installed === 'MyWorld');
assert('saves/MyWorld/level.dat 存在', fs.existsSync(path.join(saves1, 'MyWorld', 'level.dat')));
assert('saves/MyWorld/readme.txt 存在', fs.existsSync(path.join(saves1, 'MyWorld', 'readme.txt')));

// 2. 重名：再次安装应拒绝
const r2 = installWorldZip(zip1, saves1);
assert('重名拒绝', r2.ok === false && /同名世界/.test(r2.error));

// 3. 非地图 zip（无 level.dat）→ 拒绝
const zip3 = path.join(root, 'map3.zip');
fs.writeFileSync(zip3, makeZip({ 'readme.txt': 'not a map', 'sub/file.txt': 'x' }));
const r3 = installWorldZip(zip3, saves1);
assert('非地图 zip 拒绝', r3.ok === false && /level\.dat/.test(r3.error));

// 4. 不存在的 zip → 拒绝
const r4 = installWorldZip(path.join(root, 'nope.zip'), saves1);
assert('不存在 zip 拒绝', r4.ok === false && /未找到 zip/.test(r4.error));

// 5. 顶层无文件夹、level.dat 直接在根 → 用 zip 名包裹
const zip5 = path.join(root, 'flatworld.zip');
fs.writeFileSync(zip5, makeZip({ 'level.dat': 'L', 'a.txt': 'x' }));
const saves5 = path.join(root, 'gamedir5', 'saves');
const r5 = installWorldZip(zip5, saves5);
assert('扁平地图(根 level.dat) ok', r5.ok === true);
assert('扁平地图用文件名命名世界', r5.installed === 'flatworld');
assert('saves/flatworld/level.dat 存在', fs.existsSync(path.join(saves5, 'flatworld', 'level.dat')));

fs.rmSync(root, { recursive: true, force: true });
console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
process.exit(fail ? 1 : 0);
