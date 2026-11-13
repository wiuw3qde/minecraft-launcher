#!/usr/bin/env node
'use strict';
/**
 * macOS(Intel x64) 本地构建脚本 —— 在 Mac 上执行 `npm run dist:mac`。
 *
 * 为什么独立成文件、而不改 scripts/build.js：
 *   build.js 是 Windows 三步流程（--win --dir → rcedit 往 PE 注入图标/版本 → --prepackaged），
 *   整条链路依赖 win-unpacked/*.exe。硬塞 darwin 分支会直接危及已发布的 Windows 打包。
 *   macOS 用 electron-builder 标准一次成型即可，两条链路互不干扰（用户要求「原功能不动」）。
 *
 * 产物（dist/）：
 *   MC-Launcher-<ver>-x64.dmg    用户安装用
 *   MC-Launcher-<ver>-x64.zip    electron-updater 必需（MacUpdater 只接受 zip）
 *   latest-mac.yml               Mac 端更新清单（darwin 下 channel 强制为 latest-mac）
 *
 * 注意：本脚本**不改 package.json 版本号**。版本号在发布前统一手动设定，
 * Windows 侧的 build.js 也只在 patch===9 时进位，不会因顺序不同而错乱。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const DIST = process.env.BUILD_OUT_DIR || path.join(ROOT, 'dist');

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

/** 与 build.js / publish.js 保持同一套 ASCII 映射，确保清单 url 与 GitHub 资产名一致 */
function asciiName(f) {
  return f
    .replace(/^MC启动器-/, 'MC-Launcher-')
    .replace(/-便携版(?=\.)/, '-portable')
    .replace(/[^\x20-\x7E]/g, '');
}

/**
 * 生成 latest-mac.yml（electron-updater generic provider 格式）。
 * 导出以便在没有 Mac 的机器上用单测验证格式 —— 这是「自动更新能收到 Mac 版」的关键环节。
 * @returns {{ok:boolean, error?:string, file?:string, primary?:string, count?:number}}
 */
function genMacYml(distDir, version, now) {
  let names;
  try {
    names = fs.readdirSync(distDir)
      .filter((f) => f.includes(version) && /\.(zip|dmg)$/i.test(f));
  } catch (e) {
    return { ok: false, error: '读取产物目录失败：' + e.message };
  }
  if (!names.some((f) => /\.zip$/i.test(f))) {
    return { ok: false, error: '未找到 .zip 产物：MacUpdater 强制要求 zip，只有 dmg 会导致更新失败' };
  }
  const items = names.map((f) => {
    const buf = fs.readFileSync(path.join(distDir, f));
    return { file: asciiName(f), sha512: crypto.createHash('sha512').update(buf).digest('base64'), size: buf.length };
  });
  // zip 必须排第一并作为 path（MacUpdater.findFile(files,'zip',['pkg','dmg'])）
  items.sort((a, b) => {
    const az = /\.zip$/i.test(a.file) ? 0 : 1;
    const bz = /\.zip$/i.test(b.file) ? 0 : 1;
    return az - bz || b.size - a.size;
  });
  const primary = items[0];
  const lines = [];
  lines.push('version: ' + version);
  lines.push("releaseDate: '" + (now || new Date().toISOString()) + "'");
  lines.push('files:');
  items.forEach((x) => {
    lines.push("  - url: '" + x.file + "'");
    lines.push('    sha512: ' + x.sha512);
    lines.push('    size: ' + x.size);
  });
  lines.push("path: '" + primary.file + "'");
  lines.push('sha512: ' + primary.sha512);
  fs.writeFileSync(path.join(distDir, 'latest-mac.yml'), lines.join('\n') + '\n', 'utf8');
  return { ok: true, file: 'latest-mac.yml', primary: primary.file, count: items.length };
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('[build-mac] 本脚本只能在 macOS 上运行（Windows 请用 npm run dist）。');
    process.exit(2);
  }
  if (!fs.existsSync(CLI)) {
    console.error('[build-mac] 找不到 electron-builder，请先在 Mac 上执行 npm install。');
    process.exit(2);
  }
  const version = readVersion();
  console.log('[build-mac] 版本 ' + version + ' · 目标 macOS x64 (Intel) · 产物目录 ' + DIST);

  // 无 Developer ID 时让 electron-builder 做 ad-hoc 签名；绝不全局禁用自动发现。
  const env = Object.assign({}, process.env, { CSC_IDENTITY_AUTO_DISCOVERY: 'true' });
  const r = spawnSync(process.execPath, [CLI, '--mac', '--x64', '--publish', 'never'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  if (r.status !== 0) {
    console.error('[build-mac] electron-builder 失败，退出码 ' + r.status);
    process.exit(r.status || 1);
  }

  const y = genMacYml(DIST, version);
  if (!y.ok) {
    console.error('[build-mac] 生成 latest-mac.yml 失败：' + y.error);
    process.exit(1);
  }
  console.log('\n[build-mac] ✅ 构建完成：');
  fs.readdirSync(DIST)
    .filter((f) => f.includes(version) && /\.(dmg|zip)$/i.test(f))
    .forEach((f) => console.log('  - ' + f + ' (' + (fs.statSync(path.join(DIST, f)).size / 1048576).toFixed(1) + ' MB)'));
  console.log('  - latest-mac.yml（主文件 ' + y.primary + '，共 ' + y.count + ' 项）');
  console.log('\n下一步：把以上 3 个文件上传到同一 GitHub Release（可在 Mac 上跑 node scripts/publish.js，');
  console.log('它会补齐 latest-mac.yml + dmg + zip，不会动 Windows 资产）。');
  console.log('首次打开若被 Gatekeeper 拦：右键 App →「打开」，或 xattr -cr /Applications/"MC 启动器.app"');
}

if (require.main === module) main();
module.exports = { genMacYml, asciiName, readVersion };
