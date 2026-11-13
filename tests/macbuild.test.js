'use strict';
/**
 * macOS 构建/更新清单单测。
 * 重点验证「自动更新能收到 Mac 版」这条链路里最容易静默失效的两点：
 *   1) 清单文件名必须是 latest-mac.yml（darwin 下 channel 固定）；
 *   2) 清单里必须有 .zip 且 path 指向它（MacUpdater.findFile 强制）。
 * 纯文件操作，不需要 Mac 机器。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { genMacYml, asciiName } = require('../scripts/build-mac');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-macbuild-test-'));
try {
  const VERSION = '0.2.4';
  fs.writeFileSync(path.join(TMP, 'MC-Launcher-0.2.4-x64.zip'), 'ZIPDATA');
  fs.writeFileSync(path.join(TMP, 'MC-Launcher-0.2.4-x64.dmg'), 'DMGDATA-LONGER');
  // 其它版本的产物不能混进本次清单
  fs.writeFileSync(path.join(TMP, 'MC-Launcher-0.2.3-x64.zip'), 'OLD');

  const r = genMacYml(TMP, VERSION, '2026-11-13T00:00:00.000Z');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.file, 'latest-mac.yml');
  assert.strictEqual(r.count, 2, '只收当前版本的 dmg + zip');
  assert.strictEqual(r.primary, 'MC-Launcher-0.2.4-x64.zip', '主文件必须是 zip');

  const yml = fs.readFileSync(path.join(TMP, 'latest-mac.yml'), 'utf8');
  assert.ok(yml.startsWith('version: 0.2.4\n'));
  assert.ok(yml.includes("path: 'MC-Launcher-0.2.4-x64.zip'"));
  assert.ok(yml.includes("  - url: 'MC-Launcher-0.2.4-x64.zip'"));
  assert.ok(yml.includes("  - url: 'MC-Launcher-0.2.4-x64.dmg'"));
  assert.ok(!yml.includes('0.2.3'), '历史版本产物不能混入');
  assert.ok(yml.includes("releaseDate: '2026-11-13T00:00:00.000Z'"));

  // sha512 必须是主文件内容的 base64 摘要（electron-updater 会校验）
  const expect = crypto.createHash('sha512').update(Buffer.from('ZIPDATA')).digest('base64');
  const mainSha = (yml.match(/\nsha512: (\S+)\n?$/) || [])[1];
  assert.strictEqual(mainSha, expect);
  assert.ok(yml.includes('size: 7'));

  // 只有 dmg、没有 zip 时必须拒绝（否则 Mac 端更新会静默失败）
  const noZip = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-macbuild-nozip-'));
  try {
    fs.writeFileSync(path.join(noZip, 'MC-Launcher-0.2.4-x64.dmg'), 'D');
    const bad = genMacYml(noZip, VERSION);
    assert.strictEqual(bad.ok, false);
    assert.ok(/zip/.test(bad.error));
    assert.strictEqual(fs.existsSync(path.join(noZip, 'latest-mac.yml')), false);
  } finally {
    fs.rmSync(noZip, { recursive: true, force: true });
  }

  // 资产名映射要与 Windows 侧一致（中文产物名 → ASCII）
  assert.strictEqual(asciiName('MC启动器-0.2.3-x64.exe'), 'MC-Launcher-0.2.3-x64.exe');
  assert.strictEqual(asciiName('MC启动器-0.2.3-便携版.exe'), 'MC-Launcher-0.2.3-portable.exe');
  assert.strictEqual(asciiName('MC-Launcher-0.2.4-x64.dmg'), 'MC-Launcher-0.2.4-x64.dmg');

  console.log('macbuild.test.js 全部通过 ✓');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
