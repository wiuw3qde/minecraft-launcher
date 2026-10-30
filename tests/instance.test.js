'use strict';
/* 单版本实例管理测试：路径解析、模组、资源包、世界(NBT)、备份 zip、删除版本 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const instance = require('../src/instance');
const { parseZip } = require('../src/zip');

const ROOT = path.join(__dirname, 'tmp', 'instance');

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
}

/** 构造一个最小 gzipped NBT（大端），含 LevelName / LastPlayed / GameType，供 readLevelDat 解析 */
function makeLevelDat(obj) {
  function wU16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
  function wU32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
  function wI32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
  function wI64(n) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; }
  function wStr(s) { const sb = Buffer.from(s, 'utf8'); return Buffer.concat([wU16(sb.length), sb]); }
  function wValue(type, val) {
    if (type === 8) return wStr(val);
    if (type === 3) return wI32(val);
    if (type === 4) return wI64(val);
    if (type === 10) return wCompound(val);
    throw new Error('unsupported type ' + type);
  }
  function tag(type, name, val) {
    return Buffer.concat([Buffer.from([type]), wStr(name), wValue(type, val)]);
  }
  function wCompound(o) {
    const body = [];
    for (const k of Object.keys(o)) {
      const v = o[k];
      let t;
      if (typeof v === 'string') t = 8;
      else if (Number.isInteger(v)) t = (v > 2147483647 || v < -2147483648) ? 4 : 3;
      else if (v && typeof v === 'object') t = 10;
      body.push(tag(t, k, v));
    }
    return Buffer.concat(body.concat(Buffer.from([0])));
  }
  const buf = Buffer.concat([Buffer.from([10]), wStr(''), wCompound(obj)]);
  return zlib.gzipSync(buf);
}

(async () => {
  rmrf(ROOT);
  fs.mkdirSync(ROOT, { recursive: true });
  const GAME = path.join(ROOT, 'game');
  const ID = '1.20.1-test';

  // 1) 路径解析
  const pOff = instance.pathsFor(GAME, ID, false);
  assert.strictEqual(pOff.modsDir.replace(/\\/g, '/'), path.join(GAME, 'versions', ID, 'mods').replace(/\\/g, '/'), '未隔离 mods 路径');
  assert.strictEqual(pOff.savesDir.replace(/\\/g, '/'), path.join(GAME, 'saves').replace(/\\/g, '/'), '未隔离 saves 路径');
  const pOn = instance.pathsFor(GAME, ID, true);
  assert.strictEqual(pOn.modsDir.replace(/\\/g, '/'), path.join(GAME, 'instances', ID, 'mods').replace(/\\/g, '/'), '隔离 mods 路径');
  assert.strictEqual(pOn.savesDir.replace(/\\/g, '/'), path.join(GAME, 'instances', ID, 'saves').replace(/\\/g, '/'), '隔离 saves 路径');

  // 2) 模组列表 / 开关 / 删除
  fs.mkdirSync(pOff.modsDir, { recursive: true });
  fs.writeFileSync(path.join(pOff.modsDir, 'fabric-api.jar'), 'jar');
  let mods = instance.listMods(pOff.modsDir);
  assert.strictEqual(mods.length, 1, '应识别 1 个模组');
  assert.strictEqual(mods[0].enabled, true, '默认启用');
  const t = instance.toggleMod(pOff.modsDir, 'fabric-api.jar');
  assert.strictEqual(t.ok, true);
  assert.ok(fs.existsSync(path.join(pOff.modsDir, 'fabric-api.jar.disabled')), '已改名为 .disabled');
  mods = instance.listMods(pOff.modsDir);
  assert.strictEqual(mods[0].enabled, false, '应识别为禁用');
  instance.toggleMod(pOff.modsDir, 'fabric-api.jar.disabled');
  const d = instance.deleteFileSafe(pOff.modsDir, 'fabric-api.jar');
  assert.strictEqual(d.ok, true, '删除成功');
  assert.strictEqual(fs.existsSync(path.join(pOff.modsDir, 'fabric-api.jar')), false, '文件已删');

  // 3) 资源包列表 / 开关（options.txt）
  fs.mkdirSync(pOff.resourcepacksDir, { recursive: true });
  fs.mkdirSync(path.join(pOff.resourcepacksDir, 'MyPack'), { recursive: true });
  fs.writeFileSync(path.join(pOff.resourcepacksDir, 'x.zip'), 'zip');
  let packs = instance.listResourcePacks(pOff.resourcepacksDir, pOff.optionsTxt);
  assert.strictEqual(packs.length, 2, '应识别 2 个资源包');
  assert.ok(packs.every((p) => !p.enabled), '初始均未启用');
  instance.setResourcePackEnabled(pOff.optionsTxt, 'file/x.zip', true);
  instance.setResourcePackEnabled(pOff.optionsTxt, 'MyPack', true);
  packs = instance.listResourcePacks(pOff.resourcepacksDir, pOff.optionsTxt);
  const enabled = packs.filter((p) => p.enabled).map((p) => p.id).sort();
  assert.deepStrictEqual(enabled, ['MyPack', 'file/x.zip'], '两个均已启用');
  const optText = fs.readFileSync(pOff.optionsTxt, 'utf8');
  assert.ok(/resourcePacks:\[/.test(optText), 'options.txt 写入 resourcePacks');
  instance.setResourcePackEnabled(pOff.optionsTxt, 'file/x.zip', false);
  packs = instance.listResourcePacks(pOff.resourcepacksDir, pOff.optionsTxt);
  assert.strictEqual(packs.find((p) => p.id === 'file/x.zip').enabled, false, 'x.zip 已禁用');

  // 4) 世界列表 + level.dat NBT 解析
  const saves = pOff.savesDir;
  fs.mkdirSync(path.join(saves, 'emptyWorld'), { recursive: true });
  let worlds = instance.listWorlds(saves);
  assert.strictEqual(worlds.length, 1, '应识别 1 个世界');
  assert.strictEqual(worlds[0].name, 'emptyWorld', '无 level.dat 时用文件夹名');
  const wd = path.join(saves, 'realWorld');
  fs.mkdirSync(wd, { recursive: true });
  fs.writeFileSync(path.join(wd, 'level.dat'), makeLevelDat({ LevelName: '我的世界', LastPlayed: 1700000000000, GameType: 1 }));
  worlds = instance.listWorlds(saves);
  const real = worlds.find((w) => w.folder === 'realWorld');
  assert.strictEqual(real.name, '我的世界', 'NBT 解析出 LevelName');
  assert.strictEqual(real.lastPlayed, 1700000000000, 'NBT 解析出 LastPlayed');
  assert.strictEqual(real.gameTypeName, '创造', 'NBT 解析出 GameType=1');

  // 4b) 直接验证 parseNbt / readLevelDat
  const parsed = instance.readLevelDat(path.join(wd, 'level.dat'));
  assert.strictEqual(parsed.LevelName, '我的世界');
  assert.strictEqual(parsed.GameType, 1);

  // 5) 备份 zip（store）并可被解析
  fs.mkdirSync(pOff.versionDir, { recursive: true });
  fs.writeFileSync(path.join(pOff.versionDir, 'data.txt'), 'hello');
  const bak = instance.backupVersion(GAME, ID);
  assert.strictEqual(bak.ok, true, '备份成功');
  assert.ok(fs.existsSync(bak.dest), '备份文件存在');
  const z = parseZip(bak.dest);
  const names = z.entries.map((e) => e.name);
  assert.ok(names.some((n) => n.startsWith(ID + '/data.txt')), 'zip 内含版本数据');

  // 6) 删除版本（版本目录 + 实例目录）
  fs.mkdirSync(pOn.instanceDir, { recursive: true });
  fs.writeFileSync(path.join(pOn.instanceDir, 'x.txt'), 'x');
  const del = instance.deleteVersion(GAME, ID);
  assert.strictEqual(del.ok, true);
  assert.ok(!fs.existsSync(pOff.versionDir), '版本目录已删');
  assert.ok(!fs.existsSync(pOn.instanceDir), '实例目录已删');

  console.log('instance.test.js 全部通过 ✓');
  rmrf(ROOT);
})().catch((e) => {
  console.error('instance.test.js 失败:', e);
  rmrf(ROOT);
  process.exit(1);
});
