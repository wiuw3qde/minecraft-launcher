'use strict';
/* 整合包导入 / 导出（#4 / #5）。
 * 支持：普通 zip（含 .minecraft 内容）、Modrinth .mrpack、HMCL 整合包（mcbbs）、CurseForge（仅覆盖文件）。
 * 解压复用 zip.js（自带 zip-slip 防护）；.mrpack 的 mod 通过 URL 下载。 */
const fs = require('fs');
const path = require('path');
const { extractMapped, listEntries, readText } = require('./zip');
const { zipDir } = require('./zipwrite');
const downloader = require('./downloader');

/** 探测整合包格式 */
function detectModpack(zipFile) {
  const names = listEntries(zipFile);
  const set = new Set(names.map((n) => n.replace(/\/$/, '')));
  if (set.has('modrinth.index.json')) return { format: 'mrpack' };
  if (set.has('mcbbs.modpackmeta')) return { format: 'hmcl' };
  if (set.has('manifest.json')) {
    const txt = readText(zipFile, 'manifest.json');
    if (txt) {
      try {
        const m = JSON.parse(txt);
        if (m && m.minecraft && Array.isArray(m.files)) return { format: 'curseforge', manifest: m };
      } catch (e) { /* ignore */ }
    }
  }
  return { format: 'zip' };
}

/** 找所有条目的公共顶层目录（用于剥离单层包装目录） */
function commonRoot(names) {
  let root = null;
  for (const n of names) {
    if (n.endsWith('/')) continue;
    const i = n.indexOf('/');
    const top = i < 0 ? '' : n.slice(0, i);
    if (top === '') return null; // 有文件在根，无公共根
    if (root === null) root = top;
    else if (root !== top) return null;
  }
  return root;
}

/** 提取 prefix 下内容到 base，并剥离 prefix */
function extractUnder(zipFile, base, prefix, hooks) {
  const all = listEntries(zipFile);
  const total = all.filter((n) => n.startsWith(prefix) && !n.endsWith('/')).length;
  let done = 0;
  const written = extractMapped(zipFile, base, (name) => {
    if (!name.startsWith(prefix)) return null;
    const rel = name.slice(prefix.length).replace(/^\//, '');
    if (!rel) return null;
    done++;
    if (hooks && hooks.onProgress) hooks.onProgress({ percent: total ? Math.floor((done / total) * 100) : 100 });
    return rel;
  });
  return written;
}

/** 提取整个 zip（剥离公共顶层目录），用于普通 zip */
function extractZipPlain(zipFile, base, hooks) {
  const names = listEntries(zipFile);
  const root = commonRoot(names);
  const total = names.filter((n) => !n.endsWith('/') && (root ? n.startsWith(root + '/') : true)).length;
  let done = 0;
  const written = extractMapped(zipFile, base, (name) => {
    let rel = name;
    if (root && name.startsWith(root + '/')) rel = name.slice(root.length + 1);
    if (!rel || name.endsWith('/')) {
      if (!name.endsWith('/')) { done++; if (hooks && hooks.onProgress) hooks.onProgress({ percent: total ? Math.floor((done / total) * 100) : 100 }); }
      return null;
    }
    done++;
    if (hooks && hooks.onProgress) hooks.onProgress({ percent: total ? Math.floor((done / total) * 100) : 100 });
    return rel;
  });
  return written;
}

/** 下载 .mrpack 里列出的 mod 文件（带进度） */
async function downloadMrFiles(index, base, hooks) {
  const files = (index.files || []).filter((f) => f.downloads && f.downloads.length);
  let doneCount = 0;
  for (const f of files) {
    if (hooks && hooks.shouldCancel && hooks.shouldCancel()) return { cancelled: true };
    const dest = path.join(base, f.path);
    const url = f.downloads[0];
    let loaded = 0;
    const size = (f.hashes && f.hashes.length) ? 0 : 0;
    try {
      await downloader.downloadFile([url], dest, {
        sha1: (f.hashes && (f.hashes.sha1 || (f.hashes.sha1 === undefined && f.hashes.sha512 ? undefined : undefined))) || null,
        size: 0,
        onChunk: () => {
          loaded += 1;
          if (hooks && hooks.onProgress) hooks.onProgress({ percent: 50 + Math.floor((doneCount / files.length) * 50) });
        },
      });
    } catch (e) {
      if (hooks && hooks.onLog) hooks.onLog('mod 下载失败，跳过 ' + f.path + '：' + e.message);
    }
    doneCount++;
    if (hooks && hooks.onProgress) hooks.onProgress({ percent: 50 + Math.floor((doneCount / files.length) * 50) });
  }
  return { count: files.length };
}

async function importMrpack(zipFile, base, hooks) {
  const txt = readText(zipFile, 'modrinth.index.json');
  const index = txt ? JSON.parse(txt) : { overrides: 'overrides', files: [] };
  const overrides = (index.overrides || 'overrides').replace(/\/$/, '') + '/';
  extractUnder(zipFile, base, overrides, hooks);
  let modInfo = '';
  if (index.files && index.files.length) {
    const r = await downloadMrFiles(index, base, hooks);
    modInfo = '，已下载 ' + r.count + ' 个 mod 文件';
  }
  return { ok: true, message: '已导入 Modrinth 整合包' + modInfo };
}

async function importModpack(zipFile, gameDir, opts, hooks) {
  hooks = hooks || {};
  const det = detectModpack(zipFile);
  let base;
  if (opts.target === 'instance') {
    const name = (opts.instanceName && opts.instanceName.trim()) || path.basename(zipFile, path.extname(zipFile));
    base = path.join(gameDir, 'instances', name);
  } else {
    base = gameDir;
  }
  fs.mkdirSync(base, { recursive: true });

  if (det.format === 'mrpack') {
    if (hooks.onLog) hooks.onLog('识别为 Modrinth 整合包，开始导入…');
    return await importMrpack(zipFile, base, hooks);
  }
  if (det.format === 'hmcl') {
    if (hooks.onLog) hooks.onLog('识别为 HMCL 整合包，解压 minecraft/ 内容…');
    extractUnder(zipFile, base, 'minecraft/', hooks);
    return { ok: true, message: '已导入 HMCL 整合包（minecraft/ 内容）' };
  }
  if (det.format === 'curseforge') {
    if (hooks.onLog) hooks.onLog('识别为 CurseForge 整合包，解压覆盖文件…');
    const overrides = ((det.manifest.overrides) || 'overrides').replace(/\/$/, '') + '/';
    extractUnder(zipFile, base, overrides, hooks);
    const remote = (det.manifest.files || []).length;
    return { ok: true, message: '已导入 CurseForge 覆盖文件；远程 mod ' + remote + ' 个需自行补充（本启动器未接入 CF）' };
  }
  // 普通 zip
  if (hooks.onLog) hooks.onLog('识别为普通 zip，解压到目标目录…');
  extractZipPlain(zipFile, base, hooks);
  return { ok: true, message: '已解压整合包' };
}

// 导出时排除的非内容目录 / 临时文件
const EXCLUDE_DIRS = new Set(['logs', 'crash-reports', 'webcache', 'backups', 'saves', 'runtime', 'assets', 'libraries', 'versions']);
function exportFilter(absPath, rel) {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return false;
  if (parts[parts.length - 1].endsWith('.download')) return false;
  if (parts[parts.length - 1] === 'launcher_profiles.json') return false;
  return true;
}

async function exportModpack(outDir, gameDir, source, opts, hooks) {
  hooks = hooks || {};
  const base = source === 'instances' && opts.instanceId
    ? path.join(gameDir, 'instances', opts.instanceId)
    : gameDir;
  if (!fs.existsSync(base)) return { ok: false, error: '来源目录不存在：' + base };
  const outName = ((source === 'instances' && opts.instanceId) ? opts.instanceId : 'minecraft') + '-modpack.zip';
  const outPath = path.join(outDir, outName);

  // 只收集需要导出的文件（在 zipDir 前先过滤，避免把排除项打进去）
  const files = [];
  (function walk(dir, rel) {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of list) {
      const abs = path.join(dir, it.name);
      const r = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) { if (exportFilter(abs, r)) walk(abs, r); }
      else if (it.isFile()) { if (exportFilter(abs, r)) files.push({ rel: r, abs }); }
    }
  })(base, '');
  if (!files.length) return { ok: false, error: '没有可导出的内容（mods/config 等）' };
  if (hooks.onCount) hooks.onCount(files.length);

  // 用过滤后的文件列表直接写 zip（复用 zipwrite 的逐文件压缩，但不重新 walk）
  const { writeZipFiles } = require('./zipwrite');
  await writeZipFiles(outPath, files, hooks);
  return { ok: true, outPath, outDir, name: outName };
}

module.exports = { detectModpack, importModpack, exportModpack, commonRoot };
