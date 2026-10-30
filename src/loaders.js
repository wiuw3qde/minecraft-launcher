'use strict';
/* 加载器：Fabric / Forge / NeoForge / OptiFine 的版本列表与安装 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { downloadFile, fetchJson, runPool } = require('./downloader');
const { candidatesFor, resolveMirrors } = require('./mirrors');
const { installProfile } = require('./installer');
const { mavenPathFromName, readJsonFile } = require('./util');

const FORGE_METADATA = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const OFFICIAL_FABRIC = 'https://meta.fabricmc.net/v2';

/** 标准 launcher_profiles.json：Forge 安装器没有它就拒绝安装 */
function ensureLauncherProfiles(gameDir) {
  const file = path.join(gameDir, 'launcher_profiles.json');
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(gameDir, { recursive: true });
  const data = {
    profiles: {},
    selectedProfile: null,
    clientToken: 'mc-launcher-offline',
    authenticationDatabase: {},
    selectedUser: {},
    launcherVersion: { name: 'mc-launcher', format: 21 },
    settings: { enableHistory: false, enableSnapshots: true },
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function mirrorRoots(mirrorIds) {
  const mirrors = resolveMirrors(mirrorIds);
  return mirrors.filter((m) => m.apiRoot).map((m) => m.apiRoot);
}

/* ---------------- Fabric ---------------- */

async function listFabric(mcVersion, mirrorIds) {
  const urlSets = mirrorRoots(mirrorIds)
    .map((r) => [`${r}/fabric-meta/v2/versions/loader/${mcVersion}`])
    .concat([[`${OFFICIAL_FABRIC}/versions/loader/${mcVersion}`]]);

  for (const urls of urlSets) {
    const res = await fetchJson(urls);
    if (!res.ok) continue;
    return {
      ok: true,
      source: res.source,
      versions: res.data.map((e) => ({
        version: e.loader.version,
        stable: e.loader.stable,
        raw: e,
      })),
    };
  }
  return { ok: false, error: '获取 Fabric 版本列表失败', versions: [] };
}

/**
 * 安装 Fabric：生成 inheritsFrom 父版本的新版本描述并下载 loader 依赖
 */
async function installFabric(opts) {
  const { gameDir, gameVersion, loaderVersion, mirrorIds } = opts;
  const log = opts.onLog || function () {};
  const parentJsonPath = path.join(gameDir, 'versions', gameVersion, gameVersion + '.json');
  if (!fs.existsSync(parentJsonPath)) {
    return { ok: false, error: `请先安装原版 ${gameVersion}，Fabric 依赖它作为父版本` };
  }

  const list = await listFabric(gameVersion, mirrorIds);
  if (!list.ok) return { ok: false, error: list.error };
  const entry = list.versions.find((v) => v.version === loaderVersion);
  if (!entry) return { ok: false, error: `Fabric ${loaderVersion} 不在可用列表中` };

  const meta = entry.raw.launcherMeta;
  const libraries = [];
  const addLib = (name, url, sha1, size) => {
    libraries.push({
      name,
      url: url || 'https://maven.fabricmc.net/',
      downloads: { artifact: { path: mavenPathFromName(name), url: (url || 'https://maven.fabricmc.net/') + mavenPathFromName(name), sha1: sha1 || undefined, size: size || undefined } },
    });
  };
  addLib(`net.fabricmc:intermediary:${gameVersion}`);
  addLib(`net.fabricmc:fabric-loader:${loaderVersion}`);
  for (const l of meta.libraries.common || []) addLib(l.name, l.url, l.sha1, l.size);
  for (const l of meta.libraries.client || []) addLib(l.name, l.url, l.sha1, l.size);

  const id = `fabric-loader-${loaderVersion}-${gameVersion}`;
  const vdir = path.join(gameDir, 'versions', id);
  fs.mkdirSync(vdir, { recursive: true });
  const profile = {
    id,
    inheritsFrom: gameVersion,
    type: 'release',
    mainClass: meta.mainClass.client,
    libraries,
    arguments: { game: [] },
    __id: id,
    __versionDir: vdir,
  };
  fs.writeFileSync(path.join(vdir, id + '.json'), JSON.stringify(profile, null, 2));
  log(`[Fabric] 已生成版本：${id}\n`);

  const res = await installProfile(profile, gameDir, Object.assign({}, opts, { skipAssets: true }));
  return Object.assign({ versionId: id }, res);
}

/* ---------------- Forge ---------------- */

async function listForge(mcVersion, mirrorIds) {
  // 注意：BMCLAPI 上的 maven-metadata.xml 只同步到 1.18，
  // 所以列表必须用官方元数据（文件很小），下载文件才走镜像
  // force：避免复用上一次的临时副本（镜像上的元数据可能是旧的）
  const res = await downloadFile([FORGE_METADATA].concat(candidatesFor(FORGE_METADATA, mirrorIds)), forgeMetaTemp(), { force: true });
  if (!res.ok) return { ok: false, error: '获取 Forge 版本列表失败：' + res.error, versions: [] };
  const xml = fs.readFileSync(forgeMetaTemp(), 'utf8');
  const all = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g)).map((m) => m[1]);
  const versions = all
    .filter((v) => v.startsWith(mcVersion + '-') || v.startsWith(mcVersion + '.'))
    .map((v) => ({ version: v.split('-').pop(), raw: v }))
    .sort((a, b) => compareVersionDesc(a.raw, b.raw));
  return { ok: true, versions };
}

function forgeMetaTemp() {
  return path.join(require('os').tmpdir(), 'mc-launcher-forge-metadata.xml');
}

function compareVersionDesc(a, b) {
  const pa = a.split(/[.\-]/);
  const pb = b.split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10);
    const nb = parseInt(pb[i], 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return nb - na;
    if (pa[i] !== pb[i]) return String(pb[i] || '').localeCompare(String(pa[i] || ''));
  }
  return 0;
}

function forgeInstallerUrl(rawVersion) {
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${rawVersion}/forge-${rawVersion}-installer.jar`;
}

/* ---------------- NeoForge ---------------- */

async function listNeoForge(mcVersion, mirrorIds) {
  const roots = mirrorRoots(mirrorIds);
  for (const root of roots) {
    const res = await fetchJson([`${root}/neoforge/list/${mcVersion}`]);
    if (!res.ok) continue;
    const versions = res.data.map((e) => ({
      version: e.version,
      raw: e.rawVersion || `neoforge-${e.version}`,
      installerPath: e.installerPath || `/maven/net/neoforged/forge/${mcVersion}-${e.version}/forge-${mcVersion}-${e.version}-installer.jar`,
      root,
    }));
    return { ok: true, source: root, versions };
  }
  return { ok: false, error: '获取 NeoForge 版本列表失败', versions: [] };
}

/* ---------------- OptiFine ---------------- */

async function listOptiFine(mcVersion, mirrorIds) {
  const roots = mirrorRoots(mirrorIds);
  for (const root of roots) {
    const res = await fetchJson([`${root}/optifine/${mcVersion}`]);
    if (!res.ok) continue;
    const versions = res.data.map((e) => ({
      version: `${e.type}_${e.patch}`,
      type: e.type,
      patch: e.patch,
      filename: e.filename,
      forge: e.forge || '',
      root,
    }));
    return { ok: true, source: root, versions };
  }
  return { ok: false, error: '获取 OptiFine 版本列表失败', versions: [] };
}

/**
 * 在临时目录创建 <home>/.minecraft -> gameDir 的联接。
 * OptiFine 安装器只会安装到 APPDATA/user.home 下的 .minecraft，必须重定向。
 * Windows 用 junction（无需管理员权限），其他平台用 symlink。
 */
function createGameDirLink(gameDir) {
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-of-home-'));
  const link = path.join(home, '.minecraft');
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      execFileSync('cmd', ['/c', 'mklink', '/J', link, gameDir], { stdio: 'ignore' });
    } else {
      fs.symlinkSync(gameDir, link);
    }
    if (!fs.existsSync(path.join(link, 'versions'))) throw new Error('联接未生效');
    return { ok: true, home, link };
  } catch (e) {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch (e2) {
      /* ignore */
    }
    return { ok: false, error: '创建游戏目录联接失败：' + e.message };
  }
}

function removeGameDirLink(link) {
  try {
    if (process.platform === 'win32') fs.rmdirSync(link); // junction：只删联接本身，不碰目标
    else fs.unlinkSync(link);
  } catch (e) {
    /* ignore */
  }
}

/**
 * 无人值守运行 OptiFine 安装器。
 * 安装器主类 optifine.Installer 本身就是无 GUI 的（GUI 在 InstallerFrame 里），
 * 通过 QUIET 异常机制在版本缺失时静默退出。
 * @returns {Promise<{ok, exitCode, output, versionId?}>}
 */
async function runOptiFineHeadless(opts) {
  const { jarPath, gameDir, javaPath } = opts;
  const log = opts.onLog || function () {};
  const linkRes = createGameDirLink(gameDir);
  if (!linkRes.ok) return { ok: false, error: linkRes.error };

  const env = Object.assign({}, process.env);
  const jvmPrefix = [];
  if (process.platform === 'win32') {
    env.APPDATA = linkRes.home; // Windows 下安装器读 APPDATA/.minecraft
  } else {
    jvmPrefix.push(`-Duser.home=${linkRes.home}`);
  }

  const cmd = javaPath || 'java';
  const argv = jvmPrefix.concat(['-cp', jarPath, 'optifine.Installer']);
  log('[OptiFine] 无人值守安装中…\n');

  const result = await new Promise((resolve) => {
    const proc = spawn(cmd, argv, { cwd: gameDir, env, windowsHide: true });
    let output = '';
    const pump = (buf) => {
      const text = String(buf);
      output += text;
      log(text);
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);
    proc.on('error', (e) => resolve({ ok: false, exitCode: null, output, error: '安装器启动失败：' + e.message }));
    proc.on('close', (code) => resolve({ ok: code === 0, exitCode: code, output }));
    setTimeout(() => {
      try {
        proc.kill();
      } catch (e) {
        /* ignore */
      }
      resolve({ ok: false, exitCode: null, output, timeout: true });
    }, opts.timeoutMs || 10 * 60 * 1000);
  });

  removeGameDirLink(linkRes.link);
  try {
    fs.rmSync(linkRes.home, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }

  // 从输出解析生成的版本名：Minecraft_OptiFine Version: 1.20.1-OptiFine_HD_U_I5
  const m = String(result.output || '').match(/Minecraft_OptiFine Version:\s*(\S+)/);
  if (m) result.versionId = m[1];
  return result;
}

/** 从 "Forge 47.0.35" 解析出 forge 原始版本号 "1.20.1-47.0.35" */
function forgeRawFromField(mcVersion, forgeField) {
  const m = String(forgeField || '').match(/([\d.]+)\s*$/);
  if (!m) return null;
  return `${mcVersion}-${m[1]}`;
}

/** 找已安装的 Forge 版本目录名（如 1.20.1-forge-47.4.28），没有返回 null */
function findInstalledForge(gameDir, mcVersion) {
  const dir = path.join(gameDir, 'versions');
  if (!fs.existsSync(dir)) return null;
  const prefix = mcVersion + '-forge-';
  const list = fs.readdirSync(dir).filter((d) => d.startsWith(prefix));
  if (!list.length) return null;
  return list.sort((a, b) => compareVersionDesc(b.slice(prefix.length), a.slice(prefix.length)))[0];
}

/**
 * OptiFine 一键安装（无人值守）。
 * comboForge=true 时生成 Forge + OptiFine 组合版本（<mc>-Forge_<v>-OptiFine_<ed>），
 * 组合版继承已安装的 Forge 版本，游戏参数追加 --tweakClass optifine.OptiFineForgeTweaker。
 */
async function installOptiFine(opts) {
  const { gameDir, mcVersion, type, patch, mirrorIds, javaPath, comboForge } = opts;
  const log = opts.onLog || function () {};

  // 1. 下载安装器
  const roots = mirrorRoots(mirrorIds);
  const first = roots[0];
  const url = first ? `${first}/optifine/${mcVersion}/${type}/${patch}` : `https://bmclapi2.bangbang93.com/optifine/${mcVersion}/${type}/${patch}`;
  const fileName = opts.filename || `OptiFine_${mcVersion}_${type}_${patch}.jar`;
  const fetched = await fetchInstallerJar({ gameDir, url, fileName, mirrorIds, onLog: log, onProgress: opts.onProgress });
  if (!fetched.ok) return { ok: false, error: '安装器下载失败：' + fetched.error };

  // 2. 组合安装：确保 Forge 就绪
  let forgeVersionId = null;
  if (comboForge) {
    forgeVersionId = findInstalledForge(gameDir, mcVersion);
    if (!forgeVersionId) {
      const raw = forgeRawFromField(mcVersion, opts.forge);
      if (!raw) {
        return { ok: false, error: '该 OptiFine 版本未标注适配的 Forge 版本，且游戏目录里没有已安装的 Forge。请先安装 Forge，或取消勾选「与 Forge 同时安装」' };
      }
      log(`[OptiFine] 组合安装需要 Forge，先自动安装 ${raw}…\n`);
      const forgeRes = await installForgeLike({
        gameDir,
        kind: 'Forge',
        rawVersion: raw,
        installerUrl: forgeInstallerUrl(raw),
        fileName: `forge-${raw}-installer.jar`,
        mirrorIds,
        javaPath,
        onLog: log,
        onProgress: opts.onProgress,
      });
      if (!forgeRes.ok) return { ok: false, error: 'Forge 自动安装失败：' + forgeRes.error };
      forgeVersionId = findInstalledForge(gameDir, mcVersion) || raw;
    }
    log(`[OptiFine] 将与 Forge ${forgeVersionId} 组合安装\n`);
  }

  // 3. 无人值守运行安装器（会把 OptiFine 库文件装进 libraries/optifine/）
  const before = snapshotVersions(gameDir);
  const run = await runOptiFineHeadless({
    jarPath: fetched.dest,
    gameDir,
    javaPath,
    onLog: log,
    timeoutMs: opts.timeoutMs,
  });
  const added = detectNewVersion(gameDir, before, log);
  if (!run.ok) {
    return {
      ok: false,
      error: (run.timeout ? '安装器超时' : '安装器返回码 ' + run.exitCode) + (run.output ? '：' + String(run.output).slice(-300) : ''),
      installerJar: fetched.dest,
    };
  }

  // 4. 组合版：基于 Forge 版本生成组合 json
  if (comboForge && forgeVersionId) {
    const edition = `${mcVersion}_${type}_${patch}`;
    const comboId = `${mcVersion}-Forge_${forgeVersionId.slice((mcVersion + '-forge-').length)}-OptiFine_${type}_${patch}`;
    const vdir = path.join(gameDir, 'versions', comboId);
    fs.mkdirSync(vdir, { recursive: true });
    const profile = {
      id: comboId,
      inheritsFrom: forgeVersionId,
      type: 'release',
      libraries: [
        { name: 'optifine:OptiFine:' + edition },
        { name: 'optifine:launchwrapper-of:2.3' },
      ],
      arguments: { game: ['--tweakClass', 'optifine.OptiFineForgeTweaker'] },
    };
    fs.writeFileSync(path.join(vdir, comboId + '.json'), JSON.stringify(profile, null, 2));
    log(`[OptiFine] 已生成组合版本：${comboId}（继承 ${forgeVersionId}）\n`);

    // 安装器顺带生成的 standalone 版本目录清掉，避免版本列表出现两份
    const standaloneId = run.versionId;
    if (standaloneId && standaloneId !== comboId && fs.existsSync(path.join(gameDir, 'versions', standaloneId))) {
      try {
        fs.rmSync(path.join(gameDir, 'versions', standaloneId), { recursive: true, force: true });
        log(`[OptiFine] 已清理独立版目录 ${standaloneId}\n`);
      } catch (e) {
        /* ignore */
      }
    }
    return { ok: true, versionId: comboId, addedVersions: [comboId], installerJar: fetched.dest, combo: true };
  }

  return {
    ok: true,
    versionId: run.versionId || (added[0] || `OptiFine_${mcVersion}_${type}_${patch}`),
    addedVersions: added,
    installerJar: fetched.dest,
  };
}

/* ---------------- 安装器（Forge / NeoForge / OptiFine）---------------- */

/** 下载安装器 jar 到 <gameDir>/installers */
async function fetchInstallerJar(opts) {
  const { gameDir, url, fileName, mirrorIds, onProgress } = opts;
  const log = opts.onLog || function () {};
  const dir = path.join(gameDir, 'installers');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) return { ok: true, dest, skipped: true };
  log(`[安装器] 下载 ${fileName} …\n`);
  const res = await downloadFile(candidatesFor(url, mirrorIds).concat([url]), dest, {
    onChunk: (len) => onProgress && onProgress({ bytes: len, phase: 'installer' }),
  });
  return Object.assign({ dest }, res);
}

/**
 * 运行安装器 jar（返回 Promise，实时输出通过 onLog 回调）
 * Forge/NeoForge 支持 --installClient；OptiFine 用 installOptiFine 里的无人值守逻辑
 */
function runInstallerJar({ jarPath, gameDir, javaPath, args, onLog, timeoutMs }) {
  ensureLauncherProfiles(gameDir);
  return new Promise((resolve, reject) => {
    const log = onLog || function () {};
    const cmd = javaPath || 'java';
    const extra = Array.isArray(args) ? args : [];
    // 有自定义参数时不再追加 --installClient（调用方自己决定）
    const argv = ['-Xmx1G'].concat(extra, ['-jar', jarPath], extra.length ? [] : ['--installClient']);
    const proc = spawn(cmd, argv, { cwd: gameDir, windowsHide: true });
    let output = '';
    const pump = (buf) => {
      const text = buf.toString('utf8');
      output += text;
      log(text);
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);
    proc.on('error', (e) => reject(new Error('安装器启动失败：' + e.message)));
    proc.on('close', (code) => resolve({ ok: code === 0, exitCode: code, output }));
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch (e) {
        /* ignore */
      }
      resolve({ ok: false, exitCode: null, output, timeout: true });
    }, timeoutMs || 15 * 60 * 1000);
    proc.on('close', () => clearTimeout(timer));
  });
}

/** 安装前后对比 versions 目录，找出新生成的版本 */
function detectNewVersion(gameDir, before, log) {
  const now = fs.readdirSync(path.join(gameDir, 'versions'));
  const added = now.filter((d) => !before.includes(d));
  if (added.length && log) log(`[安装器] 新增版本：${added.join(', ')}\n`);
  return added;
}

function snapshotVersions(gameDir) {
  const dir = path.join(gameDir, 'versions');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/**
 * Forge / NeoForge 一键安装：下载 installer -> 静默安装
 */
async function installForgeLike(opts) {
  const { gameDir, kind, rawVersion, installerUrl, fileName, mirrorIds, javaPath } = opts;
  const log = opts.onLog || function () {};
  ensureLauncherProfiles(gameDir);

  const fetched = await fetchInstallerJar({
    gameDir,
    url: installerUrl,
    fileName,
    mirrorIds,
    onLog: log,
    onProgress: opts.onProgress,
  });
  if (!fetched.ok) return { ok: false, error: '安装器下载失败：' + fetched.error };

  const before = snapshotVersions(gameDir);
  log(`[${kind}] 正在执行安装（可能需要几分钟，请勿中断）…\n`);
  const run = await runInstallerJar({
    jarPath: fetched.dest,
    gameDir,
    javaPath,
    onLog: log,
    timeoutMs: opts.timeoutMs,
  });
  const added = detectNewVersion(gameDir, before, log);
  return {
    ok: run.ok,
    error: run.ok ? null : kind + ' 安装器返回码 ' + run.exitCode + (run.timeout ? '（超时）' : ''),
    versionId: added[0] || rawVersion,
    addedVersions: added,
    installerJar: fetched.dest,
  };
}

module.exports = {
  ensureLauncherProfiles,
  listFabric,
  installFabric,
  listForge,
  forgeInstallerUrl,
  listNeoForge,
  listOptiFine,
  installOptiFine,
  installForgeLike,
  fetchInstallerJar,
  runInstallerJar,
  snapshotVersions,
};
