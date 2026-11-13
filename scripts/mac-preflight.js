#!/usr/bin/env node
'use strict';
/**
 * macOS 构建环境自检（在 Mac 上跑 `npm run mac:check`）。
 * 只读检查，不改动项目；把终端输出整段贴回对话即可定位问题。
 * 同时写一份 dist/mac-preflight.txt 便于留存（dist/ 已被 gitignore）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const lines = [];

function out(s) { lines.push(s); console.log(s); }
function mark(ok, s) { out((ok === true ? '[✓] ' : ok === 'warn' ? '[!] ' : '[✗] ') + s); }
function cmd(c, args) {
  try {
    return String(execFileSync(c, args || [], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch (e) { return ''; }
}
function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

out('=== MC 启动器 · macOS 构建环境自检 ===');
out('时间：' + new Date().toISOString());
out('');

/* --- 1. 机器 --- */
out('--- 1. 机器 ---');
const isMac = process.platform === 'darwin';
mark(isMac, '操作系统：' + process.platform + ' / ' + os.release() + (isMac ? '' : '（本脚本应在 macOS 上运行）'));
const machine = isMac ? (cmd('uname', ['-m']) || os.arch()) : os.arch();
mark(machine === 'x86_64', 'CPU 架构：' + machine + (machine === 'x86_64' ? '（Intel，目标平台 ✓）'
  : machine === 'arm64' ? '（Apple Silicon：本轮只出 x64 包，需要 Rosetta 2，且 TUN 授权路径不同）'
    : '（未知架构）'));
if (isMac) out('     macOS 版本：' + (cmd('sw_vers', ['-productVersion']) || '未知'));
out('     Node 架构（进程）：' + process.arch + ' · Node ' + process.version);
out('');

/* --- 2. 工具链 --- */
out('--- 2. 工具链 ---');
const nodeV = cmd(process.execPath, ['-v']);
const npmV = cmd('npm', ['-v']);
mark(!!nodeV, 'Node：' + (nodeV || '不可用'));
mark(!!npmV, 'npm：' + (npmV || '不可用'));
const clt = isMac ? cmd('xcode-select', ['-p']) : '';
mark(!!clt, 'Xcode Command Line Tools：' + (clt || '未安装（构建 .app / dmg 前需执行 xcode-select --install）'));
const iconutil = isMac ? cmd('which', ['iconutil']) : '';
mark(!!iconutil, 'iconutil（从 assets/icon.png 生成 icns）：' + (iconutil || '未找到'));
const identities = isMac ? cmd('security', ['find-identity', '-v', '-p', 'codesigning']) : '';
const hasCert = /valid identities found|^\s*\d+\)/m.test(identities) && !/0 valid identities found/.test(identities);
mark(hasCert ? true : 'warn', 'Developer ID 签名证书：' + (hasCert ? '已找到（可做正式签名）' : '未找到 → 将使用 ad-hoc 签名，用户首次打开需手动放行 Gatekeeper'));
if (identities) out('     ' + identities.split('\n').slice(0, 4).join(' / '));
if (isMac) out('     Gatekeeper：' + (cmd('spctl', ['--status']) || '未知'));
out('');

/* --- 3. 项目就绪 --- */
out('--- 3. 项目就绪 ---');
let version = '?';
try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (e) { /* ignore */ }
out('     版本：' + version);
mark(exists(path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js')), 'electron-builder：' + (exists(path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js')) ? '已安装' : '未安装 → 先跑 npm install'));
mark(exists(path.join(ROOT, 'node_modules', 'electron', 'dist')), 'Electron：' + (exists(path.join(ROOT, 'node_modules', 'electron', 'dist')) ? '已安装' : '未安装'));
const icon = path.join(ROOT, 'assets', 'icon.png');
let iconSize = '';
if (exists(icon)) {
  try { const b = fs.readFileSync(icon); iconSize = b.readUInt32BE(16) + 'x' + b.readUInt32BE(20); } catch (e) { /* ignore */ }
}
mark(iconSize === '1024x1024', '图标源 assets/icon.png：' + (iconSize || '缺失或未识别') + '（electron-builder 会自动生成 icon.icns）');
mark(exists(path.join(ROOT, 'scripts', 'build-mac.js')), '构建脚本 scripts/build-mac.js 存在');
out('');

/* --- 4. 自动更新 / 联机现状 --- */
out('--- 4. 自动更新与联机 ---');
mark(exists(path.join(DIST, 'latest-mac.yml')) ? true : 'warn',
  'dist/latest-mac.yml：' + (exists(path.join(DIST, 'latest-mac.yml')) ? '已生成' : '尚未生成（跑 npm run dist:mac 后自动生成）'));
const daemon = '/Library/LaunchAgents/net.burningtnt.terracotta.daemon.plist';
mark(exists(daemon) ? true : 'warn',
  '陶瓦联机守护进程：' + (exists(daemon) ? '已安装' : '未安装 → 首次联机需在联机页点「打开系统组件安装包」安装 .pkg（需管理员密码）'));

const tcDir = path.join(os.homedir(), 'Library', 'Application Support', 'MC 启动器', 'terracotta');
if (exists(tcDir)) {
  out('     联机目录：' + tcDir);
  try {
    fs.readdirSync(tcDir).slice(0, 12).forEach((f) => out('       - ' + f));
  } catch (e) { /* ignore */ }
} else {
  out('     联机目录：尚未创建（正常，安装联机后才会有）');
}
out('');

/* --- 5. 下一步 --- */
out('--- 5. 下一步 ---');
out('  1) npm install                 # 首次或依赖变更后');
out('  2) npm run mac:check           # 本自检');
out('  3) npm run dist:mac            # 产出 dmg + zip + latest-mac.yml');
out('  4) npm test                    # 在新平台跑一次全套回归');
out('  把本段自检输出 + 构建/测试终端输出整段贴回对话，我据此修下一轮。');
out('');
out('=== 自检结束 ===');

try {
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'mac-preflight.txt'), lines.join('\n') + '\n', 'utf8');
  console.log('（报告已存至 dist/mac-preflight.txt）');
} catch (e) { /* 只读环境，忽略 */ }
