'use strict';
/* 下载链路实测：从镜像真实拉取一个老版本（本体+依赖），再抽查资源对象下载 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { loadManifest, installVersion, collectAssetTasks, createVirtualAssets } = require('../src/installer');
const { candidatesFor } = require('../src/mirrors');
const { downloadFile, runPool } = require('../src/downloader');
const { readJsonFile } = require('../src/util');

const GAME = path.join(os.tmpdir(), 'mc-launcher-download-test', 'game');
const MIRRORS = ['bmclapi'];

(async function run() {
  let failures = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log('  ✓ ' + name);
    } catch (e) {
      failures++;
      console.log('  ✗ ' + name + '\n      ' + e.message);
    }
  };

  fs.rmSync(GAME, { recursive: true, force: true });
  fs.mkdirSync(GAME, { recursive: true });

  let manifest = null;
  await check('拉取版本清单（含 old_beta/old_alpha 共 900+ 版本）', async () => {
    const res = await loadManifest(MIRRORS, false, () => {});
    assert.ok(res.ok, res.error);
    manifest = res.versions;
    const types = new Set(manifest.map((v) => v.type));
    assert.ok(types.has('old_beta'), '缺少 old_beta');
    assert.ok(types.has('snapshot'), '缺少 snapshot');
    assert.ok(manifest.length > 900, '版本数偏少：' + manifest.length);
    console.log('      清单来源：' + res.source + '，共 ' + manifest.length + ' 个版本，类型：' + Array.from(types).join('/'));
  });

  await check('安装 b1.7.3（本体 jar + 依赖库，含 sha1 校验）', async () => {
    let last = null;
    const res = await installVersion({
      gameDir: GAME,
      versionId: 'b1.7.3',
      mirrorIds: MIRRORS,
      skipAssets: true,
      concurrency: 12,
      onLog: (t) => process.stdout.write('      ' + t),
      onProgress: (p) => {
        last = p;
      },
    });
    assert.ok(res.ok, JSON.stringify(res.failed));
    assert.ok(last && last.done > 0, '进度未上报');
    const jar = path.join(GAME, 'versions', 'b1.7.3', 'b1.7.3.jar');
    assert.ok(fs.existsSync(jar) && fs.statSync(jar).size > 100000, '本体 jar 未下载');
    const json = readJsonFile(path.join(GAME, 'versions', 'b1.7.3', 'b1.7.3.json'));
    const libCount = (json.libraries || []).length;
    console.log('      已下载 ' + res.downloaded + ' 个文件，跳过 ' + res.skipped + ' 个，' + Math.round(res.bytes / 1024) + ' KB，依赖声明 ' + libCount + ' 项');
  });

  await check('重复安装应全部命中缓存（跳过而非重下）', async () => {
    const res = await installVersion({
      gameDir: GAME,
      versionId: 'b1.7.3',
      mirrorIds: MIRRORS,
      skipAssets: true,
      concurrency: 12,
    });
    assert.strictEqual(res.downloaded, 0, '不应重复下载：' + res.downloaded);
    assert.ok(res.skipped > 0);
  });

  await check('资源索引 + 抽查 5 个资源对象（走镜像 assets 路径）', async () => {
    const idxPath = path.join(GAME, 'assets', 'indexes', 'pre-1.6.json');
    const json = readJsonFile(path.join(GAME, 'versions', 'b1.7.3', 'b1.7.3.json'));
    const res = await downloadFile(candidatesFor(json.assetIndex.url, MIRRORS), idxPath, {
      sha1: json.assetIndex.sha1,
      size: json.assetIndex.size,
    });
    assert.ok(res.ok, res.error);
    const { tasks, objects } = collectAssetTasks(idxPath, GAME, MIRRORS);
    assert.ok(tasks.length > 100, '资源对象数偏少：' + tasks.length);
    const sample = tasks.slice(0, 5);
    const out = await runPool(sample, 5, (t) => downloadFile(t.urls, t.dest, { sha1: t.sha1, size: t.size }));
    const okCount = out.filter((r) => r.ok && r.value && r.value.ok).length;
    assert.strictEqual(okCount, 5, '资源对象下载失败：' + JSON.stringify(out.filter((r) => !(r.value && r.value.ok)).map((r) => r.error).slice(0, 2)));
    const virtualCount = createVirtualAssets(GAME, objects, json.assetIndex.id, () => {});
    assert.ok(virtualCount >= 5, '老版本虚拟资源未生成');
    console.log('      索引内共 ' + tasks.length + ' 个对象，已生成 virtual/' + json.assetIndex.id + ' 副本 ' + virtualCount + ' 个');
  });

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过 ✓'));
  process.exit(failures ? 1 : 0);
})();
