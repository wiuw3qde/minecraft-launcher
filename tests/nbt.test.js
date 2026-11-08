'use strict';
/* S0 共用底座：NBT 解析 / level.dat 摘要测试（含损坏输入、跨版本字段路径） */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const nbt = require('../src/nbt');
const instance = require('../src/instance');

const ROOT = path.join(__dirname, 'tmp', 'nbt');
fs.mkdirSync(ROOT, { recursive: true });
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
rmrf(ROOT);
fs.mkdirSync(ROOT, { recursive: true });

/* ---------- 最小 NBT 编码器（大端），用于造测试数据 ---------- */
function wU8(n) { const b = Buffer.alloc(1); b.writeUInt8(n); return b; }
function wU16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function wI16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function wI32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function wI64(n) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; }
function wF32(n) { const b = Buffer.alloc(4); b.writeFloatBE(n); return b; }
function wF64(n) { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b; }
function wStr(s) { const sb = Buffer.from(String(s), 'utf8'); return Buffer.concat([wU16(sb.length), sb]); }
function tag(type, name, payload) { return Buffer.concat([wU8(type), wStr(name), payload]); }
function compoundPayload(entries) { return Buffer.concat(entries.concat([wU8(0)])); }
function comp(name, entries) { return tag(10, name, compoundPayload(entries)); }
function rootNbt(entries) { return Buffer.concat([wU8(10), wStr(''), compoundPayload(entries)]); }
function writeLevel(name, entries) {
  const p = path.join(ROOT, name);
  fs.writeFileSync(p, zlib.gzipSync(rootNbt(entries)));
  return p;
}

/* ---------- 1. 全 TAG 类型解析 ---------- */
{
  const buf = rootNbt([
    tag(1, 'Byte', wU8(7)),
    tag(2, 'Short', wI16(-1234)),
    tag(3, 'Int', wI32(123456)),
    tag(4, 'Long', wI64(9007199254740000)),
    tag(5, 'Float', wF32(1.5)),
    tag(6, 'Double', wF64(2.75)),
    tag(7, 'Bytes', Buffer.concat([wI32(3), Buffer.from([1, 2, 3])])),
    tag(8, 'Str', wStr('你好 MC')),
    tag(9, 'List', Buffer.concat([wU8(3), wI32(2), wI32(10), wI32(20)])),
    tag(10, 'Nested', compoundPayload([tag(8, 'Key', wStr('Value'))])),
    tag(11, 'Ints', Buffer.concat([wI32(2), wI32(5), wI32(6)])),
    tag(12, 'Longs', Buffer.concat([wI32(2), wI64(8), wI64(9)])),
  ]);
  const o = nbt.parseNbt(buf);
  assert.strictEqual(o.Byte, 7);
  assert.strictEqual(o.Short, -1234);
  assert.strictEqual(o.Int, 123456);
  assert.strictEqual(typeof o.Long, 'number');
  assert.strictEqual(o.Float, 1.5);
  assert.strictEqual(o.Double, 2.75);
  assert.ok(Buffer.isBuffer(o.Bytes) && o.Bytes.toString('hex') === '010203');
  assert.strictEqual(o.Str, '你好 MC');
  assert.deepStrictEqual(o.List, [10, 20]);
  assert.strictEqual(o.Nested.Key, 'Value');
  assert.deepStrictEqual(o.Ints, [5, 6]);
  assert.deepStrictEqual(o.Longs, [8, 9]);
}

/* ---------- 2. 损坏 / 恶意输入安全降级 ---------- */
{
  assert.throws(() => nbt.parseNbt(Buffer.alloc(0)));
  assert.throws(() => nbt.parseNbt(Buffer.from([10, 0, 0]))); // 根名截断
  assert.throws(() => nbt.parseNbt(Buffer.from([99, 0, 0]))); // 非法 TAG
  assert.throws(() => nbt.parseNbt(Buffer.concat([wU8(10), wStr(''), wU8(3), wStr('N'), Buffer.from([1])]))); // Int 只剩 1 字节
  assert.throws(() => nbt.parseNbt(Buffer.concat([wU8(10), wStr(''), wU8(8), wStr('S'), wU16(999999)]))); // 字符串超限
  assert.throws(() => nbt.parseNbt(Buffer.concat([wU8(10), wStr(''), wU8(7), wStr('B'), wI32(999999999)]))); // 数组长度异常
  // 嵌套过深
  let deep = wU8(0);
  for (let i = 0; i < 40; i++) deep = Buffer.concat([wU8(10), wStr('x'), deep]);
  assert.throws(() => nbt.parseNbt(Buffer.concat([wU8(10), wStr(''), Buffer.concat([wU8(10), wStr('r'), deep])])));
  // readLevelDat / readLevelSummary 不抛异常
  fs.writeFileSync(path.join(ROOT, 'broken.dat'), Buffer.from('not gzip'));
  assert.strictEqual(nbt.readLevelDat(path.join(ROOT, 'broken.dat')), null);
  assert.strictEqual(nbt.readLevelSummary(path.join(ROOT, 'missing.dat')).ok, false);
}

/* ---------- 3. 新版 level.dat 摘要（Data 下带 Version / WorldGenSettings / Player） ---------- */
{
  const p = writeLevel('new.dat', [
    comp('Data', [
      tag(8, 'LevelName', wStr('测试世界')),
      tag(3, 'DataVersion', wI32(3465)),
      tag(4, 'LastPlayed', wI64(1730000000000)),
      tag(4, 'Time', wI64(12000)),       // 600 秒
      tag(4, 'DayTime', wI64(6000)),
      tag(3, 'GameType', wI32(0)),
      tag(1, 'hardcore', wU8(0)),
      tag(1, 'allowCommands', wU8(1)),
      tag(1, 'Difficulty', wU8(2)),
      comp('Version', [tag(8, 'Name', wStr('1.20.1')), tag(8, 'Id', wStr('1.20.1'))]),
      comp('WorldGenSettings', [tag(4, 'seed', wI64(123456789))]),
      comp('Player', [
        tag(9, 'Pos', Buffer.concat([wU8(6), wI32(3), wF64(10.5), wF64(64.0), wF64(-20.25)])),
        tag(8, 'Dimension', wStr('minecraft:overworld')),
        tag(5, 'Health', wF32(20)),
        tag(3, 'XpLevel', wI32(7)),
        tag(3, 'foodLevel', wI32(18)),
        tag(3, 'SpawnX', wI32(0)), tag(3, 'SpawnY', wI32(64)), tag(3, 'SpawnZ', wI32(0)),
      ]),
    ]),
  ]);
  const r = nbt.readLevelSummary(p);
  assert.strictEqual(r.ok, true);
  const s = r.summary;
  assert.strictEqual(s.name, '测试世界');
  assert.strictEqual(s.dataVersion, 3465);
  assert.strictEqual(s.lastPlayed, 1730000000000);
  assert.strictEqual(s.gameTicks, 12000);
  assert.strictEqual(s.gameSeconds, 600);
  assert.strictEqual(s.seed, 123456789);
  assert.strictEqual(s.versionName, '1.20.1');
  assert.strictEqual(s.gameType, 0);
  assert.strictEqual(s.hardcore, false);
  assert.strictEqual(s.allowCommands, true);
  assert.deepStrictEqual(s.player.pos, [10.5, 64, -20.25]);
  assert.strictEqual(s.player.dimension, 'minecraft:overworld');
  assert.strictEqual(s.player.health, 20);
  assert.strictEqual(s.player.xpLevel, 7);
  assert.deepStrictEqual(s.player.spawn, [0, 64, 0]);
}

/* ---------- 4. 旧版 / 缺字段：降级为 null，不抛异常 ---------- */
{
  const p = writeLevel('old.dat', [
    tag(8, 'LevelName', wStr('老世界')),
    tag(4, 'LastPlayed', wI64(1600000000000)),
    tag(3, 'GameType', wI32(1)),
    tag(4, 'RandomSeed', wI64(42)),
  ]);
  const s = nbt.readLevelSummary(p).summary;
  assert.strictEqual(s.name, '老世界');
  assert.strictEqual(s.dataVersion, null);
  assert.strictEqual(s.gameTicks, null);
  assert.strictEqual(s.gameSeconds, null);
  assert.strictEqual(s.seed, 42); // 旧版 RandomSeed 路径
  assert.strictEqual(s.versionName, null);
  assert.strictEqual(s.player.pos, null);
  assert.strictEqual(s.player.dimension, null);
  assert.deepStrictEqual(nbt.summarizeLevel(null).player.pos, null);
}

/* ---------- 5. 兼容性：instance.readLevelDat 仍走同一解析器 ---------- */
{
  const p = writeLevel('compat.dat', [tag(8, 'LevelName', wStr('兼容世界'))]);
  assert.strictEqual(instance.readLevelDat(p).LevelName, '兼容世界');
  assert.strictEqual(typeof instance.parseNbt, 'function');
  // 回归：instance.js 改用 nbt.js 后，listWorlds 仍能正确读到 level.dat
  const wd = path.join(ROOT, 'World1');
  fs.mkdirSync(wd, { recursive: true });
  fs.copyFileSync(p, path.join(wd, 'level.dat'));
  const worlds = instance.listWorlds(ROOT);
  assert.strictEqual(worlds.length, 1, '只应列出 World1 这个目录');
  assert.strictEqual(worlds[0].folder, 'World1');
  assert.strictEqual(worlds[0].name, '兼容世界');
}

rmrf(ROOT);
console.log('nbt.test.js 全部通过 ✓');
