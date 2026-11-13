'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const platform = require('./platform');

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (e) {
    return false;
  }
}

// 额外搜索根（如启动器自管运行时目录 runtime/），由主进程注入
const extraRoots = [];
function addJavaRoot(dir) {
  if (dir && fs.existsSync(dir) === false) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  }
  if (dir && extraRoots.indexOf(dir) < 0) extraRoots.push(dir);
}

function probeFile(javaPath) {
  // javaw.exe 不输出版本信息，用同目录的 java.exe 探测
  const dir = path.dirname(javaPath);
  const base = path.basename(javaPath).toLowerCase() === 'javaw.exe' ? 'java.exe' : path.basename(javaPath);
  const alt = path.join(dir, base);
  return exists(alt) ? alt : javaPath;
}

function getJavaInfo(javaPath) {
  return new Promise((resolve) => {
    if (!exists(javaPath)) return resolve({ path: javaPath, exists: false, major: null, versionString: '' });
    execFile(probeFile(javaPath), ['-version'], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      const raw = String(stderr || '') + String(stdout || '');
      const firstLine = raw.split('\n').find((l) => /version/i.test(l)) || '';
      const m = firstLine.match(/"([^"]+)"/);
      const versionString = m ? m[1] : firstLine.trim();
      let major = null;
      const vm = versionString.match(/^(\d+)(?:\.(\d+))?/);
      if (vm) major = vm[1] === '1' && vm[2] ? Number(vm[2]) : Number(vm[1]);
      let vendor = /openjdk/i.test(firstLine) ? 'OpenJDK' : '';
      if (/hotspot|Runtime Environment/i.test(firstLine) && !vendor) vendor = '';
      resolve({
        path: javaPath,
        exists: true,
        versionString: versionString || '未知版本',
        major,
        vendor,
        is64: /64-bit|64-Bit/i.test(raw) || /\bx64\b/i.test(raw),
      });
    });
  });
}

function childrenOf(dir, depth, out) {
  if (depth < 0) return;
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const full = path.join(dir, it.name);
    out.push(full);
    childrenOf(full, depth - 1, out);
  }
}

function collectCandidateRoots() {
  const roots = [];
  if (process.env.JAVA_HOME) roots.push(process.env.JAVA_HOME);

  if (platform.IS_WIN) {
    // Windows 分支保持原样，不改动既有搜索行为。
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const parents = [
      path.join(pf, 'Java'),
      path.join(pf86, 'Java'),
      path.join(pf, 'Eclipse Adoptium'),
      path.join(pf, 'BellSoft'),
      path.join(pf, 'Zulu'),
      path.join(pf, 'Microsoft'),
      path.join(pf, 'Amazon Corretto'),
      path.join(pf, 'Semeru'),
      path.join(pf, 'ojdkbuild'),
      path.join(pf, 'GraalVM'),
      path.join(pf, 'SapMachine'),
      path.join(pf, 'AdoptOpenJDK'),
      path.join(pf, 'dragonwell'),
    ];
    for (const p of parents) {
      if (!fs.existsSync(p)) continue;
      const subs = [];
      childrenOf(p, 1, subs);
      roots.push(p, ...subs);
    }
  } else {
    // macOS：/Library/Java/JavaVirtualMachines/<name>.jdk/Contents/Home/bin/java
    // 以及 Homebrew 的 /opt/homebrew/opt/openjdk@XX（多为符号链接，childrenOf 不跟随）。
    for (const p of platform.javaSearchRoots()) {
      if (!fs.existsSync(p)) continue;
      const subs = [];
      childrenOf(p, 2, subs);
      roots.push(p, ...subs);
      for (const d of [p, ...subs]) {
        const home = path.join(d, 'Contents', 'Home');
        if (exists(path.join(home, 'bin', 'java'))) roots.push(home);
      }
      try {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          if (!e.isSymbolicLink() && !e.isDirectory()) continue;
          const full = path.join(p, e.name);
          if (exists(path.join(full, 'bin', 'java'))) roots.push(full);
          const home = path.join(full, 'Contents', 'Home');
          if (exists(path.join(home, 'bin', 'java'))) roots.push(home);
        }
      } catch (x) { /* 权限不足等，忽略 */ }
    }
  }

  for (const r of extraRoots) {
    if (fs.existsSync(r)) {
      const subs = [];
      childrenOf(r, 2, subs);
      roots.push(r, ...subs);
      if (!platform.IS_WIN) {
        for (const d of subs) {
          const home = path.join(d, 'Contents', 'Home');
          if (exists(path.join(home, 'bin', 'java'))) roots.push(home);
        }
      }
    }
  }
  return Array.from(new Set(roots));
}

/** 游戏目录里可能自带官方运行时（runtime/java-runtime-xxx/...） */
function collectBundledRuntimes(gameDir, plat) {
  const out = [];
  if (!gameDir) return out;
  const runtime = path.join(gameDir, 'runtime');
  if (!fs.existsSync(runtime)) return out;
  const subs = [];
  childrenOf(runtime, 4, subs);
  // 新结构：<id>/windows-x64/<id>/bin/javaw.exe（mac 为 mac-os-x64/.../bin/java）；
  // 旧结构：jre-x64/<ver>/bin/javaw.exe。目录名由平台决定，所以遍历所有子目录逐个试。
  const isWin = (plat || process.platform) === 'win32';
  const rels = isWin
    ? [path.join('bin', 'javaw.exe')]
    : [path.join('bin', 'java'), path.join('Contents', 'Home', 'bin', 'java')];
  for (const d of [runtime, ...subs]) {
    for (const rel of rels) {
      const target = path.join(d, rel);
      if (exists(target)) { out.push(target); break; }
    }
  }
  return Array.from(new Set(out));
}

async function findJavaCandidates(gameDir, limit) {
  limit = limit || 8;
  const candidates = new Set();

  for (const r of collectBundledRuntimes(gameDir)) candidates.add(r);

  const rels = platform.IS_WIN
    ? [path.join('bin', 'javaw.exe'), path.join('bin', 'java.exe'), path.join('bin', 'java')]
    : [path.join('bin', 'java'), path.join('Contents', 'Home', 'bin', 'java'), 'java'];
  for (const root of collectCandidateRoots()) {
    for (const rel of rels) {
      const p = path.join(root, rel);
      if (exists(p)) candidates.add(p);
    }
  }

  // PATH 里的 java
  await new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['java'], { windowsHide: true }, (err, stdout) => {
      if (!err && stdout) String(stdout).split(/\r?\n/).filter(Boolean).forEach((p) => candidates.add(p.trim()));
      resolve();
    });
  });

  const list = Array.from(candidates).slice(0, 40);
  const infos = await Promise.all(list.map((p) => getJavaInfo(p)));
  const valid = infos.filter((i) => i.exists);
  valid.sort((a, b) => (b.major || 0) - (a.major || 0));
  return valid.slice(0, limit);
}

/** 按版本描述推荐 Java 大版本号 */
function recommendJavaMajor(json) {
  if (json && json.javaVersion && json.javaVersion.majorVersion) return json.javaVersion.majorVersion;
  const id = (json && (json.__id || json.id)) || '';
  const m = id.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) {
    if (/^\d{2}w\d{2}/.test(id)) return 17; // 新版快照
    return 8;
  }
  const minor = Number(m[2]);
  const patch = Number(m[3] || 0);
  if (minor >= 21) return 21;
  if (minor === 20 && patch >= 5) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 17;
  return 8;
}

module.exports = { getJavaInfo, findJavaCandidates, collectBundledRuntimes, recommendJavaMajor, exists, addJavaRoot };
