'use strict';
const fs = require('fs');
const path = require('path');
const {
  loadProfile,
  resolveLibraries,
  resolveGameJar,
  resolveAssets,
  flattenArgs,
  OS,
} = require('./version-profile');
const { ensureNatives } = require('./natives');
const platform = require('./platform');
const { createOfflineAccount } = require('./offline-auth');
const { gameDirOf } = require('./version-profile');

const LAUNCHER_NAME = 'MCLauncher';
const LAUNCHER_VERSION = '0.1.0';

function applyTokens(str, tokens, unknownTokens) {
  return String(str).replace(/\$\{([^}]+)\}/g, (all, key) => {
    if (Object.prototype.hasOwnProperty.call(tokens, key)) return tokens[key];
    if (unknownTokens) unknownTokens.add(key);
    return all;
  });
}

function resolveJavaBin(javaPath) {
  if (!javaPath) throw new Error('未指定 Java 路径');
  let p = javaPath;
  let st;
  try { st = fs.statSync(p); } catch (e) { throw new Error('Java 路径不存在：' + javaPath); }
  if (st.isDirectory()) {
    if (platform.IS_WIN) {
      // Windows 行为保持不变：目录一律补 bin/javaw.exe
      p = path.join(p, 'bin', 'javaw.exe');
    } else {
      // macOS 的 .jdk bundle 可能是 <dir>/Contents/Home/bin/java
      const rels = platform.javaRelCandidates();
      const hit = rels.map((r) => path.join(javaPath, r)).find((c) => fs.existsSync(c));
      if (!hit) throw new Error('Java 可执行文件不存在：' + path.join(javaPath, rels[0]));
      p = hit;
    }
  }
  if (!fs.existsSync(p)) throw new Error('Java 可执行文件不存在：' + p);
  return p;
}

/**
 * 组织一次启动所需的一切
 * @param opts {gameDir, versionId, javaPath, playerName, minMemory, maxMemory, width, height, fullscreen, extraJvmArgs, extraGameArgs}
 * @param log 日志回调
 */
async function prepareLaunch(opts, log) {
  log = log || function () {};
  const { gameDir, versionId, javaPath, playerName } = opts;
  if (!gameDir || !fs.existsSync(gameDir)) throw new Error('游戏目录无效');
  if (!versionId) throw new Error('未选择版本');

  // 完整实例隔离：该版本使用独立游戏目录，存档/材质/选项/截图/模组全部独立
  let instanceDir = opts.instanceDir || null;
  if (instanceDir) {
    try {
      fs.mkdirSync(instanceDir, { recursive: true });
    } catch (e) {
      throw new Error('无法创建实例目录 ' + instanceDir + '：' + e.message);
    }
  }

  const profile = loadProfile(gameDir, versionId);
  const useCustomRes = !!opts.width && !!opts.height;
  const features = {
    has_custom_resolution: useCustomRes,
    is_demo_user: false,
  };

  const jarPath = resolveGameJar(profile);
  const { classpath, natives } = resolveLibraries(profile, features);
  const assets = resolveAssets(profile, gameDir);
  // 账号：传了正版账号就用正版（msa），否则离线登录
  const account =
    opts.account && opts.account.mode === 'msa' && opts.account.uuid && opts.account.accessToken
      ? {
          mode: 'msa',
          name: opts.account.name,
          uuid: opts.account.uuid,
          accessToken: opts.account.accessToken,
          userType: 'msa',
          userProperties: '{}',
        }
      : createOfflineAccount(playerName);

  const nativesDir = path.join(profile.__versionDir, 'natives', `${OS}-${process.arch}`);
  const nativesResult = await ensureNatives(nativesDir, natives, log);

  const classpathStr = classpath.concat([jarPath]).join(path.delimiter);

  const tokens = {
    classpath_separator: path.delimiter,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath: classpathStr,
    game_classpath: classpathStr,
    natives_directory: nativesDir,
    primary_jar: jarPath,
    library_directory: path.join(gameDir, 'libraries'),
    auth_player_name: account.name,
    auth_uuid: account.uuid,
    auth_access_token: account.accessToken,
    auth_session: account.accessToken,
    user_type: account.userType,
    user_properties: account.userProperties,
    version_name: profile.__id,
    version_type: profile.type || 'release',
    game_directory: instanceDir || gameDir,
    game_assets: assets.assetsRoot,
    assets_root: assets.assetsRoot,
    assets_index_name: assets.indexId || '',
    assets_index_version: (profile.assetIndex && profile.assetIndex.version) || '',
    resolution_width: String(opts.width || 854),
    resolution_height: String(opts.height || 480),
    language: 'zh_cn',
  };

  const unknown = new Set();

  // JVM 参数：新版用 arguments.jvm，老版给一份稳妥的默认
  let jvmArgs;
  if (profile.arguments && profile.arguments.jvm) {
    jvmArgs = flattenArgs(profile.arguments.jvm, features).slice();
  } else {
    jvmArgs = [
      '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump',
      '-Djava.library.path=${natives_directory}',
      '-cp',
      '${classpath}',
    ];
  }

  // 自定义参数放最后，确保覆盖 json 里的同名设置
  jvmArgs.push(
    `-Dminecraft.launcher.brand=${LAUNCHER_NAME}`,
    `-Dminecraft.launcher.version=${LAUNCHER_VERSION}`,
    `-Djava.library.path=${nativesDir}`
  );
  if (opts.forceUtf8 !== false) {
    // Windows 控制台默认是 GBK，强制 UTF-8 才能让日志区正常显示中文
    jvmArgs.push('-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8');
  }
  if (opts.maxMemory > 0) jvmArgs.push(`-Xmx${opts.maxMemory}M`);
  if (opts.minMemory > 0) jvmArgs.push(`-Xms${opts.minMemory}M`);
  if (opts.extraJvmArgs) {
    jvmArgs = jvmArgs.concat(String(opts.extraJvmArgs).trim().split(/\s+/).filter(Boolean));
  }

  // 游戏参数：新版 arguments.game，老版 minecraftArguments
  let gameArgs;
  if (profile.arguments && profile.arguments.game) {
    gameArgs = flattenArgs(profile.arguments.game, features).slice();
  } else if (profile.minecraftArguments) {
    gameArgs = String(profile.minecraftArguments).split(/\s+/).filter(Boolean);
  } else {
    // 极老的（无描述的）版本兜底
    gameArgs = ['--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}', '--assetsDir', '${game_assets}'];
  }
  if (useCustomRes) {
    if (!gameArgs.includes('--width')) gameArgs.push('--width', '${resolution_width}');
    if (!gameArgs.includes('--height')) gameArgs.push('--height', '${resolution_height}');
  }
  if (opts.fullscreen && !gameArgs.includes('--fullscreen')) gameArgs.push('--fullscreen');
  if (opts.extraGameArgs) {
    gameArgs = gameArgs.concat(String(opts.extraGameArgs).trim().split(/\s+/).filter(Boolean));
  }

  const mainClass = profile.mainClass || (profile.jar ? 'net.minecraft.launchwrapper.Launcher' : 'net.minecraft.client.main.Main');

  const allArgs = []
    .concat(jvmArgs.map((a) => applyTokens(a, tokens, unknown)))
    .concat([mainClass])
    .concat(gameArgs.map((a) => applyTokens(a, tokens, unknown)))
    .filter((a) => String(a).length > 0);

  if (unknown.size) log(`[提示] 存在无法识别的参数占位符，已原样保留：${Array.from(unknown).join(', ')}\n`);

  const command = resolveJavaBin(javaPath);

  return {
    ok: true,
    command,
    args: allArgs,
    cwd: instanceDir || gameDir,
    mainClass,
    jarPath,
    nativesDir,
    assets: assets.assetsRoot,
    indexId: assets.indexId,
    account,
    classpathCount: classpath.length,
    nativesCount: nativesResult.count,
    missingNatives: nativesResult.missing || [],
  };
}

module.exports = { prepareLaunch, resolveJavaBin, LAUNCHER_NAME, LAUNCHER_VERSION };
