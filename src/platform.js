'use strict';
/**
 * 平台相关判据的唯一来源（macOS Intel 移植，2026-11-13）。
 *
 * 设计原则：
 *  1) 全部是纯函数，platform/arch 可注入 —— 在 Windows 上也能单测 Mac 分支；
 *  2) 只在「确实因操作系统而异」的地方分支，绝不为 Mac 改动 Windows 的既有行为；
 *  3) 不缓存 process.platform 到模块加载时的常量以外的可变状态。
 */
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function pair(plat, arch) {
  return { plat: plat || process.platform, arch: arch || process.arch };
}

/** java 可执行文件名（探测 PATH / 目录时用） */
function javaExeNames(plat) {
  return (plat || process.platform) === 'win32' ? ['javaw.exe', 'java.exe', 'java'] : ['java'];
}

/** 在解压出的 JDK 里递归找 java 时认可的文件名 */
function javaFileNames(plat) {
  return (plat || process.platform) === 'win32' ? ['javaw.exe', 'java.exe'] : ['java'];
}

/** 给定 JDK 根目录，java 可执行文件的候选相对路径（按优先级） */
function javaRelCandidates(plat) {
  if ((plat || process.platform) === 'win32') {
    return [path.join('bin', 'javaw.exe'), path.join('bin', 'java.exe')];
  }
  // macOS 的 .jdk bundle 是 <name>.jdk/Contents/Home/bin/java；
  // Adoptium 的 tar/zip 解出来是 <name>/Contents/Home/bin/java 或 <name>/bin/java。
  return [
    path.join('Contents', 'Home', 'bin', 'java'),
    path.join('bin', 'java'),
    'java',
  ];
}

/** 文件选择对话框的过滤器（macOS 的 java 无扩展名，不能写死 exe） */
function javaPickFilters(plat) {
  const p = pair(plat).plat;
  if (p === 'win32') return [{ name: 'Java 可执行文件', extensions: ['exe'] }];
  return [{ name: 'Java 可执行文件', extensions: ['*'] }];
}

function javaPickTitle(plat) {
  return (plat || process.platform) === 'win32'
    ? '选择 java.exe（推荐）或 javaw.exe'
    : '选择 java 可执行文件（通常在 JDK 的 Contents/Home/bin 下）';
}

/** Adoptium v3 API 的 OS 段 */
function adoptiumOs(plat) {
  const p = (plat || process.platform);
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'mac';
  return 'linux';
}

/** 当前只出 x64（Intel Mac）；Apple Silicon 走 Rosetta 也用 x64 包 */
function adoptiumArch() {
  return 'x64';
}

/** Adoptium 直链（返回 302，由 downloader 跟随） */
function adoptiumUrl(major, base, plat) {
  const api = base || 'https://api.adoptium.net/v3/binary/latest';
  return api + '/' + major + '/ga/' + adoptiumOs(plat) + '/' + adoptiumArch() +
    '/jdk/hotspot/normal/eclipse';
}

/** Terracotta / EasyTier 官方 Release 资产里的平台名 */
function terracottaArch(plat, arch) {
  const x = pair(plat, arch);
  if (x.plat === 'win32') return x.arch === 'arm64' ? 'windows-arm64' : 'windows-x86_64';
  if (x.plat === 'darwin') return x.arch === 'arm64' ? 'macos-arm64' : 'macos-x86_64';
  if (x.plat === 'linux') return x.arch === 'arm64' ? 'linux-arm64' : 'linux-x86_64';
  return 'windows-x86_64';
}

function terracottaFallback(version, plat, arch) {
  const a = terracottaArch(plat, arch);
  return 'https://github.com/burningtnt/Terracotta/releases/download/v' + version +
    '/terracotta-' + version + '-' + a + '-pkg.tar.gz';
}

/** Terracotta 解压后可执行文件的查找方式 */
function terracottaExeName(plat) {
  // Windows 是 .exe；macOS/Linux 的 tar.gz 里是无扩展名 ELF/Mach-O 二进制
  return (plat || process.platform) === 'win32' ? /\.exe$/i : null;
}

/** 官方游戏目录名：macOS 无前导点 */
function gameDirName(plat) {
  return (plat || process.platform) === 'darwin' ? 'minecraft' : '.minecraft';
}

/** 系统 Java 的额外搜索根（macOS / Linux） */
function javaSearchRoots(plat, home) {
  const p = (plat || process.platform);
  const h = home || os.homedir();
  if (p === 'win32') return [];
  if (p === 'darwin') {
    return [
      '/Library/Java/JavaVirtualMachines',
      path.join(h, 'Library', 'Java', 'JavaVirtualMachines'),
      '/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home',
      '/opt/homebrew/opt',
      '/usr/local/opt',
      '/Library/Java/Home',
    ];
  }
  return ['/usr/lib/jvm', '/usr/java', '/opt/java', '/usr/local/opt'];
}

/** 从其它启动器导入配置时， macOS 下应扫描的目录 */
function importConfigRoots(plat, home) {
  const p = (plat || process.platform);
  const h = home || os.homedir();
  if (p === 'win32') return [];
  if (p === 'darwin') {
    return [
      path.join(h, 'Library', 'Application Support', 'minecraft'),
      path.join(h, 'Library', 'Application Support', 'HMCL'),
      path.join(h, '.hmcl'),
      path.join(h, '.minecraft'),
    ];
  }
  return [path.join(h, '.minecraft'), path.join(h, '.hmcl')];
}

/** 展示用平台名 */
function osLabel(plat) {
  const p = (plat || process.platform);
  if (p === 'win32') return 'Windows';
  if (p === 'darwin') return 'macOS';
  if (p === 'linux') return 'Linux';
  return p;
}

/** 浏览器 UA（原先 3 处硬编码 Windows，会向站点误报系统） */
function userAgent(plat, arch, chromeVersion) {
  const x = pair(plat, arch);
  const chrome = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
    (chromeVersion || '130.0.0.0') + ' Safari/537.36';
  if (x.plat === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' + chrome;
  }
  if (x.plat === 'linux') {
    return 'Mozilla/5.0 (X11; Linux x86_64) ' + chrome;
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' + chrome;
}

module.exports = {
  IS_WIN,
  IS_MAC,
  javaExeNames,
  javaFileNames,
  javaRelCandidates,
  javaPickFilters,
  javaPickTitle,
  adoptiumOs,
  adoptiumArch,
  adoptiumUrl,
  terracottaArch,
  terracottaFallback,
  terracottaExeName,
  gameDirName,
  javaSearchRoots,
  importConfigRoots,
  osLabel,
  userAgent,
};
