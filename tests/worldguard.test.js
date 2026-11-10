'use strict';
/* S2 / N3：跨版本开档守卫（评估 / 快照 / 复制 / 记录 + 只读硬边界） */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const worldguard = require('../src/worldguard');
const instance = require('../src/instance');

const ROOT = path.join(__dirname, 'tmp', 'worldguard');
const GAME = path.join(ROOT, '.minecraft');
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
rmrf(ROOT);
fs.mkdirSync(path.join(GAME, 'saves', 'Survival'), { recursive: true });

/* ---------- 最小 NBT 编码器 ---------- */
function wU8(n) { const b = Buffer.alloc(1); b.writeUInt8(n); return b; }
function wU16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function wI32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function wI64(n) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; }
function wStr(s) { const sb = Buffer.from(String(s), 'utf8'); return Buffer.concat([wU16(sb.length), sb]); }
function tag(type, name, payload) { return Buffer.concat([wU8(type), wStr(name), payload]); }
function compoundPayload(entries) { return Buffer.concat(entries.concat([wU8(0)])); }
function comp(name, entries) { return tag(10, name, compoundPayload(entries)); }
function rootNbt(entries) { return Buffer.concat([wU8(10), wStr(''), compoundPayload(entries)]); }
const LEVEL = path.join(GAME, 'saves', 'Survival', 'level.dat');
fs.writeFileSync(LEVEL, zlib.gzipSync(rootNbt([
  comp('Data', [
    tag(8, 'LevelName', wStr('生存世界')),
    tag(3, 'DataVersion', wI32(3465)),
    tag(4, 'LastPlayed', wI64(1730000000000)),
    tag(3, 'GameType', wI32(0)),
  ]),
])));
const levelBefore = fs.readFileSync(LEVEL);
const levelMtime = fs.statSync(LEVEL).mtimeMs;

/* ---------- 1. 首次评估：中性提示、无风险、纯只读 ---------- */
const ev1 = worldguard.evaluate({ gameDir: GAME, versionId: '1.20.1', isolated: false });
assert.strictEqual(ev1.ok, true);
assert.strictEqual(ev1.items.length, 1);
assert.strictEqual(ev1.items[0].folder, 'Survival');
assert.strictEqual(ev1.items[0].name, '生存世界', '真实 Data 结构要能读到世界名');
assert.strictEqual(ev1.items[0].dataVersion, 3465);
assert.strictEqual(ev1.items[0].kind, 'first');
assert.strictEqual(ev1.items[0].risk, 'none');
assert.strictEqual(ev1.risky.length, 0);
assert.ok(fs.readFileSync(LEVEL).equals(levelBefore), '评估不得改动 level.dat');
assert.strictEqual(fs.statSync(LEVEL).mtimeMs, levelMtime, '评估不得改动 level.dat 时间戳');
assert.ok(!fs.existsSync(ev1.statePath), '评估阶段不得生成状态文件');

/* ---------- 2. 记录后：同版本 same；换版本 high ---------- */
assert.strictEqual(worldguard.record(ev1.statePath, ev1.items), 1);
assert.ok(fs.existsSync(ev1.statePath), 'record 才写状态文件');
assert.ok(fs.readFileSync(LEVEL).equals(levelBefore), 'record 也不得改动世界文件');

const ev2 = worldguard.evaluate({ gameDir: GAME, versionId: '1.20.1', isolated: false });
assert.strictEqual(ev2.items[0].kind, 'same');
assert.strictEqual(ev2.risky.length, 0);

const ev3 = worldguard.evaluate({ gameDir: GAME, versionId: '1.21.1', isolated: false });
assert.strictEqual(ev3.items[0].kind, 'version-changed');
assert.strictEqual(ev3.items[0].risk, 'high');
assert.strictEqual(ev3.risky.length, 1);
assert.ok(/1\.20\.1/.test(ev3.items[0].message) && /1\.21\.1/.test(ev3.items[0].message));

/* ---------- 3. 快照：生成 zip，原世界不变 ---------- */
const snaps = worldguard.snapshot(ev3.savesDir, ev3.risky.map((i) => i.folder));
assert.strictEqual(snaps.length, 1);
assert.strictEqual(snaps[0].ok, true);
assert.ok(fs.existsSync(snaps[0].dest) && /\.zip$/.test(snaps[0].dest));
assert.ok(fs.readFileSync(LEVEL).equals(levelBefore), '快照不得改动 level.dat');

/* ---------- 4. 复制升级前副本：目录存在且含 level.dat ---------- */
const copies = worldguard.copy(ev3.savesDir, ev3.risky.map((i) => i.folder));
assert.strictEqual(copies.length, 1);
assert.strictEqual(copies[0].ok, true);
assert.ok(/-升级前-/.test(copies[0].folder));
assert.ok(fs.existsSync(path.join(ev3.savesDir, copies[0].folder, 'level.dat')));
assert.ok(fs.readFileSync(LEVEL).equals(levelBefore), '复制不得改动原世界');

/* ---------- 5. 目录穿越 / 非法名拒绝 ---------- */
['..', '.', '../x', '..\\x', '/etc', 'C:\\Windows', 'a/b', 'a:b', ''].forEach((f) => {
  assert.strictEqual(instance.copyWorld(ev3.savesDir, f).ok, false, 'copyWorld 应拒绝：' + JSON.stringify(f));
  assert.strictEqual(worldguard.copy(ev3.savesDir, [f])[0].ok, false);
});
assert.strictEqual(instance.safeFolderName('正常世界'), '正常世界');
assert.strictEqual(instance.safeFolderName('..'), null);

/* ---------- 6. 缺参数 / 隔离目录：安全降级，不抛异常 ---------- */
const bad = worldguard.evaluate({ gameDir: '', versionId: '' });
assert.strictEqual(bad.ok, false);
assert.deepStrictEqual(bad.items, []);
const iso = worldguard.evaluate({ gameDir: GAME, versionId: '1.20.1', isolated: true });
assert.strictEqual(iso.ok, true);
assert.deepStrictEqual(iso.items, [], '隔离目录不存在时应返回空列表而不是报错');
assert.ok(iso.savesDir.includes('instances'));

rmrf(ROOT);
console.log('worldguard.test.js 全部通过 \u2713');
