'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonFile, currentOsName, mavenPathFromName, unique } = require('./util');

const OS = currentOsName();

/** 规则中可能出现而我们永远不开启的特性，一律视为 false */
const KNOWN_FEATURES = {
  is_demo_user: false,
  has_custom_resolution: false,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
};

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== OS) return false;
    if (rule.os.version) {
      const regex = new RegExp(rule.os.version);
      if (!regex.test(os.release())) return false;
    }
    if (rule.os.arch) {
      const archMap = { x64: 'x86_64', ia32: 'x86', arm64: 'aarch64' };
      // Mojang 的 arch 值：x86 / x86_64，部分旧规则用 "64"？统一宽松处理
      if (rule.os.arch !== (archMap[process.arch] || process.arch)) return false;
    }
  }
  if (rule.features) {
    for (const [key, want] of Object.entries(rule.features)) {
      const actual = Object.prototype.hasOwnProperty.call(features, key)
        ? features[key]
        : KNOWN_FEATURES[key] || false;
      if (actual !== want) return false;
    }
  }
  return true;
}

/** 默认不通过，命中的规则依次覆盖（与官方启动器一致） */
function rulesAllow(rules, features) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!ruleMatches(rule, features)) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

/** 参数数组，元素可能是字符串或带 rules 的对象 */
function flattenArgs(args, features) {
  const out = [];
  for (const item of args || []) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item && typeof item === 'object') {
      if (!rulesAllow(item.rules, features)) continue;
      const value = item.value;
      if (Array.isArray(value)) out.push(...value);
      else if (typeof value === 'string') out.push(value);
    }
  }
  return out;
}

/**
 * 加载版本描述（支持 inheritsFrom，例如 Forge / Fabric 的部分版本）
 * 子版本的字段覆盖父版本，libraries 与 jvm 参数合并
 */
function loadProfile(gameDir, versionId, seen) {
  seen = seen || [];
  if (seen.includes(versionId)) {
    throw new Error('版本继承链出现循环：' + seen.concat(versionId).join(' -> '));
  }
  const vdir = path.join(gameDir, 'versions', versionId);
  const jsonPath = path.join(vdir, versionId + '.json');
  const json = readJsonFile(jsonPath);
  if (!json) throw new Error('找不到版本描述文件：' + jsonPath);

  let self;
  if (json.inheritsFrom) {
    const parent = loadProfile(gameDir, json.inheritsFrom, seen.concat(versionId));
    self = mergeProfiles(parent, json, vdir);
  } else {
    self = json;
  }
  self.__id = json.id || versionId;
  self.__versionDir = vdir;
  if (!json.inheritsFrom) {
    // 本体 jar 归属：自身版本优先
    self.__jarId = self.__id;
    self.__jarDir = vdir;
  }
  return self;
}

function mergeProfiles(parent, child, childDir) {
  const merged = Object.assign({}, parent, child);

  // libraries：父在前、子在后追加
  const libs = (parent.libraries || []).slice();
  for (const lib of child.libraries || []) libs.push(lib);
  merged.libraries = libs;

  // arguments：jvm 与 game 都按「父在前、子在后」拼接。
  // game 不能整体替换——子版本只携带自己要追加的参数（如 --tweakClass），
  // 父版本的 --username/--version 等必须保留，否则游戏直接报缺少参数
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [].concat(
        (parent.arguments && parent.arguments.game) || [],
        (child.arguments && child.arguments.game) || []
      ),
      jvm: [].concat(
        (parent.arguments && parent.arguments.jvm) || [],
        (child.arguments && child.arguments.jvm) || []
      ),
    };
  }
  // 谁提供 client jar，谁就是本体版本的归属：
  // 子版本自带 downloads.client 就用自己的目录，否则（Forge/Fabric 这类继承版）用父版本的 jar
  const childOwnsJar = !!(child.downloads && child.downloads.client);
  merged.__jarId = childOwnsJar ? child.id || parent.__id : parent.__jarId || parent.__id;
  merged.__jarDir = childOwnsJar ? childDir || parent.__versionDir : parent.__jarDir || parent.__versionDir;
  return merged;
}

/**
 * 从 maven 坐标推导 group:artifact[:classifier]，用于去重。
 * 例：org/ow2/asm/asm/9.6/asm-9.6.jar -> org.ow2.asm:asm
 *
 * 关键：必须带上 classifier。MC 1.20.5+（以及更高的 26.x）改了依赖写法——
 * 平台 natives 不再用 downloads.classifiers，而是拆成独立的 library 条目、
 * 并把 classifier 直接写进 name，例如：
 *   org.lwjgl:lwjgl-glfw:3.4.1              -> org/lwjgl/.../lwjgl-glfw-3.4.1.jar（真正的 Java 类）
 *   org.lwjgl:lwjgl-glfw:3.4.1:natives-windows -> org/lwjgl/.../lwjgl-glfw-3.4.1-natives-windows.jar（只有 DLL）
 * 若忽略 classifier，这两条会撞成同一个 key，"后出现者胜"就会用只装 DLL 的
 * 平台 jar 顶掉主 jar，于是启动报 ClassNotFoundException: org.lwjgl.glfw.* 。
 * 带上 classifier 后，二者各自独立，都会被加进 classpath（lwjgl 3.x 会从 classpath 加载原生库）。
 */
function artifactKey(lib, relPath) {
  if (lib && typeof lib.name === 'string' && lib.name.split(':').length >= 2) {
    const parts = lib.name.split(':');
    // group:artifact:version[:classifier]
    return parts.length >= 4 ? parts[0] + ':' + parts[1] + ':' + parts[3] : parts[0] + ':' + parts[1];
  }
  const segs = String(relPath).split('/').filter(Boolean);
  if (segs.length >= 3) {
    return segs.slice(0, segs.length - 2).join('.') + ':' + segs[segs.length - 2];
  }
  return null;
}

/**
 * 解析依赖库：返回 classpath 里的 jar 与需要解压的 natives
 * classpath 按 group:artifact 去重：同一坐标只保留一个版本，
 * 后出现的（加载器 / 子版本）覆盖前面的（父版本 / MC 自带），
 * 否则 Fabric 的 Knot 会因 "duplicate ASM classes" 直接拒绝启动
 * @returns {{classpath: string[], natives: Array<{jar: string, exclude: string[]}>}}
 */
function resolveLibraries(json, features) {
  const librariesRoot = json.__librariesRoot || null;
  const seen = new Set();
  const classpath = [];
  const keyIndex = new Map();
  const natives = [];

  for (const lib of json.libraries || []) {
    if (!rulesAllow(lib.rules, features)) continue;

    const artifact = lib.downloads && lib.downloads.artifact;
    const classifiers = lib.downloads && lib.downloads.classifiers;

    // natives 分类器（windows / natives-windows / ${arch} 兼容老格式）
    let classifierKey = lib.natives && lib.natives[OS] ? lib.natives[OS] : null;
    if (classifierKey && classifierKey.indexOf('${arch}') !== -1) {
      classifierKey = classifierKey.replace('${arch}', OS === 'windows' ? (process.arch === 'ia32' ? '32' : '64') : '64');
    }

    let nativeArtifact = null;
    if (classifierKey) {
      nativeArtifact = classifiers && classifiers[classifierKey] ? classifiers[classifierKey] : null;
      if (!nativeArtifact) {
        // 老版本没有 downloads 字段，按 maven 坐标推导
        if (lib.name && lib.name.split(':').length >= 3) {
          nativeArtifact = { path: mavenPathFromName(lib.name.split(':').slice(0, 3).join(':') + ':' + classifierKey) };
        }
      }
    }

    let relPath = artifact && artifact.path ? artifact.path : null;
    if (!relPath && lib.name) relPath = mavenPathFromName(lib.name);
    if (relPath && !seen.has(relPath)) {
      seen.add(relPath);
      const key = artifactKey(lib, relPath);
      if (key && keyIndex.has(key)) {
        // 同坐标不同版本：保留后一个（加载器优先）
        classpath[keyIndex.get(key)] = relPath;
      } else {
        if (key) keyIndex.set(key, classpath.length);
        classpath.push(relPath);
      }
    }

    if (nativeArtifact && nativeArtifact.path && !seen.has(nativeArtifact.path)) {
      seen.add(nativeArtifact.path);
      natives.push({
        relPath: nativeArtifact.path,
        exclude: (lib.extract && lib.extract.exclude) || [],
      });
    }
  }

  // 转成绝对路径
  const libsDir = librariesRoot || path.join(gameDirOf(json), 'libraries');
  return {
    classpath: classpath.map((p) => path.join(libsDir, p)),
    natives: natives.map((n) => ({
      jar: path.join(libsDir, n.relPath),
      relPath: n.relPath,
      exclude: n.exclude,
    })),
    libraryCount: classpath.length,
  };
}

/** 版本主 jar（继承版取父版本，极老版本支持 jar 字段） */
function resolveGameJar(json) {
  if (json.jar && String(json.jar).trim() !== '') {
    const name = String(json.jar).trim();
    return path.join(path.dirname(json.__versionDir), name, name + '.jar');
  }
  if (json.__jarId && json.__jarDir) return path.join(json.__jarDir, json.__jarId + '.jar');
  return path.join(json.__versionDir, json.__id + '.jar');
}

function gameDirOf(json) {
  // __versionDir = <gameDir>/versions/<id>
  return path.resolve(json.__versionDir, '..', '..');
}

/** 推荐的 assets 根目录与资源索引名 */
function resolveAssets(json, gameDir) {
  const idx = json.assetIndex || {};
  const indexId = idx.id || '';
  const useVirtual = indexId === 'legacy' || indexId === 'pre-1.6' || (json.assets && json.assets === 'legacy');
  const virtualRoot = path.join(gameDir, 'assets', 'virtual', indexId || 'legacy');
  let assetsRoot = path.join(gameDir, 'assets');
  if (useVirtual) {
    assetsRoot = fs.existsSync(virtualRoot) ? virtualRoot : path.join(gameDir, 'assets', 'virtual', 'legacy');
  }
  return { indexId, assetsRoot, useVirtual };
}

module.exports = {
  OS,
  rulesAllow,
  ruleMatches,
  flattenArgs,
  loadProfile,
  mergeProfiles,
  resolveLibraries,
  resolveGameJar,
  resolveAssets,
  gameDirOf,
};
