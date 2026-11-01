'use strict';
/* 单版本实例管理：路径解析、模组 / 世界 / 资源包 / 截图、备份(zip)、删除版本。
 * 全部为纯本地文件系统操作，不联网。
 *
 * 隔离模型：
 *  - 未隔离：模组 versions/<id>/mods；存档 / 材质 / 选项 / 截图 在根 .minecraft（与其他版本共用）
 *  - 隔离：上述内容全部移入 instances/<id>/（独立游戏目录），启动时用 --gameDir 指向它
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ============ 路径解析 ============ */

function instanceDirFor(gameDir, versionId) {
  return path.join(gameDir, 'instances', versionId);
}

function modsDirFor(gameDir, versionId, isolated) {
  return isolated
    ? path.join(instanceDirFor(gameDir, versionId), 'mods')
    : path.join(gameDir, 'versions', versionId, 'mods');
}

function savesDirFor(gameDir, versionId, isolated) {
  return isolated
    ? path.join(instanceDirFor(gameDir, versionId), 'saves')
    : path.join(gameDir, 'saves');
}

function resourcepacksDirFor(gameDir, versionId, isolated) {
  return isolated
    ? path.join(instanceDirFor(gameDir, versionId), 'resourcepacks')
    : path.join(gameDir, 'resourcepacks');
}

function screenshotsDirFor(gameDir, versionId, isolated) {
  return isolated
    ? path.join(instanceDirFor(gameDir, versionId), 'screenshots')
    : path.join(gameDir, 'screenshots');
}

function optionsTxtFor(gameDir, versionId, isolated) {
  return isolated
    ? path.join(instanceDirFor(gameDir, versionId), 'options.txt')
    : path.join(gameDir, 'options.txt');
}

/** 一次算出该版本的全部有效目录，供详情页与模组安装页复用 */
function pathsFor(gameDir, versionId, isolated) {
  const instanceDir = instanceDirFor(gameDir, versionId);
  return {
    versionDir: path.join(gameDir, 'versions', versionId),
    instanceDir,
    isolated: !!isolated,
    modsDir: modsDirFor(gameDir, versionId, isolated),
    savesDir: savesDirFor(gameDir, versionId, isolated),
    resourcepacksDir: resourcepacksDirFor(gameDir, versionId, isolated),
    screenshotsDir: screenshotsDirFor(gameDir, versionId, isolated),
    optionsTxt: optionsTxtFor(gameDir, versionId, isolated),
  };
}

/* ============ 通用工具 ============ */

function dirSize(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      const fp = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(fp);
        else if (e.isFile()) total += fs.statSync(fp).size;
      } catch (err) {
        /* 忽略无权访问的文件 */
      }
    }
  }
  return total;
}

function fmtSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB';
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
  if (bytes >= 1 << 10) return (bytes / (1 << 10)).toFixed(1) + ' KB';
  return bytes + ' B';
}

/* ============ 模组管理 ============ */

function listMods(modsDir) {
  if (!modsDir || !fs.existsSync(modsDir)) return [];
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(modsDir);
  } catch (e) {
    return [];
  }
  for (const f of entries) {
    const fp = path.join(modsDir, f);
    let st;
    try {
      st = fs.statSync(fp);
    } catch (e) {
      continue;
    }
    if (!st.isFile() || f.startsWith('.')) continue;
    let enabled = true;
    let base = f;
    if (f.endsWith('.disabled')) {
      enabled = false;
      base = f.slice(0, -'.disabled'.length);
    } else if (f.endsWith('.jar') || f.endsWith('.zip')) {
      enabled = true;
    } else {
      continue; // 只认 jar / zip
    }
    // 去掉 .jar / .zip 后缀显示更干净
    const display = base.replace(/\.(jar|zip)$/i, '');
    out.push({ name: f, display, enabled, size: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true }));
  return out;
}

function toggleMod(modsDir, name) {
  const fp = path.join(modsDir, name);
  if (!fs.existsSync(fp)) return { ok: false, error: '文件不存在：' + name };
  let target;
  if (name.endsWith('.disabled')) target = name.slice(0, -'.disabled'.length);
  else target = name + '.disabled';
  if (fs.existsSync(path.join(modsDir, target))) return { ok: false, error: '目标文件已存在：' + target };
  fs.renameSync(fp, path.join(modsDir, target));
  return { ok: true, name: target, enabled: !name.endsWith('.disabled') };
}

function deleteFileSafe(parentDir, name) {
  const fp = path.join(parentDir, name);
  if (!fs.existsSync(fp)) return { ok: false, error: '文件不存在：' + name };
  fs.unlinkSync(fp);
  return { ok: true };
}

/* ============ 世界管理（level.dat NBT 解析） ============ */

/** 极简 NBT 解析（大端），仅取顶层 compound 下字段，足够读 level.dat */
function parseNbt(buf) {
  let pos = 0;
  function readString() {
    const len = buf.readUInt16BE(pos);
    pos += 2;
    const s = buf.slice(pos, pos + len).toString('utf8');
    pos += len;
    return s;
  }
  function readValue(type) {
    switch (type) {
      case 0:
        return null;
      case 1:
        { const v = buf.readInt8(pos); pos += 1; return v; }
      case 2:
        { const v = buf.readInt16BE(pos); pos += 2; return v; }
      case 3:
        { const v = buf.readInt32BE(pos); pos += 4; return v; }
      case 4:
        { const v = Number(buf.readBigInt64BE(pos)); pos += 8; return v; }
      case 5:
        { const v = buf.readFloatBE(pos); pos += 4; return v; }
      case 6:
        { const v = buf.readDoubleBE(pos); pos += 8; return v; }
      case 7:
        { const len = buf.readInt32BE(pos); pos += 4; const a = buf.slice(pos, pos + len); pos += len; return a; }
      case 8:
        return readString();
      case 9:
        {
          const et = buf.readUInt8(pos); pos += 1;
          const len = buf.readInt32BE(pos); pos += 4;
          const arr = [];
          for (let i = 0; i < len; i++) arr.push(readValue(et));
          return arr;
        }
      case 10:
        {
          const obj = {};
          while (true) {
            const t = buf.readUInt8(pos); pos += 1;
            if (t === 0) break;
            const name = readString();
            obj[name] = readValue(t);
          }
          return obj;
        }
      case 11:
        { const len = buf.readInt32BE(pos); pos += 4; const arr = []; for (let i = 0; i < len; i++) { arr.push(buf.readInt32BE(pos)); pos += 4; } return arr; }
      case 12:
        { const len = buf.readInt32BE(pos); pos += 4; const arr = []; for (let i = 0; i < len; i++) { arr.push(Number(buf.readBigInt64BE(pos))); pos += 8; } return arr; }
      default:
        throw new Error('不支持的 NBT 标签：' + type);
    }
  }
  const rootType = buf.readUInt8(pos); pos += 1;
  readString(); // 根名（通常 "")
  return readValue(rootType);
}

const GAME_TYPES = { 0: '生存', 1: '创造', 2: '冒险', 3: '旁观' };

function readLevelDat(filePath) {
  const raw = zlib.gunzipSync(fs.readFileSync(filePath));
  return parseNbt(raw);
}

function listWorlds(savesDir) {
  if (!savesDir || !fs.existsSync(savesDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(savesDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const wd = path.join(savesDir, e.name);
    let st;
    try {
      st = fs.statSync(wd);
    } catch (err) {
      continue;
    }
    let info = {};
    const levelDat = path.join(wd, 'level.dat');
    if (fs.existsSync(levelDat)) {
      try {
        info = readLevelDat(levelDat) || {};
      } catch (err) {
        info = {};
      }
    }
    out.push({
      folder: e.name,
      name: info.LevelName || e.name,
      lastPlayed: typeof info.LastPlayed === 'number' ? info.LastPlayed : 0,
      gameType: typeof info.GameType === 'number' ? info.GameType : null,
      gameTypeName: GAME_TYPES[info.GameType] || '',
      hardcore: !!info.hardcore,
      size: dirSize(wd),
      mtime: st.mtimeMs,
    });
  }
  out.sort((a, b) => (b.lastPlayed || b.mtime) - (a.lastPlayed || a.mtime));
  return out;
}

/* ============ 资源包管理（读写 options.txt） ============ */

function readOptions(optionsTxt) {
  const data = { lines: [], map: {} };
  if (!fs.existsSync(optionsTxt)) return data;
  const text = fs.readFileSync(optionsTxt, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) {
      if (line.trim()) data.lines.push(line);
      continue;
    }
    const key = line.slice(0, idx);
    const val = line.slice(idx + 1);
    data.map[key] = val;
    data.lines.push({ key, val });
  }
  return data;
}

function writeOptions(optionsTxt, data) {
  fs.mkdirSync(path.dirname(optionsTxt), { recursive: true });
  const lines = data.lines.map((l) => (typeof l === 'string' ? l : `${l.key}:${l.val}`));
  fs.writeFileSync(optionsTxt, lines.join('\n') + '\n', 'utf8');
}

/** 返回已启用的资源包 id 数组（options.txt 的 resourcePacks JSON） */
function enabledResourcePackIds(optionsTxt) {
  const data = readOptions(optionsTxt);
  const raw = data.map.resourcePacks;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function listResourcePacks(rpDir, optionsTxt) {
  const enabledIds = enabledResourcePackIds(optionsTxt);
  if (!rpDir || !fs.existsSync(rpDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(rpDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const fp = path.join(rpDir, e.name);
    let st;
    try {
      st = fs.statSync(fp);
    } catch (err) {
      continue;
    }
    let id = null;
    if (e.isDirectory()) id = e.name;
    else if (e.isFile() && e.name.endsWith('.zip')) id = 'file/' + e.name;
    else continue;
    out.push({
      name: e.name,
      id,
      enabled: enabledIds.includes(id),
      size: st.isDirectory() ? dirSize(fp) : st.size,
    });
  }
  out.sort((a, b) => (b.enabled - a.enabled) || a.name.localeCompare(b.name));
  return out;
}

function setResourcePackEnabled(optionsTxt, id, enable) {
  const data = readOptions(optionsTxt);
  let arr = enabledResourcePackIds(optionsTxt);
  const has = arr.includes(id);
  if (enable && !has) arr.push(id);
  if (!enable && has) arr = arr.filter((x) => x !== id);
  const newVal = JSON.stringify(arr);
  const existing = data.lines.find((l) => typeof l === 'object' && l.key === 'resourcePacks');
  if (existing) existing.val = newVal;
  else data.lines.push({ key: 'resourcePacks', val: newVal });
  writeOptions(optionsTxt, data);
  return { ok: true, enabled: enable };
}

/* ============ 截图管理 ============ */

function listScreenshots(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.png$/i.test(e.name)) continue;
    const fp = path.join(dir, e.name);
    let st;
    try {
      st = fs.statSync(fp);
    } catch (err) {
      continue;
    }
    out.push({ name: e.name, size: st.size, mtime: st.mtimeMs, path: fp });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/* ============ 备份（纯 Node store-zip，无第三方依赖） ============ */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function collectDirEntries(root, prefix, out) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const arc = (prefix ? prefix + '/' : '') + e.name;
    const fp = path.join(root, e.name);
    let st;
    try {
      st = fs.statSync(fp);
    } catch (err) {
      continue;
    }
    if (st.isDirectory()) {
      collectDirEntries(fp, arc, out);
    } else if (st.isFile()) {
      out.push({ arcName: arc, data: fs.readFileSync(fp) });
    }
  }
}

function zipWrite(entries, outZip) {
  const localParts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.arcName, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method 0 = store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

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
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  fs.writeFileSync(outZip, Buffer.concat([].concat(localParts, centralBuf, eocd)));
  return outZip;
}

function zipFolder(srcDir, outZip) {
  const entries = [];
  if (fs.existsSync(srcDir)) collectDirEntries(srcDir, '', entries);
  zipWrite(entries, outZip);
  return outZip;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupVersion(gameDir, versionId) {
  const versionDir = path.join(gameDir, 'versions', versionId);
  const instanceDir = instanceDirFor(gameDir, versionId);
  const outDir = path.join(gameDir, 'backups');
  const outZip = path.join(outDir, `${versionId}-${timestamp()}.zip`);
  const entries = [];
  if (fs.existsSync(versionDir)) collectDirEntries(versionDir, versionId, entries);
  if (fs.existsSync(instanceDir)) collectDirEntries(instanceDir, versionId + '-data', entries);
  if (!entries.length) return { ok: false, error: '没有可备份的内容（版本或实例目录为空）' };
  zipWrite(entries, outZip);
  return { ok: true, dest: outZip };
}

function backupWorld(savesDir, folder) {
  const worldDir = path.join(savesDir, folder);
  if (!fs.existsSync(worldDir)) return { ok: false, error: '世界不存在：' + folder };
  const outDir = path.join(savesDir, '..', 'backups', 'worlds');
  const outZip = path.join(outDir, `${folder}-${timestamp()}.zip`);
  zipFolder(worldDir, outZip);
  return { ok: true, dest: outZip };
}

/* ============ 自动备份（按间隔，专属目录 backups/auto/<版本id>/） ============ */
function autoBackupRoot(gameDir) {
  return path.join(gameDir, 'backups', 'auto');
}
function autoVersionDir(gameDir, versionId) {
  return path.join(autoBackupRoot(gameDir), versionId);
}
function parseTs(name) {
  const m = /(\d{8}-\d{6})\.zip$/i.exec(name || '');
  return m ? m[1] : '';
}
// 执行一次自动备份；scope='version' 整版本快照，否则逐个世界打包
function autoBackup(gameDir, versionId, isolated, scope) {
  const root = autoVersionDir(gameDir, versionId);
  const results = [];
  if (scope === 'version') {
    const versionDir = path.join(gameDir, 'versions', versionId);
    const instanceDir = instanceDirFor(gameDir, versionId);
    const entries = [];
    if (fs.existsSync(versionDir)) collectDirEntries(versionDir, versionId, entries);
    if (fs.existsSync(instanceDir)) collectDirEntries(instanceDir, versionId + '-data', entries);
    if (!entries.length) return { ok: false, error: '没有可备份的内容（版本或实例目录为空）' };
    const outZip = path.join(root, 'version-' + timestamp() + '.zip');
    zipWrite(entries, outZip);
    return { ok: true, results: [{ ok: true, dest: outZip, scope: 'version' }] };
  }
  const savesDir = savesDirFor(gameDir, versionId, isolated);
  const worlds = listWorlds(savesDir);
  if (!worlds.length) return { ok: false, error: '该版本没有世界' };
  const worldOut = path.join(root, 'worlds');
  for (const w of worlds) {
    const worldDir = path.join(savesDir, w.folder);
    const outZip = path.join(worldOut, w.folder + '-' + timestamp() + '.zip');
    try {
      zipFolder(worldDir, outZip);
      results.push({ ok: true, dest: outZip, scope: 'world', folder: w.folder });
    } catch (e) {
      results.push({ ok: false, error: e.message, folder: w.folder });
    }
  }
  return { ok: results.some((r) => r.ok), results };
}
// 列出某版本自动备份：{ worlds:[{path,file,ts,size,folder}], versions:[{path,file,ts,size}] }
function listAutoBackups(gameDir, versionId) {
  const root = autoVersionDir(gameDir, versionId);
  const out = { worlds: [], versions: [] };
  const worldDir = path.join(root, 'worlds');
  if (fs.existsSync(worldDir)) {
    for (const f of fs.readdirSync(worldDir)) {
      if (!/\.zip$/i.test(f)) continue;
      let st; try { st = fs.statSync(path.join(worldDir, f)); } catch (e) { continue; }
      const folder = f.replace(/-\d{8}-\d{6}\.zip$/i, '').replace(/\.zip$/i, '');
      out.worlds.push({ path: path.join(worldDir, f), file: f, ts: parseTs(f), size: st.size, folder });
    }
  }
  if (fs.existsSync(root)) {
    for (const f of fs.readdirSync(root)) {
      if (!/^version-\d{8}-\d{6}\.zip$/i.test(f)) continue;
      let st; try { st = fs.statSync(path.join(root, f)); } catch (e) { continue; }
      out.versions.push({ path: path.join(root, f), file: f, ts: parseTs(f), size: st.size });
    }
  }
  out.worlds.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  out.versions.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return out;
}
// 删除超过 keep 份的旧备份（按时间戳降序，保留最新 keep 份）
function pruneAutoBackups(gameDir, versionId, scope, keep) {
  const root = autoVersionDir(gameDir, versionId);
  const targets = [];
  const vFiles = fs.existsSync(root)
    ? fs.readdirSync(root).filter((f) => /^version-\d{8}-\d{6}\.zip$/i.test(f))
    : [];
  const wFiles = fs.existsSync(path.join(root, 'worlds'))
    ? fs.readdirSync(path.join(root, 'worlds')).filter((f) => /\.zip$/i.test(f))
    : [];
  if (scope === 'version' || !scope) {
    vFiles.map((f) => ({ f, ts: parseTs(f) })).sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(keep).forEach((x) => targets.push(path.join(root, x.f)));
  }
  if (scope === 'world' || !scope) {
    wFiles.map((f) => ({ f, ts: parseTs(f) })).sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(keep).forEach((x) => targets.push(path.join(root, 'worlds', x.f)));
  }
  let removed = 0;
  for (const t of targets) { try { fs.unlinkSync(t); removed++; } catch (e) { /* ignore */ } }
  return { ok: true, removed };
}

/* ============ 删除版本 ============ */

function deleteVersion(gameDir, versionId) {
  const targets = [path.join(gameDir, 'versions', versionId), instanceDirFor(gameDir, versionId)];
  const removed = [];
  for (const t of targets) {
    if (fs.existsSync(t)) {
      fs.rmSync(t, { recursive: true, force: true });
      removed.push(t);
    }
  }
  return { ok: true, removed };
}

/* ============ 详情聚合 ============ */

function detail(gameDir, versionId, isolated, versionMeta) {
  const paths = pathsFor(gameDir, versionId, isolated);
  const mods = listMods(paths.modsDir);
  const worlds = listWorlds(paths.savesDir);
  const resourcepacks = listResourcePacks(paths.resourcepacksDir, paths.optionsTxt);
  const screenshots = listScreenshots(paths.screenshotsDir);
  return {
    id: versionId,
    isolated: !!isolated,
    paths,
    meta: versionMeta || {},
    counts: {
      mods: mods.length,
      worlds: worlds.length,
      resourcepacks: resourcepacks.length,
      screenshots: screenshots.length,
      enabledMods: mods.filter((m) => m.enabled).length,
      enabledResourcepacks: resourcepacks.filter((r) => r.enabled).length,
    },
  };
}

module.exports = {
  instanceDirFor,
  modsDirFor,
  savesDirFor,
  resourcepacksDirFor,
  screenshotsDirFor,
  optionsTxtFor,
  pathsFor,
  dirSize,
  fmtSize,
  listMods,
  toggleMod,
  deleteFileSafe,
  listWorlds,
  readLevelDat,
  parseNbt,
  listResourcePacks,
  enabledResourcePackIds,
  setResourcePackEnabled,
  listScreenshots,
  backupVersion,
  backupWorld,
  autoBackup,
  listAutoBackups,
  pruneAutoBackups,
  deleteVersion,
  detail,
};
