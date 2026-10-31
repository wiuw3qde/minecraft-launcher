#!/usr/bin/env node
'use strict';
/**
 * 一键打包脚本（npm run dist / npm run dist:dir）。
 *
 * 背景：没有签名证书时，electron-builder 仍会下载并解压 winCodeSign 工具包，
 * 而该包的 rcedit 负责给 exe 注入图标和版本信息。问题有两个：
 *   1. GitHub release 下载时快时慢，偶尔 Bad Gateway；
 *   2. 解压其中的 macOS 符号链接需要管理员/开发者模式权限，普通用户必然失败。
 * 所以这里把流程拆成三步，全程不依赖 winCodeSign：
 *   1) electron-builder --dir          生成未打包应用（配置里已禁用它自带的资源编辑）
 *   2) 用项目自带的 rcedit 注入图标与版本信息
 *   3) electron-builder --prepackaged  从已注入图标的目录生成安装包 + 便携版
 *
 * 以后加了新功能，直接跑 npm run dist 即可重新打包。
 */
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

/**
 * 把本地中文产物名映射成 ASCII 名。GitHub 的 Release 资产上传接口对中文 name
 * 参数会损坏（落到 default.txt 或乱码），而更新器只按 latest.yml 里的文件名
 * 去匹配下载，因此 GitHub 资产名 + latest.yml 里的名必须都是 ASCII 且一致。
 */
function asciiName(f) {
  return f
    .replace(/^MC启动器-/, 'MC-Launcher-')
    .replace(/-便携版(?=\.)/, '-portable')
    .replace(/[^\x20-\x7E]/g, ''); // 兜底：移除任何残留非 ASCII（含中文）
}

const CLI = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const RCEDIT = path.join(root, 'assets', 'tools', 'rcedit-x64.exe');
const ICON = path.join(root, 'assets', 'icon.ico');
// 构建产物根目录：默认 dist/，可通过 BUILD_OUT_DIR 指定到其他盘（C 盘空间不足时
// 把解压/打包产物放到 D: 等空闲盘，避免「磁盘空间不足」导致构建失败）。
const OUT_BASE = process.env.BUILD_OUT_DIR || path.join(root, 'dist');
// 每次构建用带时间戳的临时输出目录，避免旧的 win-unpacked 被系统/杀软锁住时
// electron-builder 无法清理而整体构建失败。最终安装包仍输出到 OUT_BASE。
const STAGE_OUT = path.join(OUT_BASE, 'tmp-' + Date.now());
const UNPACKED = path.join(STAGE_OUT, 'win-unpacked');
function bumpVersion() {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const parts = String(pkg.version || '0.0.0').split('.');
  while (parts.length < 3) parts.push('0');
  let patch = parseInt(parts[2], 10);
  if (isNaN(patch)) patch = 0;
  parts[2] = String(patch + 1);
  pkg.version = parts.join('.');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return pkg.version;
}
const VERSION = bumpVersion();
console.log('[build] 版本号已自动递增为 ' + VERSION);

/** 运行 electron-builder CLI，失败即中止 */
function runBuilder(args, label) {
  console.log(`\n[build] === ${label} ===`);
  const r = spawnSync(process.execPath, [CLI].concat(args), { stdio: 'inherit', cwd: root });
  if (r.error || r.status !== 0) {
    console.error(`[build] ${label} 失败（退出码 ${r.status}）`);
    process.exit(r.status === null ? 1 : r.status);
  }
}

/** 给主 exe 注入图标与版本信息（rcedit 已随项目分发，无需联网） */
function editExecutable() {
  if (!fs.existsSync(RCEDIT)) {
    console.error('[build] 找不到自带的 rcedit：' + RCEDIT);
    process.exit(1);
  }
  if (!fs.existsSync(UNPACKED)) {
    console.error('[build] 找不到未打包目录：' + UNPACKED);
    process.exit(1);
  }
  // 主程序是 win-unpacked 里体积最大的那个 exe
  const candidates = fs
    .readdirSync(UNPACKED)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .map((f) => ({ name: f, size: fs.statSync(path.join(UNPACKED, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (!candidates.length) {
    console.error('[build] win-unpacked 里没有 exe');
    process.exit(1);
  }
  const exePath = path.join(UNPACKED, candidates[0].name);
  console.log(`\n[build] === 注入图标/版本信息：${exePath} ===`);
  const args = [
    exePath,
    '--set-icon',
    ICON,
    '--set-version-string',
    'CompanyName',
    'mc-launcher',
    '--set-version-string',
    'ProductName',
    'MC 启动器',
    '--set-version-string',
    'FileDescription',
    'Minecraft Java 版启动器',
    '--set-file-version',
    VERSION + '.0',
    '--set-product-version',
    VERSION + '.0',
  ];
  const r = spawnSync(RCEDIT, args, { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error('[build] 图标注入失败：' + (r.error ? r.error.message : '退出码 ' + r.status));
    process.exit(1);
  }
  console.log('[build] 图标与版本信息注入完成');
}

/** 校验 exe 的版本信息是否符合预期（防止历史构建残留导致的脏数据）。
 *  返回 true/false，不再自行 exit，交给调用方决定是否重试。 */
function verifyExecutable(label) {
  if (!fs.existsSync(UNPACKED)) {
    console.warn('[build] 跳过校验：' + UNPACKED + ' 不存在');
    return false;
  }
  const exes = fs
    .readdirSync(UNPACKED)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .map((f) => ({ name: f, size: fs.statSync(path.join(UNPACKED, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (!exes.length) {
    console.warn('[build] 跳过校验：win-unpacked 里没有 exe');
    return false;
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-exe.js'), path.join(UNPACKED, exes[0].name), 'MC 启动器'], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`[build] ${label}校验未通过`);
    return false;
  }
  return true;
}

/** 带重试的校验：杀软偶尔会短暂锁住刚生成/刚注入的 exe，导致偶发读取失败，重试可稳过 */
function verifyExecutableWithRetry(label, attempts) {
  const n = attempts || 3;
  for (let attempt = 1; attempt <= n; attempt++) {
    if (verifyExecutable(`${label}(第${attempt}次)`)) return true;
    if (attempt < n) {
      console.warn(`[build] 校验失败，${attempt < n ? '1 秒后重试…' : '已放弃'}`);
      try { require('child_process').execSync('ping -n 2 127.0.0.1 >nul 2>&1'); } catch (_) { /* ignore */ }
    }
  }
  return false;
}

/* ---------------- 主流程 ---------------- */

const dirOnly = process.argv.includes('--dir');

// 1. 打包应用本体（输出到带时间戳的临时目录，避开被锁的旧 win-unpacked）
runBuilder(['--win', '--x64', '--dir', '-c.directories.output=' + STAGE_OUT], '打包应用本体（' + UNPACKED + '）');

// 2. 注入图标与版本信息
editExecutable();

/**
 * 兜底写入 resources/app-update.yml。
 * electron-updater 在「下载更新」阶段（必然）以及「未先 setFeedURL 就检查」时会去读
 * resources/app-update.yml 取 updaterCacheDirName / provider 配置；若该文件缺失，
 * 更新会直接报 ENOENT。正常情况下 electron-builder 会因上面的 build.publish 自动生成它，
 * 这里再兜底一次，保证任何情况下打包产物里都有这个文件。
 */
function ensureAppUpdateYml() {
  const resDir = path.join(UNPACKED, 'resources');
  const target = path.join(resDir, 'app-update.yml');
  if (fs.existsSync(target)) {
    console.log('[build] app-update.yml 已存在（electron-builder 生成），跳过兜底写入');
    return;
  }
  fs.mkdirSync(resDir, { recursive: true });
  const lines = [
    'owner: wiuw3qde',
    'repo: minecraft-launcher',
    'provider: github',
    'updaterCacheDirName: mc-launcher-updater',
    '',
  ];
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  console.log('[build] 已兜底写入 resources/app-update.yml');
}
ensureAppUpdateYml();

// 2.5 注入后立即校验（带重试，规避杀软偶发锁文件）
if (!verifyExecutableWithRetry('注入后', 3)) {
  console.error('[build] 图标注入/校验多次失败，终止构建');
  process.exit(1);
}

if (dirOnly) {
  console.log('\n[build] 完成（仅目录模式）：dist/win-unpacked\n');
  process.exit(0);
}

// 3. 从注入过图标的目录生成安装包 + 便携版（最终产物输出到 OUT_BASE）
runBuilder(['--win', '--x64', '--prepackaged=' + UNPACKED, '-c.directories.output=' + OUT_BASE], '生成安装包与便携版');

// 3.5 最终校验（防止安装包生成过程又动了 exe，带重试）
if (!verifyExecutableWithRetry('最终', 3)) {
  console.error('[build] 最终校验多次失败，终止构建');
  process.exit(1);
}

console.log('\n[build] 全部完成，产物在 ' + OUT_BASE + ' 目录：');
try {
  for (const f of fs.readdirSync(OUT_BASE)) {
    const st = fs.statSync(path.join(OUT_BASE, f));
    if (st.isFile()) console.log('  - ' + f + '  (' + Math.round(st.size / 1048576) + ' MB)');
  }
} catch (e) {
  /* ignore */
}

// 4. 清理历史遗留的临时构建目录（跳过本次使用的 STAGE_OUT，失败忽略）
try {
  for (const f of fs.readdirSync(OUT_BASE)) {
    const full = path.join(OUT_BASE, f);
    if (/^tmp-\d+$/.test(f) && full !== STAGE_OUT) {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }
} catch (e) {
  /* ignore */
}

// 5. 若产物输出到了非默认盘（BUILD_OUT_DIR），把最新版的安装包/便携版/更新清单
//    同步回项目 dist/，方便本地直接拿最新包测试（C 盘空间不足时跳过该步）。
if (OUT_BASE !== path.join(root, 'dist')) {
  try {
    const targetDir = path.join(root, 'dist');
    fs.mkdirSync(targetDir, { recursive: true });
    const assets = fs.readdirSync(OUT_BASE).filter((f) => /\.exe$/i.test(f) || f === 'latest.yml');
    const VERSION_SAFE = VERSION;
    const keep = assets.filter((f) => f.includes(VERSION_SAFE) || f === 'latest.yml');
    for (const f of keep) {
      fs.copyFileSync(path.join(OUT_BASE, f), path.join(targetDir, f));
    }
    console.log('[build] 已把当前版本产物同步回 dist/（' + keep.length + ' 个文件）');
  } catch (e) {
    console.warn('[build] 同步回 dist/ 失败（可忽略，发布仍从 BUILD_OUT_DIR 读取）：' + e.message);
  }
}

/** 生成更新服务器清单 latest.yml（electron-updater generic provider 格式） */
function genLatestYml() {
  const distDir = OUT_BASE;
  let exes = [];
  try {
    // 只把当前版本的安装包/便携版写进更新清单，避免历史版本堆积导致 latest.yml 膨胀
    exes = fs.readdirSync(distDir).filter((f) => /\.exe$/i.test(f) && f.includes(VERSION));
  } catch (e) {
    return;
  }
  if (!exes.length) return;
  const crypto = require('crypto');
  const items = exes
    .map((f) => {
      const buf = fs.readFileSync(path.join(distDir, f));
      return { file: f, sha512: crypto.createHash('sha512').update(buf).digest('base64'), size: buf.length };
    })
    .sort((a, b) => b.size - a.size);
  const primary = items[0];
  const releaseDate = new Date().toISOString();
  // 用「行数组 + join('\n')」构造 YAML，避免字符串拼接里 \n 被误解成字面量 /n（曾导致 latest.yml 解析失败）
  const lines = [];
  lines.push('version: ' + VERSION);
  lines.push("releaseDate: '" + releaseDate + "'");
  lines.push('files:');
  items.forEach((x) => {
    lines.push("  - url: '" + asciiName(x.file) + "'");
    lines.push('    sha512: ' + x.sha512);
    lines.push('    size: ' + x.size);
  });
  lines.push("path: '" + asciiName(primary.file) + "'");
  lines.push('sha512: ' + primary.sha512);
  const yml = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(distDir, 'latest.yml'), yml, 'utf8');
  console.log('[build] 已生成 latest.yml（更新清单，主文件 ' + primary.file + '）');
}
genLatestYml();

console.log('');
