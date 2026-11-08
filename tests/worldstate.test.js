'use strict';
/* S0 共用底座：世界状态 / 跨版本相对判据测试 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ws = require('../src/worldstate');

const ROOT = path.join(__dirname, 'tmp', 'worldstate');
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
rmrf(ROOT);
fs.mkdirSync(ROOT, { recursive: true });
const statePath = path.join(ROOT, 'backups', 'auto', '_worldstate.json');

const base = { gameDir: 'G', folder: 'MyWorld', versionId: '1.20.1', dataVersion: 3465, levelName: '我的世界' };

/* 1. 首次记录不做风险判断 */
assert.strictEqual(ws.check(statePath, base).kind, 'first');
assert.strictEqual(ws.check(statePath, base).risk, 'none');

/* 2. 记录后同版本同 DataVersion → same */
ws.record(statePath, base);
assert.ok(fs.existsSync(statePath));
assert.strictEqual(ws.check(statePath, base).kind, 'same');
assert.strictEqual(ws.check(statePath, base).risk, 'none');

/* 3. 换版本 → version-changed 且高风险 */
const other = Object.assign({}, base, { versionId: '1.21.1' });
const c3 = ws.check(statePath, other);
assert.strictEqual(c3.kind, 'version-changed');
assert.strictEqual(c3.risk, 'high');
assert.ok(/1\.20\.1/.test(c3.message) && /1\.21\.1/.test(c3.message));
assert.strictEqual(c3.previous.versionId, '1.20.1');

/* 4. 同版本但 DataVersion 变化 → dataversion-changed */
ws.record(statePath, other);
const changed = Object.assign({}, other, { dataVersion: 3955 });
const c4 = ws.check(statePath, changed);
assert.strictEqual(c4.kind, 'dataversion-changed');
assert.strictEqual(c4.risk, 'high');

/* 5. DataVersion 读不到 → unknown，且绝不冒充 same */
const noData = Object.assign({}, base, { dataVersion: null });
assert.strictEqual(ws.check(statePath, noData).kind, 'unknown');
assert.strictEqual(ws.check(statePath, noData).risk, 'low');

/* 6. 不同世界互不干扰 */
assert.strictEqual(ws.check(statePath, Object.assign({}, base, { folder: 'Another' })).kind, 'first');

/* 7. 重复打开不刷历史 */
const st1 = ws.load(statePath);
const h1 = st1.history[ws.keyOf('G', 'MyWorld')].length;
ws.record(statePath, other);
ws.record(statePath, other);
const h2 = ws.load(statePath).history[ws.keyOf('G', 'MyWorld')].length;
assert.strictEqual(h2, h1, '相同版本+相同 DataVersion 不应重复写历史');

/* 8. 状态文件损坏时安全视为空，不抛异常 */
fs.writeFileSync(statePath, '{ broken json');
assert.strictEqual(ws.check(statePath, base).kind, 'first');
assert.strictEqual(ws.load(statePath).version, 1);

/* 9. forget 清理 */
ws.record(statePath, base);
assert.ok(ws.load(statePath).worlds[ws.keyOf('G', 'MyWorld')]);
assert.strictEqual(ws.forget(statePath, 'G', 'MyWorld'), true);
assert.strictEqual(ws.forget(statePath, 'G', 'MyWorld'), false);

/* 10. 硬边界：只写状态文件，绝不碰世界文件 */
const worldDir = path.join(ROOT, 'saves', 'MyWorld');
fs.mkdirSync(worldDir, { recursive: true });
const levelDat = path.join(worldDir, 'level.dat');
fs.writeFileSync(levelDat, Buffer.from('ORIGINAL'));
ws.record(statePath, Object.assign({}, base, { gameDir: path.join(ROOT, 'saves') }));
assert.strictEqual(fs.readFileSync(levelDat, 'utf8'), 'ORIGINAL');

/* 11. 原子写不残留 .tmp */
assert.strictEqual(fs.existsSync(statePath + '.tmp'), false);

rmrf(ROOT);
console.log('worldstate.test.js 全部通过 ✓');
