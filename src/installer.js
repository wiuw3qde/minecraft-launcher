'use strict';
/* 原版游戏安装：版本 json / 本体 jar / 依赖 / 本地库 / 资源文件，全部支持多源回退 */
const fs = require('fs');
const path = require('path');
const { downloadFile, fetchJson, runPool } = require('./downloader');
const { rulesAllow, OS } = require('./version-profile');
const { candidatesFor, manifestUrls, UNLISTED_MANIFESTS } = require('./mirrors');
const { readJsonFile } = require('./util');

const LEGACY_INDEXES = ['legacy', 'pre-1.6'];

/** 拉取并合并版本清单（可叠加未列出版本清单） */
async function loadManifest(mirrorIds, includeUnlisted, log) {
  const res = await fetchJson(manifestUrls(mirrorIds));
  if (!res.ok) return { ok: false, error: res.error, versions: [] };
  const versions = res.data.versions.slice();

  if (includeUnlisted) {
    const extra = await fetchJson(UNLISTED_MANIFESTS);
    if (extra.ok) {
      const known = new Set(versions.map((v) => v.id));
      let added = 0;
      for (const v of extra.data.versions) {
        if (v.id && !known.has(v.id)) {
          versions.push(Object.assign({}, v, { unlisted: true }));
          added++;
        }
      }
      if (log) log(`[清单] 补充未列出版本 ${added} 个\n`);
    } else if (log) {
      log('[清单] 未列出版本清单获取失败，已跳过\n');
    }
  }
  return { ok: true, versions, source: res.source };
}

/** 依赖（含本地库）下载任务 */
function collectLibraryTasks(json, gameDir, mirrorIds) {
  const libsDir = path.join(gameDir, 'libraries');
  const seen = new Set();
  const tasks = [];

  const add = (dest, url, sha1, size, label) => {
    if (!dest || seen.has(dest)) return;
    seen.add(dest);
    const urls = url
      ? candidatesFor(url, mirrorIds)
      : candidatesFor('https://libraries.minecraft.net/' + path.relative(libsDir, dest).replace(/\\/g, '/'), mirrorIds);
    tasks.push({ dest, urls, sha1, size, label });
  };

  for (const lib of json.libraries || []) {
    if (!rulesAllow(lib.rules, {})) continue;

    const artifact = lib.downloads && lib.downloads.artifact;
    if (artifact && artifact.path) {
      const base = artifact.url || lib.url;
      add(path.join(libsDir, artifact.path), base, artifact.sha1, artifact.size, artifact.path);
    }

    // 本地库（natives）
    let key = lib.natives && lib.natives[OS] ? lib.natives[OS] : null;
    if (key && key.includes('${arch}')) key = key.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
    const classifiers = lib.downloads && lib.downloads.classifiers;
    const native = key && classifiers ? classifiers[key] : null;
    if (native && native.path) {
      const base = native.url || lib.url;
      add(path.join(libsDir, native.path), base, native.sha1, native.size, native.path);
    }
  }
  return tasks;
}

/** 资源索引里的对象 */
function collectAssetTasks(indexFile, gameDir, mirrorIds) {
  const idx = readJsonFile(indexFile);
  if (!idx || !idx.objects) return { tasks: [], objects: {} };
  const objectsDir = path.join(gameDir, 'assets', 'objects');
  const seen = new Set();
  const tasks = [];
  for (const [name, meta] of Object.entries(idx.objects)) {
    const hash = meta.hash;
    if (seen.has(hash)) continue;
    seen.add(hash);
    tasks.push({
      dest: path.join(objectsDir, hash.slice(0, 2), hash),
      urls: candidatesFor('https://resources.download.minecraft.net/' + hash.slice(0, 2) + '/' + hash, mirrorIds),
      sha1: hash,
      size: meta.size,
      label: name,
    });
  }
  // 老版本索引用 map_to_resources（更老的没有 virtual 字段），一律按 id 判断
  const legacy = !!(idx.virtual || idx.map_to_resources);
  return { tasks, objects: idx.objects, indexId: idx.id, legacy };
}

/** 老版本需要 assets/virtual/<index>/<name> 这种扁平布局 */
function createVirtualAssets(gameDir, objects, indexId, log) {
  if (!indexId || !LEGACY_INDEXES.includes(indexId)) return 0;
  const objectsDir = path.join(gameDir, 'assets', 'objects');
  const virtualDir = path.join(gameDir, 'assets', 'virtual', indexId);
  let n = 0;
  for (const [name, meta] of Object.entries(objects)) {
    const src = path.join(objectsDir, meta.hash.slice(0, 2), meta.hash);
    const dst = path.join(virtualDir, name);
    try {
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        n++;
      }
    } catch (e) {
      /* 单个文件失败不影响整体 */
    }
  }
  if (n && log) log(`[资源] 已生成老版本虚拟资源 ${n} 个\n`);
  return n;
}

async function runTaskGroup(tasks, opts, onProgress, stats) {
  const { concurrency = 16, mirrorIds, shouldCancel } = opts;
  return runPool(
    tasks,
    concurrency,
    async (task) => {
      if (shouldCancel && shouldCancel()) return { cancelled: true };
      const res = await downloadFile(task.urls, task.dest, {
        sha1: task.sha1,
        size: task.size,
        onChunk: (len) => {
          stats.bytes += len;
        },
      });
      if (res.skipped) stats.skipped++;
      else if (res.ok) stats.downloaded++;
      if (!res.ok) stats.failed.push({ label: task.label, error: res.error });
      if (res.ok) stats.done++;
      if (onProgress) onProgress({ done: stats.done, total: stats.total, bytes: stats.bytes, failed: stats.failed.length });
      return res;
    },
    shouldCancel
  );
}

/**
 * 安装一个已存在的版本描述（也可用于加载器生成的 json）
 * @returns {{ok:boolean, downloaded:number, skipped:number, failed:Array}}
 */
async function installProfile(profile, gameDir, opts) {
  const stats = { downloaded: 0, skipped: 0, bytes: 0, failed: [], done: 0, total: 0 };
  const log = opts.onLog || function () {};
  const id = profile.__id;
  const vdir = profile.__versionDir;

  const tasks = [];

  // 本体 jar
  const client = profile.downloads && profile.downloads.client;
  const jarPath = path.join(vdir, id + '.jar');
  if (client && client.url) {
    tasks.push({ dest: jarPath, urls: candidatesFor(client.url, opts.mirrorIds), sha1: client.sha1, size: client.size, label: id + '.jar' });
  }

  tasks.push(...collectLibraryTasks(profile, gameDir, opts.mirrorIds));

  stats.total = tasks.length;
  log(`[下载] ${id}：本体 + 依赖共 ${tasks.length} 个文件\n`);
  await runTaskGroup(tasks, opts, opts.onProgress, stats);

  // 资源文件（需要先拿到索引）
  if (!opts.skipAssets && profile.assetIndex) {
    const indexFile = path.join(gameDir, 'assets', 'indexes', profile.assetIndex.id + '.json');
    const indexRes = await downloadFile(
      candidatesFor(profile.assetIndex.url, opts.mirrorIds),
      indexFile,
      { sha1: profile.assetIndex.sha1, size: profile.assetIndex.size }
    );
    if (!indexRes.ok) {
      log(`[资源] 索引下载失败：${indexRes.error}\n`);
      stats.failed.push({ label: 'assetIndex', error: indexRes.error });
    } else {
      const { tasks: assetTasks, objects } = collectAssetTasks(indexFile, gameDir, opts.mirrorIds);      const beforeTotal = stats.total;
      stats.total = beforeTotal + assetTasks.length;
      const beforeDone = stats.done;
      if (assetTasks.length) {
        log(`[资源] 需要下载 ${assetTasks.length} 个资源文件\n`);
        await runTaskGroup(
          assetTasks,
          opts,
          (p) => (opts.onProgress ? opts.onProgress(Object.assign({}, p, { done: p.done + beforeDone, phase: 'assets' })) : null),
          stats
        );
        stats.done = beforeDone + assetTasks.length;
      }
      if (!opts.skipVirtual) createVirtualAssets(gameDir, objects, profile.assetIndex.id, log);
    }
  }

  return {
    ok: stats.failed.length === 0,
    versionId: id,
    downloaded: stats.downloaded,
    skipped: stats.skipped,
    bytes: stats.bytes,
    failed: stats.failed,
  };
}

/**
 * 从版本清单安装一个原版 gameDir/versions/<id>
 */
async function installVersion(opts) {
  const { gameDir, versionId, mirrorIds } = opts;
  const log = opts.onLog || function () {};
  if (!versionId) return { ok: false, error: '未指定版本' };

  if (opts.entryUrl) {
    // 调用方已经知道 json 地址
  }
  const manifest = await loadManifest(mirrorIds, opts.includeUnlisted, log);
  if (!manifest.ok) return { ok: false, error: manifest.error };

  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) return { ok: false, error: '清单里没有这个版本：' + versionId };

  const vdir = path.join(gameDir, 'versions', versionId);
  fs.mkdirSync(vdir, { recursive: true });
  const jsonPath = path.join(vdir, versionId + '.json');
  const jsonRes = await downloadFile(candidatesFor(entry.url, mirrorIds), jsonPath, {});
  if (!jsonRes.ok) return { ok: false, error: '版本描述下载失败：' + jsonRes.error };

  const json = readJsonFile(jsonPath);
  if (!json) return { ok: false, error: '版本描述解析失败' };
  json.__id = json.id || versionId;
  json.__versionDir = vdir;

  return installProfile(json, gameDir, opts);
}

module.exports = { loadManifest, installVersion, installProfile, collectLibraryTasks, collectAssetTasks, createVirtualAssets };
