'use strict';
const fs = require('fs');
const path = require('path');
const { extractAll } = require('./zip');

const CACHE_MARKER = '.natives-cache.json';

/** 以「已解压的 jar 列表」作为缓存依据，避免靠文件数量误判 */
function cacheValid(nativesDir, entries) {
  const marker = path.join(nativesDir, CACHE_MARKER);
  if (!fs.existsSync(marker)) return false;
  const info = readCache(nativesDir);
  if (!info || !Array.isArray(info.jars)) return false;
  const want = entries.map((e) => e.relPath).sort().join('|');
  const got = info.jars.slice().sort().join('|');
  return want === got;
}

function readCache(nativesDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(nativesDir, CACHE_MARKER), 'utf8'));
  } catch (e) {
    return null;
  }
}

function buildFilter(entries) {
  const excludes = new Set();
  for (const e of entries) for (const ex of e.exclude || []) excludes.add(String(ex).replace(/\/+$/, ''));
  if (!excludes.size) return null;
  return (name) => {
    for (const ex of excludes) {
      if (name === ex || name.startsWith(ex + '/')) return false;
    }
    return true;
  };
}

/**
 * 确保 natives 已就绪（有缓存就跳过）
 * @param nativesDir 解压目标目录
 * @param entries [{jar, relPath, exclude}]
 * @param log 可选日志回调
 */
async function ensureNatives(nativesDir, entries, log) {
  log = log || function () {};
  const usable = entries.filter((e) => fs.existsSync(e.jar));
  const missing = entries.filter((e) => !fs.existsSync(e.jar)).map((e) => e.relPath);

  if (!usable.length) return { extracted: false, count: 0, missing };

  // 缓存命中判断：目录存在且已解压的 jar 列表与本次一致
  if (fs.existsSync(nativesDir) && cacheValid(nativesDir, usable)) {
    log(`[natives] 复用已缓存的本地库：${nativesDir}\n`);
    return { extracted: false, count: usable.length, missing };
  }

  fs.mkdirSync(nativesDir, { recursive: true });
  log(`[natives] 正在解压 ${usable.length} 个本地库到 ${nativesDir}...\n`);

  let extracted = 0;
  let failed = 0;
  for (const e of usable) {
    try {
      extracted += extractAll(e.jar, nativesDir, buildFilter([e]));
    } catch (err) {
      failed++;
      log(`[natives] 解压失败 ${e.relPath}：${err.message}\n`);
    }
  }
  log(`[natives] 解压完成，共 ${extracted} 个文件${failed ? `，${failed} 个 jar 解压失败` : ''}\n`);
  try {
    fs.writeFileSync(
      path.join(nativesDir, CACHE_MARKER),
      JSON.stringify({ jars: usable.map((e) => e.relPath), extractedAt: Date.now() })
    );
  } catch (e) {
    /* 标记写失败不影响本次启动 */
  }
  return { extracted: true, count: usable.length, fileCount: extracted, failed, missing };
}

function clearNatives(nativesDir) {
  if (!fs.existsSync(nativesDir)) return false;
  fs.rmSync(nativesDir, { recursive: true, force: true });
  return true;
}

module.exports = { ensureNatives, clearNatives };
