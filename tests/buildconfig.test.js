'use strict';
/**
 * electron-builder 配置合法性回归测试。
 *
 * 背景（真实事故）：macOS 移植时往 build.mac 里加了 "arch": ["x64"]，
 * 但 electron-builder 25 的 MacConfiguration 并没有 arch 这个字段（架构只能由
 * CLI 的 --x64 指定）。配置校验是**全平台共用**的，结果不仅 Mac 打包失败，
 * 连 Windows 的 npm run dist 也在 validateConfig 阶段直接挂掉 —— 违反「原功能不动」。
 *
 * 这里直接用 electron-builder 自带的 scheme.json 做键名校验，不打包、不联网，
 * 且白名单随依赖版本自动更新，不用手工维护。
 */
const assert = require('assert');
const path = require('path');

const scheme = require('app-builder-lib/scheme.json');

const SECTION_DEFS = {
  win: 'WindowsConfiguration',
  mac: 'MacConfiguration',
  dmg: 'DmgOptions',
  portable: 'PortableOptions',
  nsis: 'NsisOptions',
};

/** 返回 { section: [非法键...] }，只含确实有非法键的段 */
function findIllegalKeys(build, definitions) {
  const defs = definitions || (scheme && scheme.definitions) || {};
  const bad = {};
  Object.keys(SECTION_DEFS).forEach((section) => {
    const defName = SECTION_DEFS[section];
    const allowed = new Set(Object.keys((defs[defName] || {}).properties || {}));
    const illegal = Object.keys(build[section] || {}).filter((k) => !allowed.has(k));
    if (illegal.length) bad[section] = illegal;
  });
  return bad;
}

try {
  const build = require(path.join(__dirname, '..', 'package.json')).build;
  const bad = findIllegalKeys(build);
  assert.deepStrictEqual(bad, {}, 'build 配置含 electron-builder 不认识的键：' + JSON.stringify(bad));

  // 回归锚点：mac.arch 就是那次事故的元凶，明确钉死
  assert.ok(!('arch' in build.mac), 'mac.arch 非法，架构请由 scripts/build-mac.js 的 --x64 指定');
  assert.deepStrictEqual(build.mac.target, ['dmg', 'zip'], 'Mac 必须同时出 dmg 与 zip');
  assert.ok(Array.isArray(build.win.target) && build.win.target.includes('nsis'), 'Windows 原打包目标不能丢');

  // 自检：测试本身要能抓到非法键，别写成永远通过
  const fake = findIllegalKeys({ mac: { arch: ['x64'], target: ['dmg'] }, win: { icon: 'x' } });
  assert.deepStrictEqual(fake.mac, ['arch'], '应当能检出 mac.arch');
  assert.ok(!fake.win, '合法键不应误报');

  console.log('[buildconfig.test] ✓ electron-builder 配置全部合法（5 段）');
} catch (e) {
  console.error('[buildconfig.test] ✗ ' + e.message);
  process.exit(1);
}

module.exports = { findIllegalKeys };
