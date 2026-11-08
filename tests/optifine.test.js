'use strict';
/* OptiFine 安装集成测试：无人值守安装 + Forge 组合版生成 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const loaders = require('../src/loaders');
const { loadProfile, resolveLibraries, resolveGameJar, flattenArgs } = require('../src/version-profile');

const PROBE = 'C:/Users/Administrator/AppData/Local/Temp/mc-forge-probe/game';
const ROOT = path.join(os.tmpdir(), 'mc-of-test-' + Date.now());
const GAME = path.join(ROOT, 'game');
const MIRRORS = ['bmclapi'];

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failures++;
    console.log('  ✗ ' + name + '\n    ' + e.message);
  }
}

async function javaPath() {
  const jf = require('../src/java-finder');
  const list = await jf.findJavaCandidates(GAME, 17);
  if (!list.length) throw new Error('本机找不到 Java');
  return list[0].path;
}

(async () => {
  console.log('OptiFine 安装测试（真实网络 + 真实安装器）\n');

  // 前置条件：需要本机 mc-forge-probe 里已装好原版 1.20.1 与对应 Forge 版本。
  // 缺失时应当「跳过」而不是抛异常退出 1，否则会掐断 package.json 里 && 串起的整条测试链，
  // 导致后面的测试全部静默不执行。
  const REQUIRED = [
    path.join(PROBE, 'versions', '1.20.1', '1.20.1.json'),
    path.join(PROBE, 'versions', '1.20.1', '1.20.1.jar'),
    path.join(PROBE, 'versions', '1.20.1-forge-47.4.28', '1.20.1-forge-47.4.28.json'),
  ];
  const missing = REQUIRED.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.log('! 跳过 OptiFine 安装集成测试：缺少前置版本文件（mc-forge-probe 未准备）。');
    console.log('  缺少：\n  ' + missing.join('\n  '));
    console.log('  属环境依赖，不影响其它测试；准备好后本测试会自动启用。');
    process.exit(0);
  }

  // 最小化游戏目录：只要版本 json + jar 存在，安装器就能干活
  fs.mkdirSync(path.join(GAME, 'versions', '1.20.1'), { recursive: true });
  fs.copyFileSync(path.join(PROBE, 'versions', '1.20.1', '1.20.1.json'), path.join(GAME, 'versions', '1.20.1', '1.20.1.json'));
  fs.copyFileSync(path.join(PROBE, 'versions', '1.20.1', '1.20.1.jar'), path.join(GAME, 'versions', '1.20.1', '1.20.1.jar'));
  loaders.ensureLauncherProfiles(GAME);
  const java = await javaPath();
  console.log('Java: ' + java + '\n');

  /* ---------- 1. 独立安装 ---------- */
  console.log('=== 独立安装 OptiFine 1.20.1 HD_U_I5 ===');
  const list = await loaders.listOptiFine('1.20.1', MIRRORS);
  check('能拉到 OptiFine 列表', () => {
    assert.ok(list.ok, list.error || '');
    assert.ok(list.versions.length > 0);
  });
  const entry = list.versions.find((v) => v.version === 'HD_U_I5');
  check('列表含 HD_U_I5 且标注适配 Forge', () => {
    assert.ok(entry, '没找到 HD_U_I5');
    assert.ok(/Forge/.test(entry.forge || ''), 'forge 字段异常：' + entry.forge);
  });

  const res = await loaders.installOptiFine({
    gameDir: GAME,
    mcVersion: '1.20.1',
    type: entry.type,
    patch: entry.patch,
    filename: entry.filename,
    mirrorIds: MIRRORS,
    javaPath: java,
    onLog: () => {},
  });
  check('无人值守安装成功', () => {
    assert.ok(res.ok, res.error || '未知错误');
  });
  check('生成了独立版本 1.20.1-OptiFine_HD_U_I5', () => {
    assert.ok(fs.existsSync(path.join(GAME, 'versions', '1.20.1-OptiFine_HD_U_I5', '1.20.1-OptiFine_HD_U_I5.json')));
  });
  check('OptiFine 库文件已就位', () => {
    assert.ok(fs.existsSync(path.join(GAME, 'libraries', 'optifine', 'OptiFine', '1.20.1_HD_U_I5', 'OptiFine-1.20.1_HD_U_I5.jar')));
  });
  check('独立版可被启动逻辑解析（launchwrapper + OptiFineTweaker）', () => {
    const p = loadProfile(GAME, '1.20.1-OptiFine_HD_U_I5');
    assert.strictEqual(p.mainClass, 'net.minecraft.launchwrapper.Launch');
    const game = flattenArgs(p.arguments.game, { has_custom_resolution: true });
    assert.ok(game.includes('--tweakClass'), '缺少 tweakClass');
    assert.ok(game.includes('--username'), '父版本游戏参数丢失');
    const { classpath } = resolveLibraries(p, { has_custom_resolution: true });
    assert.ok(classpath.some((c) => /OptiFine-1\.20\.1_HD_U_I5\.jar$/.test(c)), 'classpath 里没有 OptiFine');
    assert.strictEqual(resolveGameJar(p).endsWith('1.20.1.jar'), true, '本体 jar 应指向父版本');
  });

  /* ---------- 2. Forge 组合安装 ---------- */
  console.log('\n=== Forge + OptiFine 组合安装 ===');
  // 造一个已安装的 Forge 版本（Forge 47.x 是 inheritsFrom 继承版，只有 json 没有自己的 jar）
  const forgeId = '1.20.1-forge-47.4.28';
  fs.mkdirSync(path.join(GAME, 'versions', forgeId), { recursive: true });
  fs.copyFileSync(path.join(PROBE, 'versions', forgeId, forgeId + '.json'), path.join(GAME, 'versions', forgeId, forgeId + '.json'));

  const combo = await loaders.installOptiFine({
    gameDir: GAME,
    mcVersion: '1.20.1',
    type: entry.type,
    patch: entry.patch,
    filename: entry.filename,
    forge: entry.forge,
    comboForge: true,
    mirrorIds: MIRRORS,
    javaPath: java,
    onLog: () => {},
  });
  check('组合安装成功', () => {
    assert.ok(combo.ok, combo.error || '未知错误');
    assert.strictEqual(combo.combo, true);
  });
  const comboId = '1.20.1-Forge_47.4.28-OptiFine_HD_U_I5';
  check('组合版本目录与 json 已生成', () => {
    assert.ok(fs.existsSync(path.join(GAME, 'versions', comboId, comboId + '.json')));
  });
  check('独立版目录已清理（版本列表不出现两份）', () => {
    assert.ok(!fs.existsSync(path.join(GAME, 'versions', '1.20.1-OptiFine_HD_U_I5')));
  });
  check('组合版可被启动逻辑解析', () => {
    const p = loadProfile(GAME, comboId);
    // 主类继承 Forge（47.x 用 BootstrapLauncher）
    assert.strictEqual(p.mainClass, 'cpw.mods.bootstraplauncher.BootstrapLauncher');
    // 游戏参数 = Forge 的 + OptiFineForgeTweaker
    const game = flattenArgs(p.arguments.game, { has_custom_resolution: true });
    const ti = game.lastIndexOf('--tweakClass');
    assert.ok(ti >= 0, '缺少 --tweakClass');
    assert.strictEqual(game[ti + 1], 'optifine.OptiFineForgeTweaker');
    assert.ok(game.includes('--username'), 'Forge 的游戏参数丢失');
    // classpath 含 OptiFine 库，且无重复坐标
    const { classpath } = resolveLibraries(p, { has_custom_resolution: true });
    assert.ok(classpath.some((c) => /OptiFine-1\.20\.1_HD_U_I5\.jar$/.test(c)), 'classpath 里没有 OptiFine');
    // 回归防护：lwjgl 主 jar（真正含 Java 类）必须与平台 natives jar 同时在 classpath。
    // 若被"按 group:artifact 去重"顶掉，启动会报 ClassNotFoundException: org.lwjgl.glfw.*
    assert.ok(
      classpath.some((c) => /lwjgl-glfw-[\d.]+\.jar$/.test(c)),
      'classpath 缺少 lwjgl-glfw 主 jar（只剩平台 natives jar 会导致 org.lwjgl.glfw.* 找不到）'
    );
    // 同一坐标 group:artifact:classifier 只允许一个版本。
    // classifier 必须参与判重：MC 新写法把平台 natives 拆成独立 library 条目、
    // 与主 jar 同处一个 maven 目录，二者是不同制品且必须共存，不算重复坐标。
    const coordOf = (c) => {
      const segs = c.replace(/\\/g, '/').split('/');
      const n = segs.length;
      const file = segs[n - 1].replace(/\.jar$/, '');
      const version = segs[n - 2];
      const artifact = segs[n - 3];
      const dirKey = segs.slice(0, -2).join(':');
      const prefix = artifact + '-' + version;
      const classifier = file.startsWith(prefix) ? file.slice(prefix.length).replace(/^-/, '') : '';
      return dirKey + ':' + classifier;
    };
    const keys = classpath.map(coordOf);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepStrictEqual(dup, [], '存在重复坐标');
    // 本体 jar 指向父版本（Forge 47.x 无自己的 jar，用原版 1.20.1）
    assert.ok(resolveGameJar(p).endsWith('1.20.1.jar'), '本体 jar 应指向原版 1.20.1，实际：' + resolveGameJar(p));
  });

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过 ✓'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
