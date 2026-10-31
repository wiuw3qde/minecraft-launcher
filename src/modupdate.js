'use strict';
/* Mod 更新检测（路线图 A 功能）。
 * 输入：某版本的 mods 目录；输出每个已装 mod 的 Modrinth 最新兼容版本与更新状态。
 * 识别来源：优先读本启动器安装时写的 sidecar（.mclauncher-mods.json），
 *          兜底解析 jar 里的 fabric.mod.json / quilt.mod.json / mods.toml（覆盖手动放入的 mod）。
 */
const fs = require('fs');
const path = require('path');
const { listMods, modsDirFor } = require('./instance');
const modplatforms = require('./modplatforms');
const jarmeta = require('./jarmeta');

const SIDECAR = '.mclauncher-mods.json';

/* ---------- sidecar 读写 ---------- */

function sidecarPath(modsDir) {
  return path.join(modsDir, SIDECAR);
}

/** 读取 { baseName: {projectId, slug, versionId, versionNumber, loader, gameVersions, installedAt} } */
function readSidecar(modsDir) {
  try {
    const p = sidecarPath(modsDir);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function writeSidecar(modsDir, data) {
  try {
    fs.mkdirSync(modsDir, { recursive: true });
    fs.writeFileSync(sidecarPath(modsDir), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    /* 元数据写入失败不影响主流程 */
  }
}

/** 安装/更新后记录或更新一条 sidecar 记录 */
function recordMod(modsDir, baseName, info) {
  const data = readSidecar(modsDir);
  data[baseName] = Object.assign({}, data[baseName], info, { installedAt: Date.now() });
  writeSidecar(modsDir, data);
}

function removeMod(modsDir, baseName) {
  const data = readSidecar(modsDir);
  if (data[baseName]) {
    delete data[baseName];
    writeSidecar(modsDir, data);
  }
}

/* ---------- 实例 MC 版本 / 加载器推导 ---------- */

function deriveLoader(versionId) {
  if (/fabric-loader/i.test(versionId)) return 'fabric';
  if (/quilt-loader/i.test(versionId)) return 'quilt';
  if (/neoforge/i.test(versionId)) return 'neoforge';
  if (/forge/i.test(versionId)) return 'forge';
  return null;
}

/** 从版本元数据得到 mc 版本与加载器 */
function instanceContext(versionMeta) {
  const id = versionMeta && versionMeta.id;
  const mc = (versionMeta && versionMeta.inheritsFrom) || id || '';
  let loader = deriveLoader(id || '');
  if (!loader && versionMeta && versionMeta.type === 'forge') loader = 'forge';
  return { mc, loader };
}

/* ---------- 并发受限 ---------- */

function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const cur = idx++;
      try {
        results[cur] = await worker(items[cur], cur);
      } catch (e) {
        results[cur] = { error: e.message };
      }
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(run());
  return Promise.all(runners).then(() => results);
}

/* ---------- 检查更新 ---------- */

/**
 * @param {object} opts { gameDir, versionId, isolated, versionMeta, sidecar? }
 * @returns {Promise<{ok, results?, error?}>}
 */
async function checkUpdates(opts) {
  const modsDir = modsDirFor(opts.gameDir, opts.versionId, opts.isolated);
  const mods = listMods(modsDir).filter((m) => /\.jar$/i.test(m.name) || /\.jar\.disabled$/i.test(m.name));
  if (!mods.length) return { ok: true, results: [] };

  const sc = opts.sidecar || readSidecar(modsDir);
  const ctx = instanceContext(opts.versionMeta || {});
  const mc = ctx.mc;
  const instanceLoader = ctx.loader;

  // 先收集每个 mod 的来源信息
  const metas = mods.map((m) => {
    const base = m.name.replace(/\.disabled$/i, '').replace(/\.(jar|zip)$/i, '');
    const rec = sc[base];
    let slug = rec && rec.slug ? rec.slug : null;
    let installedVersion = rec && rec.versionNumber ? rec.versionNumber : '';
    let installedVersionId = rec && rec.versionId ? rec.versionId : null;
    let loaderHint = rec && rec.loader ? rec.loader : null;
    let gameVersions = rec && rec.gameVersions ? rec.gameVersions : [];
    if (!slug || !installedVersion) {
      const jar = jarmeta.readJarMeta(path.join(modsDir, m.name));
      if (!slug && jar.slug) slug = jar.slug;
      if (!installedVersion && jar.version) installedVersion = jar.version;
      if (!loaderHint && jar.loaderHint) loaderHint = jar.loaderHint;
    }
    return {
      m,
      base,
      slug,
      installedVersion,
      installedVersionId,
      loaderHint,
      gameVersions,
      projectId: (rec && rec.projectId) || slug || null,
    };
  });

  /* 精准识别：按文件 sha1 反查 Modrinth。
   * 版本号字符串格式千差万别（如 jar 里是 0.5.13+mc1.20.1，Modrinth 上是 mc1.20.1-0.5.13-fabric），
   * 直接比较字符串会误判「有更新」；用 hash 拿到 project_id + version id 后可精确判定。 */
  const hashes = await mapLimit(mods, 4, async (m) => {
    try {
      return await modplatforms.sha1File(path.join(modsDir, m.name));
    } catch (e) {
      return '';
    }
  });
  let byHash = {};
  try {
    byHash = (await modplatforms.getVersionsByHashes(hashes)) || {};
  } catch (e) {
    byHash = {};
  }
  metas.forEach((x, i) => {
    const v = hashes[i] ? byHash[hashes[i]] : null;
    if (!v) return;
    x.hashHit = true;
    x.projectId = v.project_id || x.projectId;
    x.slug = v.project_id || v.slug || x.slug;
    x.installedVersionId = v.id || x.installedVersionId;
    if (v.version_number) x.installedVersion = v.version_number;
    else if (v.name) x.installedVersion = v.name;
  });

  const rows = await mapLimit(
    metas,
    6,
    async (x) => {
      const out = {
        name: x.m.name,
        display: x.m.display,
        enabled: x.m.enabled,
        size: x.m.size,
        slug: x.slug || null,
        projectId: x.projectId || null,
        installedVersion: x.installedVersion || '(未知)',
        installedVersionId: x.installedVersionId || null,
        identifiedBy: x.hashHit ? 'hash' : x.slug ? 'meta' : 'none',
        status: 'unknown',
        latestVersion: null,
        latestVersionId: null,
        gameVersion: mc,
        loader: instanceLoader,
        loaderMismatch: false,
        error: null,
      };
      if (!x.slug) {
        out.status = 'unknown';
        return out;
      }
      let versions;
      try {
        versions = await modplatforms.getProjectVersions(x.slug);
      } catch (e) {
        out.error = e.message;
        return out;
      }
      if (!versions || !versions.length) {
        out.status = 'unknown';
        return out;
      }
      // 兼容：游戏版本命中 mc；在命中的里面优先加载器匹配
      const byMc = versions.filter((v) => (v.game_versions || []).includes(mc));
      let pool = byMc;
      if (instanceLoader && byMc.length) {
        const byLoader = byMc.filter((v) => (v.loaders || []).includes(instanceLoader));
        if (byLoader.length) pool = byLoader;
        else out.loaderMismatch = true; // 该 mod 在此 mc 下没有匹配实例加载器的构建
      }
      if (!pool.length) {
        out.status = 'unknown'; // 此 mc 下没有可用版本
        return out;
      }
      pool.sort((a, b) => new Date(b.date_published || 0) - new Date(a.date_published || 0));
      const latest = pool[0];
      out.latestVersion = latest.version_number || latest.name;
      out.latestVersionId = latest.id;
      out.loader = (latest.loaders || []).join('/') || instanceLoader;
      // 判定：优先用 version id 精确比较；没有 id 时退化为版本号字符串比较（可能不准，标记出来）
      if (out.installedVersionId && latest.id) {
        out.status = out.installedVersionId === latest.id ? 'latest' : 'update';
        out.exact = true;
      } else {
        const inst = String(out.installedVersion).trim();
        const lat = String(out.latestVersion).trim();
        out.status = inst && inst === lat ? 'latest' : 'update';
        out.exact = false;
      }
      return out;
    }
  );

  // 把识别到的来源写回 sidecar：下次检查可少走一次 hash 反查，且离线也能给出已装版本
  try {
    const data = readSidecar(modsDir);
    let dirty = false;
    rows.forEach((r, i) => {
      if (!r || !r.projectId || r.identifiedBy !== 'hash') return;
      const key = metas[i].base;
      const old = data[key] || {};
      if (old.projectId === r.projectId && old.versionId && old.versionId === r.installedVersionId) return;
      data[key] = Object.assign({}, old, {
        projectId: r.projectId,
        slug: r.slug || r.projectId,
        versionId: r.installedVersionId || old.versionId || '',
        versionNumber: r.installedVersion || old.versionNumber || '',
        loader: String(r.loader || '').split('/')[0] || old.loader || '',
        gameVersions: r.gameVersion ? [r.gameVersion] : old.gameVersions || [],
        detectedAt: Date.now(),
      });
      dirty = true;
    });
    if (dirty) writeSidecar(modsDir, data);
  } catch (e) {
    /* 缓存写入失败不影响结果 */
  }

  return { ok: true, results: rows };
}

module.exports = {
  checkUpdates,
  recordMod,
  removeMod,
  readSidecar,
  writeSidecar,
  deriveLoader,
  instanceContext,
  SIDECAR,
};
