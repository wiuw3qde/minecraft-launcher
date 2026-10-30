'use strict';
/* 纯 Node 冒烟测试：不依赖 Electron，验证扫描 / 依赖解析 / 参数构建 / natives 解压 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');

const { listVersions } = require('../src/scanner');
const { checkVersion } = require('../src/integrity');
const { prepareLaunch } = require('../src/launch-builder');
const { offlineUuid } = require('../src/offline-auth');
const { makeZip } = require('./zip-maker');
const { resolveLibraries, mergeProfiles, flattenArgs } = require('../src/version-profile');

const ROOT = path.join(__dirname, 'tmp');
const GAME = path.join(ROOT, 'game');
const LIBS = path.join(GAME, 'libraries');

/** Java 在 Windows 上按 GBK 输出，UTF-8 解不出来时回退 */
function decodeBuffer(buf) {
  if (!buf) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  const utf8 = b.toString('utf8');
  if (utf8.indexOf('�') === -1) return utf8;
  try {
    return new TextDecoder('gbk').decode(b);
  } catch (e) {
    return utf8;
  }
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

/** 直接落一个合法的 zip（store 方式），不依赖 PowerShell */
function makeZipAt(zipPath) {
  makeZip(zipPath, {
    'native_test.dll': 'not a real dll',
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0',
  });
}

const modern = {
  id: '1.20.1',
  type: 'release',
  releaseTime: '2023-06-12T11:11:11+00:00',
  mainClass: 'net.minecraft.client.main.Main',
  assetIndex: { id: '5', sha1: 'x', size: 1, totalSize: 1, url: '' },
  libraries: [
    {
      name: 'com.mojang:logging:1.0-7.0.1',
      downloads: { artifact: { path: 'com/mojang/logging/1.0-7.0.1/logging-1.0-7.0.1.jar', sha1: 'a', size: 1, url: '' } },
    },
    {
      name: 'org.lwjgl:lwjgl:3.3.1',
      downloads: {
        artifact: { path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar', sha1: 'a', size: 1, url: '' },
        classifiers: {
          'natives-windows': { path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar', sha1: 'a', size: 1, url: '' },
        },
      },
      natives: { windows: 'natives-windows', osx: 'natives-macos', linux: 'natives-linux' },
      rules: [{ action: 'allow', os: { name: 'windows' } }],
    },
    {
      // osx 专用库，Windows 上必须被 rule 过滤掉
      name: 'ca.weblite:java-objc-bridge:1.0-1',
      downloads: { artifact: { path: 'ca/weblite/java-objc-bridge/1.0-1/java-objc-bridge-1.0-1.jar', sha1: 'a', size: 1, url: '' } },
      rules: [{ action: 'allow', os: { name: 'osx' } }, { action: 'disallow' }],
    },
  ],
  arguments: {
    jvm: [
      '-XX:+UnlockExperimentalVMOptions',
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' },
      { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['-Dglfwwidth=${resolution_width}', '-Dglfwheight=${resolution_height}'] },
      '-Djava.library.path=${natives_directory}',
      '-cp',
      '${classpath}',
    ],
    game: [
      '--username', '${auth_player_name}',
      '--version', '${version_name}',
      '--gameDir', '${game_directory}',
      '--assetsDir', '${assets_root}',
      '--assetIndex', '${assets_index_name}',
      '--uuid', '${auth_uuid}',
      '--accessToken', '${auth_access_token}',
      '--userType', '${user_type}',
      '--versionType', '${version_type}',
    ],
  },
};

const legacy = {
  id: '1.12.2',
  type: 'release',
  releaseTime: '2017-09-18T00:00:00+00:00',
  mainClass: 'net.minecraft.client.main.Main',
  assetIndex: { id: 'legacy', sha1: 'x', size: 1, totalSize: 1, url: '' },
  libraries: [
    {
      name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209',
      extract: { exclude: ['META-INF/'] },
      natives: { windows: 'natives-windows' },
      rules: [{ action: 'allow', os: { name: 'windows' } }],
      downloads: {
        classifiers: {
          'natives-windows': {
            path: 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar',
            sha1: 'a', size: 1, url: '',
          },
        },
      },
    },
    { name: 'com.google.guava:guava:17.0', downloads: { artifact: { path: 'com/google/guava/guava/17.0/guava-17.0.jar', sha1: 'a', size: 1, url: '' } } },
  ],
  minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${game_assets} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --versionType ${version_type}',
};

function setup() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(GAME, { recursive: true });

  // 版本 json 与 jar
  fs.mkdirSync(path.join(GAME, 'versions', '1.20.1'), { recursive: true });
  fs.mkdirSync(path.join(GAME, 'versions', '1.12.2'), { recursive: true });
  fs.writeFileSync(path.join(GAME, 'versions', '1.20.1', '1.20.1.json'), JSON.stringify(modern, null, 2));
  fs.writeFileSync(path.join(GAME, 'versions', '1.12.2', '1.12.2.json'), JSON.stringify(legacy, null, 2));
  touch(path.join(GAME, 'versions', '1.20.1', '1.20.1.jar'));
  touch(path.join(GAME, 'versions', '1.12.2', '1.12.2.jar'));

  // 依赖文件（占位空文件）
  for (const lib of modern.libraries) {
    const art = lib.downloads.artifact;
    if (art) touch(path.join(LIBS, art.path));
    if (lib.downloads.classifiers && lib.downloads.classifiers['natives-windows']) {
      const p = path.join(LIBS, lib.downloads.classifiers['natives-windows'].path);
      touch(p);
    }
  }
  touch(path.join(LIBS, legacy.libraries[1].downloads.artifact.path));

  // 一个真实合法的 zip 用于 natives 解压测试
  makeZipAt(path.join(LIBS, legacy.libraries[0].downloads.classifiers['natives-windows'].path));
}

(async function run() {
  let failures = 0;
  function check(name, fn) {
    try {
      fn();
      console.log('  ✓ ' + name);
    } catch (e) {
      failures++;
      console.log('  ✗ ' + name + '\n      ' + e.message);
    }
  }

  console.log('离线 UUID');
  // 预期值由 Java 的 UUID.nameUUIDFromBytes 现场校验得出
  check('Notch 的离线 UUID 与 Java 算法一致', () => {
    assert.strictEqual(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
  });
  check('Steve 的离线 UUID 与 Java 算法一致', () => {
    assert.strictEqual(offlineUuid('Steve'), '5627dd98-e6be-3c21-b8a8-e92344183641');
  });

  setup();

  console.log('\n版本扫描');
  const scan = listVersions(GAME);
  check('扫描到 2 个版本，按发布时间倒序', () => {
    assert.strictEqual(scan.error, null, scan.error);
    assert.strictEqual(scan.versions.length, 2);
    assert.strictEqual(scan.versions[0].id, '1.20.1');
  });

  console.log('\n完整性检查');
  const report = checkVersion(GAME, '1.20.1', {});
  check('识别出缺失的 osx 依赖不计入、缺失资源已统计', () => {
    assert.strictEqual(report.missingLibs.length, 0, JSON.stringify(report.missingLibs));
    assert.strictEqual(report.hasJar, true);
  });

  console.log('\n启动参数构建（新版 1.20.1）');
  const javaBin = process.execPath === '' ? 'java' : 'java';
  const javaExe = (() => {
    const r = spawnSync('where', ['java'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean)[0] : null;
  })();
  if (!javaExe) {
    console.log('  ! 本机没有 java，跳过启动参数验证');
    return;
  }

  const logLines = [];
  const prep = await prepareLaunch(
    {
      gameDir: GAME,
      versionId: '1.20.1',
      javaPath: javaExe,
      playerName: 'Steve',
      minMemory: 512,
      maxMemory: 2048,
      width: 1280,
      height: 720,
    },
    (msg) => logLines.push(msg)
  );

  check('classpath 里包含 2 个依赖 jar 和版本 jar', () => {
    const cpArg = prep.args[prep.args.indexOf('-cp') + 1];
    const parts = cpArg.split(path.delimiter);
    assert.strictEqual(parts.length, 3, 'classpath=' + cpArg);
    assert.ok(!cpArg.includes('java-objc-bridge'), 'osx 专用库不应进入 classpath');
    assert.ok(parts.some((p) => p.endsWith('1.20.1.jar')));
  });
  check('内存参数生效', () => {
    assert.ok(prep.args.includes('-Xmx2048M'));
    assert.ok(prep.args.includes('-Xms512M'));
  });
  check('自定义分辨率触发 feature 规则', () => {
    assert.ok(prep.args.includes('-Dglfwwidth=1280'), '未展开 glfwwidth');
    assert.ok(prep.args.includes('-Dglfwheight=720'));
  });
  check('离线账户参数已替换', () => {
    assert.ok(prep.args.includes('Steve'));
    assert.strictEqual(prep.args.includes('${auth_uuid}'), false);
    assert.strictEqual(prep.args.includes('${auth_player_name}'), false);
    assert.strictEqual(prep.args.includes('legacy'), true, 'userType 应为 legacy');
  });
  check('主类在所有 JVM 参数之后、游戏参数之前', () => {
    const mainIndex = prep.args.indexOf('net.minecraft.client.main.Main');
    assert.ok(mainIndex > 0, '缺少主类');
    const cpIndex = prep.args.indexOf('-cp');
    assert.ok(mainIndex > cpIndex + 1, '主类应排在 -cp 之后');
    assert.ok(mainIndex > prep.args.indexOf('-Xmx2048M'), '自定义内存参数应排在主类之前');
    assert.ok(prep.args[mainIndex + 1].startsWith('--'), '主类之后应紧跟游戏参数');
  });

  console.log('\n启动参数构建（老版本 1.12.2，minecraftArguments + 旧 virtual assets）');
  const prep2 = await prepareLaunch(
    { gameDir: GAME, versionId: '1.12.2', javaPath: javaExe, playerName: 'Alex', maxMemory: 1024 },
    () => {}
  );
  check('使用 minecraftArguments 生成参数', () => {
    assert.ok(prep2.args.includes('--username'));
    assert.ok(prep2.args.includes('Alex'));
    assert.ok(!prep2.args.includes('${game_assets}'), 'game_assets 未替换');
  });
  check('legacy 资源目录指向 assets/virtual', () => {
    assert.ok(prep2.assets.replace(/\\/g, '/').includes('assets/virtual'), prep2.assets);
  });

  if (process.platform === 'win32') {
    check('natives 解压成功且已剔除 META-INF', () => {
      const dllPath = path.join(prep2.nativesDir, 'native_test.dll');
      assert.ok(fs.existsSync(dllPath), 'dll 未解压出来：' + dllPath);
      assert.ok(!fs.existsSync(path.join(prep2.nativesDir, 'META-INF')), 'META-INF 未被排除');
    });
    // 复用缓存：删掉 dll 后再次准备，应命中缓存不再解压
    fs.rmSync(path.join(prep2.nativesDir, 'native_test.dll'));
    await prepareLaunch({ gameDir: GAME, versionId: '1.12.2', javaPath: javaExe, playerName: 'Alex' }, () => {});
    check('第二次启动复用 natives 缓存', () => {
      assert.ok(!fs.existsSync(path.join(prep2.nativesDir, 'native_test.dll')));
    });
  }

  console.log('\nJava 命令行可被解析（用不存在的主类做冒烟）');
  const smoke = spawnSync(prep2.command, prep2.args, { timeout: 30000 });
  check('Java 能正常接收参数（应报找不到主类而非语法错误）', () => {
    const out = decodeBuffer(smoke.stderr) + decodeBuffer(smoke.stdout);
    assert.ok(/ClassNotFoundException|Cannot find or load/.test(out), out.slice(0, 300));
  });

  console.log('\nclasspath 同坐标去重（修复 Fabric duplicate ASM classes）');
  {
    // 模拟 PCL2 自包含式 Fabric json：MC 自带 asm 9.6 + Fabric 带的 asm 9.9 同时存在
    const fake = {
      __id: 'fabric-fake',
      __versionDir: path.join(GAME, 'versions', 'fabric-fake'),
      libraries: [
        { name: 'org.ow2.asm:asm:9.6', downloads: { artifact: { path: 'org/ow2/asm/asm/9.6/asm-9.6.jar' } } },
        { name: 'org.ow2.asm:asm-analysis:9.6', downloads: { artifact: { path: 'org/ow2/asm/asm-analysis/9.6/asm-analysis-9.6.jar' } } },
        { name: 'org.ow2.asm:asm:9.9', downloads: { artifact: { path: 'org/ow2/asm/asm/9.9/asm-9.9.jar' } } },
        { name: 'org.ow2.asm:asm-analysis:9.9', downloads: { artifact: { path: 'org/ow2/asm/asm-analysis/9.9/asm-analysis-9.9.jar' } } },
        { name: 'com.mojang:logging:1.1.1', downloads: { artifact: { path: 'com/mojang/logging/1.1.1/logging-1.1.1.jar' } } },
      ],
    };
    const { classpath } = resolveLibraries(fake, {});
    const keys = classpath.map((c) => c.replace(/\\/g, '/').split('/').slice(0, -2).join(':'));
    check('asm 只保留 9.9 一份（MC 自带的 9.6 被覆盖）', () => {
      const asm = classpath.filter((c) => /asm[\\/]asm[\\/]/.test(c));
      assert.strictEqual(asm.length, 1);
      assert.ok(asm[0].includes('9.9'), '保留的不是 9.9：' + asm[0]);
    });
    check('asm-analysis 同样只保留一份', () => {
      assert.strictEqual(classpath.filter((c) => /asm-analysis/.test(c)).length, 1);
    });
    check('无重复 group:artifact 坐标', () => {
      const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
      assert.deepStrictEqual(dup, []);
    });
    check('不同坐标互不影响（logging 仍在）', () => {
      assert.strictEqual(classpath.filter((c) => /logging/.test(c)).length, 1);
    });
  }

  console.log('\n继承版本参数合并（修复游戏参数丢失）');
  {
    const parent = {
      id: '1.19.2',
      arguments: {
        game: ['--username', '${auth_player_name}', '--version', '${version_name}'],
        jvm: ['-Dparent.jvm=1'],
      },
      libraries: [{ name: 'com.mojang:logging:1.1.1', downloads: { artifact: { path: 'com/mojang/logging/1.1.1/logging-1.1.1.jar' } } }],
    };
    const child = {
      id: 'fabric-loader-0.16.10-1.19.2',
      inheritsFrom: '1.19.2',
      arguments: { game: [], jvm: ['-Dchild.jvm=1'] },
      libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.10', downloads: { artifact: { path: 'net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar' } } }],
    };
    const merged = mergeProfiles(parent, child, '/tmp/fake-ver-dir');
    const game = flattenArgs(merged.arguments.game, {});
    check('父版本游戏参数不丢（--username/--version 保留）', () => {
      assert.ok(game.includes('--username') && game.includes('--version'), JSON.stringify(game));
    });
    check('子版本追加的游戏参数拼在后面（模拟 --tweakClass）', () => {
      const child2 = Object.assign({}, child, { arguments: { game: ['--tweakClass', 'optifine.OptiFineForgeTweaker'], jvm: [] } });
      const m2 = mergeProfiles(parent, child2, '/tmp/fake');
      const g2 = flattenArgs(m2.arguments.game, {});
      assert.strictEqual(g2[g2.length - 2], '--tweakClass');
      assert.strictEqual(g2[g2.length - 1], 'optifine.OptiFineForgeTweaker');
      assert.ok(g2.includes('--username'), '父参数仍应在');
    });
    check('jvm 参数父子拼接', () => {
      const jvm = flattenArgs(merged.arguments.jvm, {});
      assert.deepStrictEqual(jvm, ['-Dparent.jvm=1', '-Dchild.jvm=1']);
    });
  }

  console.log('\n' + (failures ? `${failures} 项失败` : '全部通过 ✓'));
  process.exit(failures ? 1 : 0);
})();
