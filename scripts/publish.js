#!/usr/bin/env node
/**
 * 发布脚本：把 dist/ 下的安装包 + latest.yml 上传到 GitHub Release，
 * Release 正文自动由 git 提交历史生成（即更新日志）。
 *
 * 用法：
 *   node scripts/publish.js
 *   GH_TOKEN=xxx node scripts/publish.js
 *   node scripts/publish.js --repo owner/name   # 覆盖默认仓库
 *
 * 令牌来源（按顺序）：环境变量 GH_TOKEN → 本地 .github_token 文件（已被 .gitignore 忽略）。
 * 默认仓库：wiuw3qde/minecraft-launcher（可用 --repo 覆盖）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// 构建产物目录：默认 dist/，与 build.js 的 BUILD_OUT_DIR 保持一致；
// C 盘空间不足时 build.js 会把产物输出到其他盘（如 D:），发布也从同一目录读取。
const DIST_DIR = process.env.BUILD_OUT_DIR || path.join(ROOT, 'dist');
const API = 'https://api.github.com';
// GitHub 的 Release 资源（创建/读取）走 api.github.com，
// 但「上传资产」必须走独立主机 uploads.github.com，用 api 域会上传 404。
const UPLOAD_API = 'https://uploads.github.com';

// ---------- 参数 / 配置 ----------
const args = process.argv.slice(2);
let repoOverride = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1]) repoOverride = args[++i];
}
const DEFAULT_REPO = 'wiuw3qde/minecraft-launcher';
const repo = repoOverride || process.env.GH_REPO || DEFAULT_REPO;
// 这些值在 main() 里才初始化：本文件也会被单测 require，顶层不能 process.exit。
let OWNER = '';
let REPO_NAME = '';
let TOKEN = '';

// ---------- 令牌 ----------
function loadToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const f = path.join(ROOT, '.github_token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}

/**
 * 把本地中文产物名映射成 ASCII 名（与 build.js 保持一致）。
 * GitHub 资产上传对中文 name 会损坏，更新器按 latest.yml 里的文件名下载，
 * 所以 GitHub 资产名与 latest.yml 必须都是 ASCII 且一致。
 */
function asciiName(f) {
  return f
    .replace(/^MC启动器-/, 'MC-Launcher-')
    .replace(/-便携版(?=\.)/, '-portable')
    .replace(/[^\x20-\x7E]/g, '');
}

/**
 * 读取更新清单里的 version 字段（latest.yml / latest-mac.yml 均为 YAML 单行）。
 * 读不到返回空串，由调用方判定为不一致。
 */
function readYmlVersion(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^\s*version:\s*['"]?([^\s'"]+)['"]?\s*$/m);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

/**
 * 双平台发布前的资产一致性校验（纯函数，Windows 上也能单测 Mac 场景）。
 *
 * 存在的真实风险：dist/ 里常残留上一版的 latest.yml / latest-mac.yml，而资产筛选里
 * 两个清单是「无条件上传」的。若 Mac 端用 0.2.3 的清单去补 0.2.4 的 Release，
 * 会把旧清单覆盖上去 → 对应平台要么收不到更新、要么反复提示更新。
 * 分两次发布（Windows 先、Mac 后）时每侧只有自己那一半，不能要求两侧资产齐全，
 * 因此按「本次实际存在的清单/包」分组校验。
 *
 * @returns {{ok:boolean, errors:string[], win:string[], mac:string[]}}
 */
function validateReleaseAssets(distDir, version) {
  const errors = [];
  let names = [];
  try {
    names = fs.readdirSync(distDir);
  } catch (e) {
    return { ok: false, errors: ['读取产物目录失败：' + e.message], win: [], mac: [] };
  }
  const ofVersion = (f) => asciiName(f).includes(version);
  const win = names.filter((f) => /\.exe$/i.test(f) && ofVersion(f));
  const macZip = names.filter((f) => /\.zip$/i.test(f) && ofVersion(f));
  const macDmg = names.filter((f) => /\.dmg$/i.test(f) && ofVersion(f));
  const mac = macZip.concat(macDmg);
  const hasWinYml = names.indexOf('latest.yml') >= 0;
  const hasMacYml = names.indexOf('latest-mac.yml') >= 0;

  if (hasWinYml) {
    const v = readYmlVersion(path.join(distDir, 'latest.yml'));
    if (v !== version) {
      errors.push('latest.yml 的版本是 ' + (v || '未知') + '，与本次发布 ' + version + ' 不一致（请先重新打包，别上传旧清单）');
    }
    if (!win.length) errors.push('存在 latest.yml，但缺少 ' + version + ' 的 Windows .exe');
  } else if (win.length) {
    errors.push('存在 ' + version + ' 的 Windows 安装包，但缺少 latest.yml（Windows 端会收不到更新）');
  }

  if (hasMacYml) {
    const v = readYmlVersion(path.join(distDir, 'latest-mac.yml'));
    if (v !== version) {
      errors.push('latest-mac.yml 的版本是 ' + (v || '未知') + '，与本次发布 ' + version + ' 不一致（Mac 端请用 ' + version + ' 重新跑 npm run dist:mac）');
    }
    if (!macZip.length) errors.push('存在 latest-mac.yml，但缺少 ' + version + ' 的 .zip（MacUpdater 只接受 zip）');
  } else if (mac.length) {
    errors.push('存在 ' + version + ' 的 Mac 安装包，但缺少 latest-mac.yml（Mac 端会收不到更新）');
  }

  if (!win.length && !mac.length) errors.push('dist/ 内没有 ' + version + ' 的任何安装包');
  return { ok: errors.length === 0, errors, win, mac };
}

// ---------- 版本 ----------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TAG = 'v' + VERSION;

// ---------- GitHub API 封装 ----------
function gh(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      API + p,
      {
        method,
        headers: {
          'Authorization': 'token ' + TOKEN,
          'User-Agent': 'mc-launcher-publish',
          'Accept': 'application/vnd.github+json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = buf ? JSON.parse(buf) : null; } catch (e) { /* ignore */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error('HTTP ' + res.statusCode + ' ' + (json && json.message ? json.message : buf.slice(0, 200))));
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 上传二进制资产（流式，支持大文件）
function uploadAsset(releaseId, filePath) {
  return new Promise((resolve, reject) => {
    const name = asciiName(path.basename(filePath));
    const stat = fs.statSync(filePath);
    const req = https.request(
      UPLOAD_API + `/repos/${OWNER}/${REPO_NAME}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'token ' + TOKEN,
          'User-Agent': 'mc-launcher-publish',
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = buf ? JSON.parse(buf) : null; } catch (e) { /* ignore */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error('上传 ' + name + ' 失败 HTTP ' + res.statusCode + ' ' + (json && json.message ? json.message : buf.slice(0, 200))));
        });
      }
    );
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req);
  });
}

// ---------- 更新日志 ----------
/** 从「上一个 tag..HEAD」摘取提交标题，过滤纯版本号 / chore 噪声 */
function gitLogLines() {
  let lastTag = '';
  try { lastTag = execSync('git describe --tags --abbrev=0', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { lastTag = ''; }
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  let log = '';
  try {
    log = execSync(`git log ${range} --pretty=format:"- %s (%h)"`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) { log = ''; }
  return log ? log.split('\n').filter((l) => !/^(chore|version|bump)[: ]/i.test(l.trim())) : [];
}

/**
 * Release 正文：
 *  - 若存在 releases/<TAG>.md（手写、面向用户的正式说明），以它为主体，末尾附提交清单；
 *  - 否则回退到「由 git 提交历史自动生成」，保证不写说明也能正常发版。
 */
function buildChangelog() {
  const date = new Date().toISOString().slice(0, 10);
  const notesPath = path.join(ROOT, 'releases', TAG + '.md');
  const hasNotes = fs.existsSync(notesPath);
  const lines = gitLogLines();
  let body;
  if (hasNotes) {
    body = fs.readFileSync(notesPath, 'utf8').trim();
    console.log('[publish] 采用手写 Release 说明：releases/' + TAG + '.md');
    if (lines.length) body += '\n\n### 本次包含的提交\n' + lines.join('\n') + '\n';
  } else {
    body = `## MC 启动器 ${TAG}（${date}）\n\n`;
    body += lines.length
      ? '### 更新内容\n' + lines.join('\n') + '\n'
      : '（本次发布无新增提交记录，可能是资源/构建调整）\n';
  }
  body += '\n---\n自动发布于 `npm run ship` · ' + date +
    (hasNotes ? ' · 正文来自 releases/' + TAG + '.md' : ' · 由 git 提交历史生成');
  return body;
}

// ---------- 主流程 ----------
async function main() {
  [OWNER, REPO_NAME] = repo.split('/');
  if (!OWNER || !REPO_NAME) {
    console.error('[publish] 仓库格式应为 owner/name，当前：' + repo);
    process.exit(1);
  }
  TOKEN = loadToken();
  if (!TOKEN) {
    console.error('[publish] 未找到 GitHub 令牌：请设置环境变量 GH_TOKEN，或在项目根目录放一个 .github_token 文件（已被 gitignore 忽略）。');
    process.exit(1);
  }
  console.log('[publish] 仓库', repo, '版本', TAG);

  const distDir = DIST_DIR;
  if (!fs.existsSync(distDir)) {
    console.error('[publish] 找不到 dist/ 目录，请先运行 npm run dist 打包。');
    process.exit(1);
  }
  // 双平台发布前先校验：旧版清单绝不能被上传到新版 Release。
  const check = validateReleaseAssets(distDir, VERSION);
  console.log('[publish] 资产校验：' + VERSION + ' · Windows 包 ' + check.win.length + ' 个 · Mac 包 ' + check.mac.length + ' 个'
    + (check.ok ? ' ✓' : ' ✗'));
  if (!check.ok) {
    check.errors.forEach((e) => console.error('[publish] ✗ ' + e));
    process.exit(1);
  }
  // 待上传资产：latest.yml + 仅当前版本的安装包与便携版
  // （避免历史版本 exe 反复堆积在单个 Release 里，保持每个 Release 自包含）
  const assets = fs.readdirSync(distDir)
    .filter((f) => {
      // Windows 与 macOS 共用同一个 Release：两份更新清单 + 各自的安装包都要在。
      // darwin 下 electron-updater 强制读 latest-mac.yml，且 MacUpdater 只接受 .zip。
      if (f === 'latest.yml' || f === 'latest-mac.yml') return true;
      return /\.(exe|dmg|zip)$/i.test(f) && f.includes(VERSION);
    })
    .map((f) => path.join(distDir, f));
  if (!assets.length) {
    console.error('[publish] dist/ 内没有可上传的产物（exe/dmg/zip）或更新清单（latest.yml / latest-mac.yml）。');
    process.exit(1);
  }
  console.log('[publish] 待上传资产：\n  ' + assets.map((a) => path.basename(a) + ' (' + (fs.statSync(a).size / 1048576).toFixed(1) + ' MB)').join('\n  '));

  // 1) 查找或创建 Release
  let release;
  try {
    release = await gh('GET', `/repos/${OWNER}/${REPO_NAME}/releases/tags/${TAG}`);
    console.log('[publish] 已存在 Release', TAG, '（id=' + release.id + '），将补充缺失资产');
  } catch (e) {
    if (!/HTTP 404/.test(e.message)) throw e;
    const body = buildChangelog();
    release = await gh('POST', `/repos/${OWNER}/${REPO_NAME}/releases`, {
      tag_name: TAG,
      name: TAG,
      body,
      draft: false,
      prerelease: false,
    });
    console.log('[publish] 已创建 Release', TAG, '（id=' + release.id + '）');
  }
  const existing = new Set((release.assets || []).map((a) => a.name));

  // 2) 上传缺失资产
  for (const f of assets) {
    const name = path.basename(f);
    // GitHub 上的资产名经 asciiName 转换过（中文会损坏），判断重名时必须用同一个名字，
    // 否则重复执行发布会尝试再次上传同名资产而被 422 already_exists 拒绝。
    if (existing.has(asciiName(name))) {
      console.log('[publish] 跳过已存在资产：', name);
      continue;
    }
    console.log('[publish] 上传中：', name, '…');
    await uploadAsset(release.id, f);
    console.log('[publish]   完成：', name);
  }

  console.log('\n[publish] ✅ 发布完成：');
  console.log('  Release: https://github.com/' + OWNER + '/' + REPO_NAME + '/releases/tag/' + TAG);
  console.log('  启动器设置页「自动更新」地址应填：https://github.com/' + OWNER + '/' + REPO_NAME);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[publish] ❌ 失败：', e.message);
    process.exit(1);
  });
}
module.exports = { readYmlVersion, validateReleaseAssets, asciiName };
