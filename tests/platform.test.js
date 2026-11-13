'use strict';
/**
 * macOS(Intel) 移植的平台判据单测。
 * 关键点：platform.js 的纯函数允许注入 plat/arch，
 * 所以这些分支在 Windows 开发机上也能被真实执行、而不是靠真机碰运气。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const platform = require('../src/platform');
const javadl = require('../src/javadl');
const zip = require('../src/zip');
const javaFinder = require('../src/java-finder');
const scanner = require('../src/scanner');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-platform-test-'));
function cleanup() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
function mk(file, content) {
  const p = path.join(TMP, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content == null ? '' : content);
  return p;
}

try {
  /* ---------- 1. 平台判据 ---------- */
  assert.strictEqual(platform.adoptiumOs('win32'), 'windows');
  assert.strictEqual(platform.adoptiumOs('darwin'), 'mac');
  assert.strictEqual(platform.adoptiumOs('linux'), 'linux');
  assert.strictEqual(platform.gameDirName('win32'), '.minecraft');
  assert.strictEqual(platform.gameDirName('darwin'), 'minecraft');
  assert.strictEqual(platform.osLabel('darwin'), 'macOS');

  // Java 文件名 / 候选路径
  assert.deepStrictEqual(platform.javaFileNames('win32'), ['javaw.exe', 'java.exe']);
  assert.deepStrictEqual(platform.javaFileNames('darwin'), ['java']);
  assert.ok(platform.javaRelCandidates('darwin').some((r) => r.includes(path.join('Contents', 'Home', 'bin', 'java'))));
  assert.strictEqual(platform.javaRelCandidates('win32')[0], path.join('bin', 'javaw.exe'));
  assert.deepStrictEqual(platform.javaPickFilters('darwin')[0].extensions, ['*']);
  assert.deepStrictEqual(platform.javaPickFilters('win32')[0].extensions, ['exe']);

  // UA 不能在所有平台都伪装成 Windows
  assert.ok(platform.userAgent('darwin').includes('Macintosh'));
  assert.ok(platform.userAgent('win32').includes('Windows NT'));
  assert.ok(!platform.userAgent('darwin').includes('Windows'));

  // macOS 搜索根
  assert.ok(platform.javaSearchRoots('darwin', '/Users/test').includes('/Library/Java/JavaVirtualMachines'));
  assert.ok(platform.importConfigRoots('darwin', '/Users/test')
    .some((r) => r.includes(path.join('Library', 'Application Support', 'minecraft'))));
  assert.deepStrictEqual(platform.javaSearchRoots('win32', '/Users/test'), []);

  /* ---------- 2. Adoptium JDK 直链：不能再写死 windows ---------- */
  assert.ok(javadl.buildUrl(21, 'win32').includes('/ga/windows/x64/jdk/'));
  assert.ok(javadl.buildUrl(21, 'darwin').includes('/ga/mac/x64/jdk/'));
  assert.ok(javadl.buildUrl(17, 'linux').includes('/ga/linux/x64/jdk/'));
  assert.ok(!javadl.buildUrl(21, 'darwin').includes('windows'));

  /* ---------- 3. Terracotta 资产名（已核对官方 v0.4.2 Release 实际命名） ---------- */
  assert.strictEqual(platform.terracottaArch('win32', 'x64'), 'windows-x86_64');
  assert.strictEqual(platform.terracottaArch('win32', 'arm64'), 'windows-arm64');
  assert.strictEqual(platform.terracottaArch('darwin', 'x64'), 'macos-x86_64');
  assert.strictEqual(platform.terracottaArch('darwin', 'arm64'), 'macos-arm64');
  assert.strictEqual(platform.terracottaArch('linux', 'x64'), 'linux-x86_64');
  const macFallback = platform.terracottaFallback('0.4.2', 'darwin', 'x64');
  assert.ok(macFallback.endsWith('terracotta-0.4.2-macos-x86_64-pkg.tar.gz'), macFallback);
  const winFallback = platform.terracottaFallback('0.4.2', 'win32', 'x64');
  assert.ok(winFallback.endsWith('terracotta-0.4.2-windows-x86_64-pkg.tar.gz'));
  assert.strictEqual(platform.terracottaExeName('darwin'), null, 'mac 二进制无 .exe 后缀');
  assert.ok(platform.terracottaExeName('win32').test('terracotta.exe'));

  /* ---------- 4. 解压后的 java 可执行文件定位 ---------- */
  const macJava = mk('jdk/Contents/Home/bin/java', '#!/bin/sh\n');
  assert.strictEqual(javadl.findJavaExe(path.join(TMP, 'jdk'), 'darwin'), macJava);
  const winJava = mk('jdk-win/bin/javaw.exe', 'MZ');
  assert.strictEqual(javadl.findJavaExe(path.join(TMP, 'jdk-win'), 'win32'), winJava);
  assert.strictEqual(javadl.findJavaExe(path.join(TMP, 'jdk-win'), 'darwin'), null);

  /* ---------- 5. 游戏目录自带运行时：macOS 的 Contents/Home 结构 ---------- */
  mk('game-mac/runtime/mac-os-x64/jdk/Contents/Home/bin/java', '');
  const bundledMac = javaFinder.collectBundledRuntimes(path.join(TMP, 'game-mac'), 'darwin');
  assert.ok(bundledMac.length > 0, 'mac 结构应能找到 java');
  assert.ok(bundledMac[0].endsWith(path.join('Contents', 'Home', 'bin', 'java')));
  mk('game-win/runtime/jre-x64/1/bin/javaw.exe', '');
  const bundledWin = javaFinder.collectBundledRuntimes(path.join(TMP, 'game-win'), 'win32');
  assert.ok(bundledWin.some((p) => p.endsWith(path.join('bin', 'javaw.exe'))), 'Windows 原有行为不变');

  /* ---------- 6. ZIP 的 Unix 可执行位必须被解析出来 ---------- */
  /** 构造最小 stored ZIP，central directory 写入指定 unixMode */
  function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const data = Buffer.from(e.data || '');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 8);            // method = stored
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      locals.push(local, nameBuf, data);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x031e, 4);     // version made by: Unix
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0, 10);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(((e.unixMode || 0) << 16) >>> 0, 38);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat(locals.concat([centralBuf, eocd]));
  }

  const zipPath = path.join(TMP, 'unixmode.zip');
  fs.writeFileSync(zipPath, makeZip([
    { name: 'bin/java', data: 'ELF', unixMode: 0o100755 },
    { name: 'lib/readme.txt', data: 'hello', unixMode: 0o100644 },
  ]));
  const parsed = zip.parseZip(zipPath);
  assert.strictEqual(parsed.entries.length, 2);
  assert.strictEqual(parsed.entries[0].unixMode, 0o100755, '可执行位应被读出');
  assert.strictEqual(parsed.entries[1].unixMode, 0o100644);
  const outDir = path.join(TMP, 'unzipped');
  assert.strictEqual(zip.extractAll(zipPath, outDir), 2, '解压不应回归');
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'bin', 'java'), 'utf8'), 'ELF');
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'lib', 'readme.txt'), 'utf8'), 'hello');
  // applyUnixMode 在 Windows 上是 no-op，但不能抛异常
  zip.applyUnixMode(path.join(outDir, 'bin', 'java'), 0o100755);
  zip.applyUnixMode(path.join(outDir, 'lib', 'readme.txt'), 0o100644);

  /* ---------- 7. 防 zip slip 仍然生效 ---------- */
  const evilZip = path.join(TMP, 'evil.zip');
  fs.writeFileSync(evilZip, makeZip([{ name: '../../escape.txt', data: 'bad', unixMode: 0o100755 }]));
  assert.strictEqual(zip.extractAll(evilZip, path.join(TMP, 'evil-out')), 0);

  /* ---------- 8. 默认游戏目录与规范化（Windows 分支不回归） ---------- */
  assert.ok(scanner.defaultGameDir().length > 0);
  mk('parent/minecraft/versions/1.20.1/1.20.1.json', '{}');
  // Windows 上不会尝试无点目录；Mac 分支由 platform.gameDirName 单测覆盖
  const normalized = scanner.normalizeGameDir(path.join(TMP, 'parent'));
  assert.strictEqual(typeof normalized, 'string');

  console.log('platform.test.js 全部通过 ✓');
} finally {
  cleanup();
}
