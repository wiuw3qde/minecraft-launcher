'use strict';
/* Modrinth 模组平台客户端（仅 Modrinth，CurseForge 预留接口后续接入）。
 * 零依赖，复用 downloader 的 fileMatches / sha1OfStream 做校验跳过。
 * 所有请求走 api.modrinth.com，文件下载走 cdn.modrinth.com（或 mod 自带的外部链接）。
 */
const path = require('path');
const fs = require('fs');
const https = require('https');
const { fileMatches, sha1OfStream } = require('./downloader');

const MR_API = 'https://api.modrinth.com/v2';
const UA = 'MC-Launcher/0.1.0 (mod-manager)';
const TIMEOUT = 25000;
const MAX_REDIRECT = 5;

/** 带重定向跟随的 https GET，返回解析后的 JSON */
function getJson(url, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: TIMEOUT },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (depth >= MAX_REDIRECT) return reject(new Error('重定向次数过多'));
          const next = new URL(res.headers.location, url).toString();
          return getJson(next, depth + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' · ' + url));
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error('JSON 解析失败'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

/** 标准化搜索结果中的一个项目 */
function normalizeHit(h) {
  return {
    id: h.project_id,
    slug: h.slug || '',
    title: h.title || h.slug || h.project_id,
    description: (h.description || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    iconUrl: h.icon_url || '',
    author: h.author || '',
    downloads: h.downloads || 0,
    follows: h.follows || 0,
    categories: h.categories || [],
    gameVersions: h.versions || [],
    license: (h.license && h.license.name) || '',
    updated: h.date_modified || '',
    projectType: h.project_type || 'mod',
  };
}

/** 搜索模组
 * @param {object} opts { query, gameVersion, loader, category, sort, offset, limit }
 * sort 合法值：relevance | downloads | follows | newest | updated
 */
async function searchModrinth(opts) {
  opts = opts || {};
  const facets = [];
  if (opts.projectType) facets.push(['project_type:' + opts.projectType]);
  if (opts.gameVersion) facets.push(['game_versions:' + opts.gameVersion]);
  if (opts.loader) facets.push(['categories:' + opts.loader]);
  if (opts.category) facets.push(['categories:' + opts.category]);

  const params = new URLSearchParams();
  params.set('limit', String(Math.min(Number(opts.limit) || 24, 100)));
  params.set('offset', String(Number(opts.offset) || 0));
  params.set('index', opts.sort || 'relevance');
  if (opts.query) params.set('query', opts.query);
  if (facets.length) params.set('facets', JSON.stringify(facets));

  const data = await getJson(MR_API + '/search?' + params.toString());
  return {
    total: data.total_hits || 0,
    hits: (data.hits || []).map(normalizeHit),
  };
}

/** 拉取筛选项：游戏版本（近期正式版）、加载器、分类
 * @param {string} [projectType] 按项目类型过滤分类（mod/resourcepack/shader…），缺省按 mod
 */
async function getFilters(projectType) {
  const pt = projectType || 'mod';
  let gameVersions = [];
  let loaders = [];
  let categories = [];
  try {
    const gv = await getJson(MR_API + '/tag/game_version');
    gameVersions = (gv || [])
      .filter((v) => v.version_type === 'release')
      .slice(0, 50)
      .map((v) => v.version)
      .reverse(); // 新版在前
  } catch (e) {
    /* 拉取失败不阻塞，前端仍可手动输入 */
  }
  try {
    const ld = await getJson(MR_API + '/tag/loader');
    loaders = (ld || [])
      .map((l) => l.name)
      .filter((n) => ['fabric', 'forge', 'neoforge', 'quilt', 'liteloader', 'rift'].includes(n));
  } catch (e) {
    /* ignore */
  }
  try {
    const ct = await getJson(MR_API + '/tag/category');
    categories = (ct || [])
      .filter((c) => c.project_type === pt)
      .slice(0, 40)
      .map((c) => ({ name: c.name, slug: c.slug || c.name }));
  } catch (e) {
    /* ignore */
  }
  return { gameVersions, loaders, categories };
}

/** 从版本列表中筛选并选出最合适的版本（按 loader + gameVersion 过滤，无匹配则回退全部，取最新发布） */
function pickBestVersion(versions, opts) {
  opts = opts || {};
  let cand = versions || [];
  if (opts.loader) cand = cand.filter((v) => (v.loaders || []).includes(opts.loader));
  if (opts.gameVersion) cand = cand.filter((v) => (v.game_versions || []).includes(opts.gameVersion));
  if (!cand.length) cand = versions || []; // 没有完全匹配的回退到全部版本
  cand.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
  return cand[0] || null;
}

/** 取项目版本文件。
 * 若传 opts.versionId 则严格使用该版本（详情页用户指定的版本，不再按筛选猜测）；
 * 否则按 loader + gameVersion 筛选取最新（回退到全部版本）。
 * @returns { versionId, versionName, gameVersions, loaders, file:{url,filename,size,sha1} }
 */
async function resolveDownload(projectId, opts) {
  opts = opts || {};
  const versions = await getJson(MR_API + '/project/' + encodeURIComponent(projectId) + '/version');
  if (!versions || !versions.length) throw new Error('该项目没有可用版本');

  let ver = null;
  if (opts.versionId) {
    ver = versions.find((v) => v.id === opts.versionId) || null;
    if (!ver) throw new Error('找不到指定的版本（' + opts.versionId + '）');
  } else {
    ver = pickBestVersion(versions, opts);
  }
  if (!ver) throw new Error('没有匹配该加载器 / 游戏版本的可用版本');
  let file = (ver.files || []).find((f) => f.primary);
  if (!file) file = ver.files && ver.files[0];
  if (!file) throw new Error('该版本没有可下载的文件');

  return {
    versionId: ver.id,
    versionName: ver.name || ver.version_number,
    versionNumber: ver.version_number || ver.name,
    gameVersions: ver.game_versions,
    loaders: ver.loaders,
    file: {
      url: file.url,
      filename: file.filename,
      size: file.size,
      sha1: (file.hashes && file.hashes.sha1) || null,
    },
  };
}

/** 带进度的单文件下载（遵循重定向、sha1 校验、已存在则跳过）
 * @param {object} file { url, filename, size, sha1 }
 * @param {string} destDir 目标目录
 * @param {object} hooks { onProgress, onLog, shouldCancel }
 */
async function downloadFileWithProgress(file, destDir, hooks) {
  hooks = hooks || {};
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, file.filename);

  // 取消检查：开始前（含「已存在跳过」判定前后）都要看一眼
  if (hooks.shouldCancel && hooks.shouldCancel()) {
    return { ok: false, cancelled: true, error: '已取消' };
  }
  if (await fileMatches(dest, file.sha1, file.size)) {
    if (hooks.onLog) hooks.onLog('已存在且校验通过，跳过：' + file.filename);
    return { ok: true, skipped: true, dest };
  }
  if (hooks.shouldCancel && hooks.shouldCancel()) {
    return { ok: false, cancelled: true, error: '已取消' };
  }

  return await new Promise((resolve, reject) => {
    const tmp = dest + '.download';
    let settled = false;
    let req = null;
    let res = null;
    let out = null;

    /** 统一收口：保证只 resolve/reject 一次 */
    function settle(result, err) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result);
    }

    /** 真正中断下载：掐断请求 + 响应 + 写流，并清掉 .download 半成品 */
    function abort() {
      try { if (res) res.destroy(); } catch (e) { /* ignore */ }
      try { if (req) req.destroy(); } catch (e) { /* ignore */ }
      try { if (out) out.destroy(); } catch (e) { /* ignore */ }
      // 写流 destroy 后文件句柄可能还没释放，延后一拍再删
      setTimeout(() => {
        try { fs.rmSync(tmp, { force: true }); } catch (e) { /* ignore */ }
      }, 30);
      settle({ ok: false, cancelled: true, error: '已取消' });
    }

    function killStream(e) {
      try { if (out) out.destroy(); } catch (x) { /* ignore */ }
      setTimeout(() => {
        try { fs.rmSync(tmp, { force: true }); } catch (x) { /* ignore */ }
      }, 30);
      settle(null, e || new Error('下载中断'));
    }

    const start = (url) => {
      req = https.get(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: TIMEOUT }, (r) => {
        res = r;
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume();
          const next = new URL(r.headers.location, url).toString();
          if (next === url) return settle(null, new Error('重定向环'));
          return start(next);
        }
        if (r.statusCode !== 200) {
          r.resume();
          return settle(null, new Error('HTTP ' + r.statusCode));
        }
        const total = Number(r.headers['content-length']) || 0;
        out = fs.createWriteStream(tmp);
        let loaded = 0;

        r.on('data', (chunk) => {
          // 关键：每收到一块数据都检查取消标志，否则「取消」只是设了个没人读的标志位
          if (hooks.shouldCancel && hooks.shouldCancel()) {
            abort();
            return;
          }
          loaded += chunk.length;
          if (hooks.onProgress) {
            hooks.onProgress({
              loaded,
              total: total || loaded,
              percent: total ? Math.min(99, Math.floor((loaded / total) * 100)) : 0,
            });
          }
        });
        r.on('error', killStream);
        out.on('error', killStream);
        r.pipe(out);
        out.on('finish', () => {
          out.close(async () => {
            try {
              if (file.sha1) {
                const actual = await sha1OfStream(tmp);
                if (actual !== file.sha1) {
                  fs.rmSync(tmp, { force: true });
                  return settle(null, new Error('校验失败：sha1 不匹配'));
                }
              }
              fs.renameSync(tmp, dest);
              if (hooks.onProgress) hooks.onProgress({ loaded: total || loaded, total: total || loaded, percent: 100 });
              settle({ ok: true, skipped: false, dest });
            } catch (e) {
              settle(null, e);
            }
          });
        });
      });
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', (e) => killStream(e));
    };

    start(file.url);
  });
}

/* ---------------- 模组详情（全量版本 + 前置模组） ---------------- */

/** 项目基本信息 */
async function getProject(projectId) {
  return await getJson(MR_API + '/project/' + encodeURIComponent(projectId));
}

/** 项目全部版本（原始） */
async function getProjectVersions(projectId) {
  return (await getJson(MR_API + '/project/' + encodeURIComponent(projectId) + '/version')) || [];
}

/** 文件的 sha1（用于按 hash 反查 Modrinth 版本） */
function sha1File(file) {
  return sha1OfStream(file);
}

/** 按单个文件 hash 反查版本（命中返回 version 对象，404 返回 null） */
async function getVersionByHash(hash, algorithm) {
  const algo = algorithm || 'sha1';
  try {
    return await getJson(MR_API + '/version_file/' + encodeURIComponent(hash) + '?algorithm=' + algo);
  } catch (e) {
    if (/HTTP 404/.test(String(e && e.message))) return null;
    throw e;
  }
}

/** 带体的 JSON POST（Modrinth 批量接口用） */
function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: TIMEOUT,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(buf));
            } catch (e) {
              reject(new Error('JSON 解析失败'));
            }
          } else {
            reject(new Error('HTTP ' + res.statusCode));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * 批量按 sha1 反查已装文件的 Modrinth 版本（比解析 jar 元数据精准得多：
 * 直接得到 project_id 与 version id，可据此做「是否已最新」的精确判定）。
 * @param {string[]} hashes sha1 数组
 * @returns {Promise<Object>} { sha1: version对象 }
 */
async function getVersionsByHashes(hashes) {
  const arr = (hashes || []).filter(Boolean);
  const out = {};
  if (!arr.length) return out;
  try {
    const map = await postJson(MR_API + '/version_files', { hashes: arr, algorithm: 'sha1' });
    arr.forEach((h) => {
      if (map && map[h]) out[h] = map[h];
    });
    return out;
  } catch (e) {
    // 批量接口不可用时退化为逐个查询
    for (const h of arr) {
      try {
        const v = await getVersionByHash(h);
        if (v) out[h] = v;
      } catch (e2) {
        /* 单个失败忽略 */
      }
    }
    return out;
  }
}

/** 批量取多个项目的基本信息（用于把依赖的 project_id 解析成可读标题） */
async function getProjectsByIds(ids) {
  const arr = (ids || []).filter(Boolean);
  if (!arr.length) return {};
  const out = {};
  // Modrinth 单次 ids 上限较大，这里分块避免 URL 过长
  const CHUNK = 40;
  for (let i = 0; i < arr.length; i += CHUNK) {
    const part = arr.slice(i, i + CHUNK);
    try {
      const list = await getJson(MR_API + '/projects?ids=' + encodeURIComponent(JSON.stringify(part)));
      (list || []).forEach((p) => {
        out[p.id] = {
          id: p.id,
          slug: p.slug || '',
          title: p.title || p.slug || p.id,
          iconUrl: p.icon_url || '',
          projectType: p.project_type || 'mod',
        };
      });
    } catch (e) {
      /* 依赖名解析失败不影响详情主体 */
    }
  }
  return out;
}

/** 取模组详情：项目信息 + 全部版本（含加载器/游戏版本/文件）+ 依赖项目的可读信息 */
async function getModDetail(projectId) {
  const project = await getProject(projectId);
  const rawVersions = await getProjectVersions(projectId);

  // 收集所有依赖的 project_id（排除 incompatible，那不是"前置"）
  const depIds = new Set();
  rawVersions.forEach((v) => {
    (v.dependencies || []).forEach((d) => {
      if (d.project_id && d.dependency_type !== 'incompatible') depIds.add(d.project_id);
    });
  });
  const deps = await getProjectsByIds(Array.from(depIds));

  const versions = rawVersions
    .map((v) => {
      let f = (v.files || []).find((x) => x.primary);
      if (!f) f = (v.files || [])[0];
      return {
        id: v.id,
        name: v.name || v.version_number,
        versionNumber: v.version_number || '',
        versionType: v.version_type || 'release',
        gameVersions: v.game_versions || [],
        loaders: v.loaders || [],
        datePublished: v.date_published || '',
        downloads: v.downloads || 0,
        changelog: v.changelog || '',
        dependencies: (v.dependencies || []).map((d) => ({
          projectId: d.project_id,
          versionId: d.version_id || null,
          type: d.dependency_type || 'required',
        })),
        file: f
          ? { url: f.url, filename: f.filename, size: f.size || 0, sha1: (f.hashes && f.hashes.sha1) || null }
          : null,
      };
    })
    .sort((a, b) => new Date(b.datePublished) - new Date(a.datePublished));

  return {
    project: {
      id: project.id,
      slug: project.slug || '',
      title: project.title || project.slug || project.id,
      description: project.description || '',
      iconUrl: project.icon_url || '',
      author: project.author || '',
      downloads: project.downloads || 0,
      follows: project.follows || 0,
      categories: project.categories || [],
      gameVersions: project.versions || [],
      license: (project.license && project.license.name) || '',
      updated: project.updated || project.date_modified || '',
      clientSide: project.client_side || '',
      serverSide: project.server_side || '',
      sourceUrl: project.source_url || '',
      issuesUrl: project.issues_url || '',
      wikiUrl: project.wiki_url || '',
      projectType: project.project_type || 'mod',
    },
    versions,
    deps,
  };
}

module.exports = {
  searchModrinth,
  getFilters,
  resolveDownload,
  downloadFileWithProgress,
  normalizeHit,
  pickBestVersion,
  getProject,
  getProjectVersions,
  sha1File,
  getVersionByHash,
  getVersionsByHashes,
  getProjectsByIds,
  getModDetail,
  MR_API,
};
