'use strict';
/**
 * 双平台发布链路单测。
 *
 * 重点验证「同一个 Release 同时服务 Windows / macOS」时最容易静默出错的地方：
 *   1) 分两次发布（Windows 先、Mac 后）时，每侧只有自己那一半资产，必须放行；
 *   2) dist/ 里残留的旧版 latest.yml / latest-mac.yml 必须被拦下，否则会覆盖新版清单；
 *   3) Mac 只有 dmg 没有 zip、或有 zip 没有 latest-mac.yml，都必须拒绝。
 * 纯文件操作，不需要 Mac 机器，也不需要 GitHub 令牌。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readYmlVersion, validateReleaseAssets, asciiName } = require('../scripts/publish');

const V = '0.2.4';
const WIN_EXE = 'MC启动器-0.2.4-x64.exe';
const WIN_PORTABLE = 'MC启动器-0.2.4-便携版.exe';
const MAC_ZIP = 'MC-Launcher-0.2.4-x64.zip';
const MAC_DMG = 'MC-Launcher-0.2.4-x64.dmg';

function winYml(v) {
  return 'version: ' + v + "\npath: 'MC-Launcher-" + v + "-x64.exe'\nsha512: AA==\n";
}
function macYml(v) {
  return 'version: ' + v + "\npath: 'MC-Launcher-" + v + "-x64.zip'\nsha512: BB==\n";
}
function touch(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content === undefined ? 'X' : content);
}
function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-publish-test-'));
}
function winHalf(dir) {
  touch(dir, WIN_EXE);
  touch(dir, WIN_PORTABLE);
  touch(dir, 'latest.yml', winYml(V));
}
function macHalf(dir) {
  touch(dir, MAC_ZIP);
  touch(dir, MAC_DMG);
  touch(dir, 'latest-mac.yml', macYml(V));
}

const dirs = [];
function tmpDir() { const d = fresh(); dirs.push(d); return d; }

try {
  // --- asciiName：GitHub 资产名与清单 url 必须用同一套映射 ---
  assert.strictEqual(asciiName(WIN_EXE), 'MC-Launcher-0.2.4-x64.exe');
  assert.strictEqual(asciiName(WIN_PORTABLE), 'MC-Launcher-0.2.4-portable.exe');
  assert.strictEqual(asciiName(MAC_ZIP), MAC_ZIP);

  // --- readYmlVersion ---
  const d0 = tmpDir();
  touch(d0, 'latest.yml', winYml('0.2.9'));
  assert.strictEqual(readYmlVersion(path.join(d0, 'latest.yml')), '0.2.9');
  touch(d0, 'quoted.yml', "version: '0.3.0'\n");
  assert.strictEqual(readYmlVersion(path.join(d0, 'quoted.yml')), '0.3.0');
  assert.strictEqual(readYmlVersion(path.join(d0, 'missing.yml')), '');
  touch(d0, 'bad.yml', 'files:\n  - url: x\n');
  assert.strictEqual(readYmlVersion(path.join(d0, 'bad.yml')), '');

  // --- 场景 1：Windows 先发布，只有 Windows 半套 → 放行 ---
  const d1 = tmpDir();
  winHalf(d1);
  let r = validateReleaseAssets(d1, V);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.win.length, 2);
  assert.strictEqual(r.mac.length, 0);

  // --- 场景 2：Mac 后补发，只有 Mac 半套 → 放行 ---
  const d2 = tmpDir();
  macHalf(d2);
  r = validateReleaseAssets(d2, V);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.win.length, 0);
  assert.strictEqual(r.mac.length, 2);

  // --- 场景 3：把两边产物汇总到一台机器一次发布 → 放行 ---
  const d3 = tmpDir();
  winHalf(d3);
  macHalf(d3);
  r = validateReleaseAssets(d3, V);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.win.length, 2);
  assert.strictEqual(r.mac.length, 2);

  // --- 场景 4：dist 里残留 0.2.3 的 latest.yml（真实存在的情况）→ 必须拦下 ---
  const d4 = tmpDir();
  winHalf(d4);
  touch(d4, 'latest.yml', winYml('0.2.3'));
  r = validateReleaseAssets(d4, V);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('latest.yml 的版本是 0.2.3')), JSON.stringify(r.errors));

  // --- 场景 5：Mac 端用 0.2.3 的清单补 0.2.4 Release → 必须拦下 ---
  const d5 = tmpDir();
  macHalf(d5);
  touch(d5, 'latest-mac.yml', macYml('0.2.3'));
  r = validateReleaseAssets(d5, V);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('latest-mac.yml 的版本是 0.2.3')), JSON.stringify(r.errors));

  // --- 场景 6：有 Mac 安装包却没有 latest-mac.yml → 拒绝 ---
  const d6 = tmpDir();
  touch(d6, MAC_ZIP);
  touch(d6, MAC_DMG);
  r = validateReleaseAssets(d6, V);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('缺少 latest-mac.yml')), JSON.stringify(r.errors));

  // --- 场景 7：有 latest-mac.yml 却只有 dmg（MacUpdater 只认 zip）→ 拒绝 ---
  const d7 = tmpDir();
  touch(d7, MAC_DMG);
  touch(d7, 'latest-mac.yml', macYml(V));
  r = validateReleaseAssets(d7, V);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('缺少 0.2.4 的 .zip')), JSON.stringify(r.errors));

  // --- 场景 8：有 latest.yml 却没有当前版本 exe → 拒绝 ---
  const d8 = tmpDir();
  touch(d8, 'latest.yml', winYml(V));
  touch(d8, 'MC启动器-0.2.3-x64.exe');
  r = validateReleaseAssets(d8, V);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('缺少 0.2.4 的 Windows .exe')), JSON.stringify(r.errors));

  // --- 场景 9：目录不存在 → 拒绝且不抛异常 ---
  r = validateReleaseAssets(path.join(os.tmpdir(), 'mc-publish-no-such-dir-xyz'), V);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length > 0);

  console.log('[publish.test] ✓ 全部通过（9 组场景）');
} finally {
  dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
}
