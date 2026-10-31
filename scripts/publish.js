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
const [OWNER, REPO_NAME] = repo.split('/');
if (!OWNER || !REPO_NAME) {
  console.error('[publish] 仓库格式应为 owner/name，当前：' + repo);
  process.exit(1);
}

// ---------- 令牌 ----------
function loadToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const f = path.join(ROOT, '.github_token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}
const TOKEN = loadToken();
if (!TOKEN) {
  console.error('[publish] 未找到 GitHub 令牌：请设置环境变量 GH_TOKEN，或在项目根目录放一个 .github_token 文件（已被 gitignore 忽略）。');
  process.exit(1);
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

// ---------- 版本 ----------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TAG = 'v' + VERSION;
console.log('[publish] 仓库', repo, '版本', TAG);

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

// ---------- 更新日志（git 提交历史） ----------
function buildChangelog() {
  let lastTag = '';
  try { lastTag = execSync('git describe --tags --abbrev=0', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { lastTag = ''; }
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  let log = '';
  try {
    log = execSync(`git log ${range} --pretty=format:"- %s (%h)"`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) { log = ''; }
  // 过滤掉纯版本号自增 / chore 类噪声提交
  const lines = log
    ? log.split('\n').filter((l) => !/^(chore|version|bump)[: ]/i.test(l.trim()))
    : [];
  const date = new Date().toISOString().slice(0, 10);
  let body = `## MC 启动器 ${TAG}（${date}）\n\n`;
  if (lines.length) {
    body += '### 更新内容\n' + lines.join('\n') + '\n';
  } else {
    body += '（本次发布无新增提交记录，可能是资源/构建调整）\n';
  }
  body += '\n---\n自动发布于 `npm run ship` · 由 git 提交历史生成';
  return body;
}

// ---------- 主流程 ----------
(async () => {
  const distDir = DIST_DIR;
  if (!fs.existsSync(distDir)) {
    console.error('[publish] 找不到 dist/ 目录，请先运行 npm run dist 打包。');
    process.exit(1);
  }
  // 待上传资产：latest.yml + 仅当前版本的安装包与便携版
  // （避免历史版本 exe 反复堆积在单个 Release 里，保持每个 Release 自包含）
  const assets = fs.readdirSync(distDir)
    .filter((f) => {
      if (f === 'latest.yml') return true;
      return /\.exe$/i.test(f) && f.includes(VERSION);
    })
    .map((f) => path.join(distDir, f));
  if (!assets.length) {
    console.error('[publish] dist/ 内没有可上传的 exe / latest.yml。');
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
    if (existing.has(name)) {
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
})().catch((e) => {
  console.error('[publish] ❌ 失败：', e.message);
  process.exit(1);
});
