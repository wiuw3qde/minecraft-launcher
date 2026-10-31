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
// 每次构建用带时间戳的临时输出目录，避免旧的 win-unpacked 被系统/杀软锁住时
// electron-builder 无法清理而整体构建失败。最终安装包仍输出到 dist/。
const STAGE_OUT = path.join(root, 'dist', 'tmp-' + Date.now());
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

/** 校验 exe 的版本信息是否符合预期（防止历史构建残留导致的脏数据） */
function verifyExecutable(label) {
  if (!fs.existsSync(UNPACKED)) return;
  const exes = fs
    .readdirSync(UNPACKED)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .map((f) => ({ name: f, size: fs.statSync(path.join(UNPACKED, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (!exes.length) return;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-exe.js'), path.join(UNPACKED, exes[0].name), 'MC 启动器'], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`[build] ${label}校验未通过，请检查构建产物`);
    process.exit(1);
  }
}

/* ---------------- 主流程 ---------------- */

const dirOnly = process.argv.includes('--dir');

// 1. 打包应用本体（输出到带时间戳的临时目录，避开被锁的旧 win-unpacked）
runBuilder(['--win', '--x64', '--dir', '-c.directories.output=' + STAGE_OUT], '打包应用本体（' + UNPACKED + '）');

// 2. 注入图标与版本信息
editExecutable();

// 2.5 注入后立即校验，有问题当场失败
verifyExecutable('注入后');

if (dirOnly) {
  console.log('\n[build] 完成（仅目录模式）：dist/win-unpacked\n');
  process.exit(0);
}

// 3. 从注入过图标的目录生成安装包 + 便携版（最终产物仍输出到 dist/）
runBuilder(['--win', '--x64', '--prepackaged=' + UNPACKED, '-c.directories.output=' + path.join(root, 'dist')], '生成安装包与便携版');

// 3.5 最终校验（防止安装包生成过程又动了 exe）
verifyExecutable('最终');

console.log('\n[build] 全部完成，产物在 dist/ 目录：');
try {
  for (const f of fs.readdirSync(path.join(root, 'dist'))) {
    const st = fs.statSync(path.join(root, 'dist', f));
    if (st.isFile()) console.log('  - ' + f + '  (' + Math.round(st.size / 1048576) + ' MB)');
  }
} catch (e) {
  /* ignore */
}

// 4. 清理历史遗留的临时构建目录（跳过本次使用的 STAGE_OUT，失败忽略）
try {
  const distDir = path.join(root, 'dist');
  for (const f of fs.readdirSync(distDir)) {
    const full = path.join(distDir, f);
    if (/^tmp-\d+$/.test(f) && full !== STAGE_OUT) {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }
} catch (e) {
  /* ignore */
}

/** 生成更新服务器清单 latest.yml（electron-updater generic provider 格式） */
function genLatestYml() {
  const distDir = path.join(root, 'dist');
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
