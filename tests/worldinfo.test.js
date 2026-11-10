'use strict';
/* S1 / N12：世界存档卡片数据 + listWorlds 真实 {Data:{...}} 结构回归 + 只读硬边界 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const instance = require('../src/instance');

const ROOT = path.join(__dirname, 'tmp', 'worldinfo');
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
rmrf(ROOT);
fs.mkdirSync(ROOT, { recursive: true });

/* ---------- 最小 NBT 编码器 ---------- */
function wU8(n) { const b = Buffer.alloc(1); b.writeUInt8(n); return b; }
function wU16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function wI32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function wI64(n) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; }
function wF64(n) { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b; }
function wStr(s) { const sb = Buffer.from(String(s), 'utf8'); return Buffer.concat([wU16(sb.length), sb]); }
function tag(type, name, payload) { return Buffer.concat([wU8(type), wStr(name), payload]); }
function compoundPayload(entries) { return Buffer.concat(entries.concat([wU8(0)])); }
function comp(name, entries) { return tag(10, name, compoundPayload(entries)); }
function rootNbt(entries) { return Buffer.concat([wU8(10), wStr(''), compoundPayload(entries)]); }
function writeLevel(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'level.dat');
  fs.writeFileSync(p, zlib.gzipSync(rootNbt(entries)));
  return p;
}

const BIG_SEED = '-4172144997902289642';

/* ---------- 1. 真实 level.dat 结构：世界名 / 最后游玩 / 模式不再是「未知」 ---------- */
{
  const wd = path.join(ROOT, 'New World');
  writeLevel(wd, [
    comp('Data', [
      tag(8, 'LevelName', wStr('真实世界名')),
      tag(4, 'LastPlayed', wI64(1730000000000)),
      tag(4, 'Time', wI64(12000)),
      tag(4, 'DayTime', wI64(6000)),
      tag(3, 'DataVersion', wI32(3465)),
      tag(3, 'GameType', wI32(0)),
      tag(1, 'hardcore', wU8(0)),
      tag(1, 'Difficulty', wU8(2)),
      comp('Version', [tag(8, 'Name', wStr('1.20.1'))]),
      comp('WorldGenSettings', [tag(4, 'seed', wI64(BIG_SEED))]),
      comp('Player', [
        tag(9, 'Pos', Buffer.concat([wU8(6), wI32(3), wF64(10.5), wF64(64), wF64(-20.25)])),
        tag(8, 'Dimension', wStr('minecraft:overworld')),
        tag(3, 'XpLevel', wI32(7)),
      ]),
    ]),
  ]);
  const worlds = instance.listWorlds(ROOT);
  assert.strictEqual(worlds.length, 1);
  assert.strictEqual(worlds[0].folder, 'New World');
  assert.strictEqual(worlds[0].name, '真实世界名', '旧代码按顶层取 LevelName 会退回文件夹名');
  assert.strictEqual(worlds[0].lastPlayed, 1730000000000);
  assert.strictEqual(worlds[0].gameTypeName, '生存');
  assert.strictEqual(worlds[0].hardcore, false);

  const info = instance.worldInfo(ROOT, 'New World');
  assert.strictEqual(info.ok, true);
  assert.strictEqual(info.hasLevelDat, true);
  assert.strictEqual(info.hasIcon, false);
  assert.strictEqual(info.summary.name, '真实世界名');
  assert.strictEqual(info.summary.seedText, BIG_SEED, '64 位种子必须按文本精确保留');
  assert.strictEqual(info.summary.gameSeconds, 600);
  assert.strictEqual(info.summary.versionName, '1.20.1');
  assert.strictEqual(info.summary.dataVersion, 3465);
  assert.strictEqual(info.summary.difficulty, 2);
  assert.deepStrictEqual(info.summary.player.pos, [10.5, 64, -20.25]);
  assert.strictEqual(info.summary.player.dimension, 'minecraft:overworld');
  assert.strictEqual(info.summary.player.xpLevel, 7);
}

/* ---------- 2. 硬边界：只读，不写世界文件、不生成状态文件 ---------- */
{
  const p = path.join(ROOT, 'New World', 'level.dat');
  const before = fs.readFileSync(p);
  const mtime = fs.statSync(p).mtimeMs;
  instance.worldInfo(ROOT, 'New World');
  instance.listWorlds(ROOT);
  assert.ok(fs.readFileSync(p).equals(before), 'level.dat 内容不得被改动');
  assert.strictEqual(fs.statSync(p).mtimeMs, mtime, 'level.dat 修改时间不得变化');
  assert.deepStrictEqual(fs.readdirSync(ROOT), ['New World'], '不得生成任何额外文件');
}

/* ---------- 3. 图标 / 缺 level.dat / 损坏文件：安全降级不抛异常 ---------- */
{
  fs.writeFileSync(path.join(ROOT, 'New World', 'icon.png'), Buffer.from([1, 2, 3]));
  assert.strictEqual(instance.worldInfo(ROOT, 'New World').hasIcon, true);

  fs.mkdirSync(path.join(ROOT, 'Empty'), { recursive: true });
  const r1 = instance.worldInfo(ROOT, 'Empty');
  assert.strictEqual(r1.ok, false);
  assert.ok(!r1.summary);
  assert.ok(/level\.dat/.test(r1.error));

  fs.mkdirSync(path.join(ROOT, 'Broken'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'Broken', 'level.dat'), Buffer.from('not gzip at all'));
  const r2 = instance.worldInfo(ROOT, 'Broken');
  assert.strictEqual(r2.ok, false);
  assert.ok(!r2.summary);
  assert.ok(typeof r2.error === 'string' && r2.error.length > 0);
}

/* ---------- 4. 目录名安全：穿越 / 绝对路径 / 空值一律拒绝 ---------- */
{
  ['..', '.', '../outside', '..\\outside', '/etc', 'C:\\Windows', 'a/b', 'a\\b', 'a:b', '', '  ', 'x\0y']
    .forEach((f) => {
      const r = instance.worldInfo(ROOT, f);
      assert.strictEqual(r.ok, false, '应拒绝目录名：' + JSON.stringify(f));
    });
  assert.strictEqual(instance.worldInfo(ROOT, undefined).ok, false);
  assert.strictEqual(instance.worldInfo(ROOT, null).ok, false);
  assert.strictEqual(instance.worldInfo(ROOT, '不存在的世界').ok, false);
}

/* ---------- 5. 扁平旧结构（旧版 / 旧测试样本）仍兼容 ---------- */
{
  writeLevel(path.join(ROOT, 'OldFlat'), [
    tag(8, 'LevelName', wStr('扁平旧档')),
    tag(4, 'LastPlayed', wI64(1600000000000)),
    tag(3, 'GameType', wI32(1)),
    tag(4, 'RandomSeed', wI64(42)),
  ]);
  const w = instance.listWorlds(ROOT).find((x) => x.folder === 'OldFlat');
  assert.ok(w);
  assert.strictEqual(w.name, '扁平旧档');
  assert.strictEqual(w.gameTypeName, '创造');
  assert.strictEqual(w.lastPlayed, 1600000000000);
  assert.strictEqual(instance.worldInfo(ROOT, 'OldFlat').summary.seedText, '42');
}

rmrf(ROOT);
console.log('worldinfo.test.js 全部通过 \u2713');
