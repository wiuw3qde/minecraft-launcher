'use strict';
/* 加载器集成测试：真实拉取各列表 + 在已装好的原版 1.20.1 上自动安装 Fabric 并检查启动参数 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const loaders = require('../src/loaders');
const { prepareLaunch } = require('../src/launch-builder');
const { listVersions } = require('../src/scanner');

const MIRRORS = ['bmclapi'];
const PROBE_GAME = path.join(os.tmpdir(), 'mc-forge-probe', 'game');

(async function run() {
  let failures = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log('  ✓ ' + name);
    } catch (e) {
      failures++;
      console.log('  ✗ ' + name + '\n      ' + String(e.message).slice(0, 300));
    }
  };

  console.log('版本列表（镜像接口）');
  await check('Fabric 列表', async () => {
    const r = await loaders.listFabric('1.20.1', MIRRORS);
    assert.ok(r.ok, r.error);
    assert.ok(r.versions.length > 10, '版本太少');
    console.log('      ' + r.versions.length + ' 个 loader，最新 ' + r.versions[0].version);
  });
  await check('Forge 列表（官方 maven-metadata）', async () => {
    const r = await loaders.listForge('1.20.1', MIRRORS);
    assert.ok(r.ok, r.error);
    assert.ok(r.versions.length > 10);
    assert.ok(r.versions[0].raw.startsWith('1.20.1-'), r.versions[0].raw);
    console.log('      ' + r.versions.length + ' 个版本，最新 ' + r.versions[0].raw);
  });
  await check('NeoForge 列表', async () => {
    const r = await loaders.listNeoForge('1.20.1', MIRRORS);
    assert.ok(r.ok, r.error);
    assert.ok(r.versions.length > 0);
  });
  await check('OptiFine 列表', async () => {
    const r = await loaders.listOptiFine('1.20.1', MIRRORS);
    assert.ok(r.ok, r.error);
    assert.ok(r.versions.length > 0);
    console.log('      共 ' + r.versions.length + ' 个，例如 ' + r.versions[0].version);
  });

  const hasProbe = fs.existsSync(path.join(PROBE_GAME, 'versions', '1.20.1'));
  if (!hasProbe) {
    console.log('\n! 缺少已装好的原版 1.20.1（mctest 临时目录），跳过 Fabric 安装测试');
    return;
  }

  console.log('\nFabric 安装 + 启动参数');
  let fabricId = null;
  let pickedLoader = null;
  await check('安装 Fabric（自动下载 loader / intermediary / mixin）', async () => {
    const list = await loaders.listFabric('1.20.1', MIRRORS);
    pickedLoader = (list.versions.find((v) => v.stable) || list.versions[0]).version;
    const res = await loaders.installFabric({
      gameDir: PROBE_GAME,
      gameVersion: '1.20.1',
      loaderVersion: pickedLoader,
      mirrorIds: MIRRORS,
      concurrency: 16,
      onLog: (t) => process.stdout.write('      ' + t),
    });
    assert.ok(res.ok, res.error || JSON.stringify(res.failed));
    fabricId = res.versionId;
    assert.ok(fs.existsSync(path.join(PROBE_GAME, 'versions', fabricId, fabricId + '.json')), '版本描述未生成');
    console.log('      版本 ' + fabricId + '，新下载 ' + res.downloaded + ' 个文件');
  });

  await check('启动器能识别 Fabric 版本', async () => {
    const res = listVersions(PROBE_GAME);
    assert.ok(res.versions.some((v) => v.id === fabricId), '未被版本扫描识别');
  });

  await check('启动参数：本体 jar 正确指向父版本 1.20.1', async () => {
    const where = require('child_process').spawnSync('where', ['java'], { encoding: 'utf8' });
    const javaExe = where.status === 0 ? where.stdout.split(/\r?\n/).filter(Boolean)[0] : 'java';
    const prep = await prepareLaunch(
      { gameDir: PROBE_GAME, versionId: fabricId, javaPath: javaExe, playerName: 'Steve', maxMemory: 1024 },
      () => {}
    );
    assert.ok(prep.jarPath.endsWith(path.join('1.20.1', '1.20.1.jar')), 'jar 指向错误：' + prep.jarPath);
    assert.strictEqual(prep.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient', '主类错误：' + prep.mainClass);
    const cp = prep.args[prep.args.indexOf('-cp') + 1];
    assert.ok(cp.includes('fabric-loader-' + pickedLoader), 'classpath 缺少 fabric-loader');
    assert.ok(cp.includes('intermediary-1.20.1'), 'classpath 缺少 intermediary');
    assert.ok(!cp.includes('${'), '存在未替换的占位符');
    console.log('      主类 ' + prep.mainClass + '，本体 ' + path.basename(prep.jarPath) + '，依赖 ' + prep.classpathCount + ' 个');
  });

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过 ✓'));
  process.exit(failures ? 1 : 0);
})();
