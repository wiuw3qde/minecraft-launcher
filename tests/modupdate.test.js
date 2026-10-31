'use strict';
/* Mod 更新检测（A 功能）离线单测：jar 元数据解析 + 更新状态判定 + sidecar 读写。
 * 网络部分用桩替换 modplatforms.getProjectVersions，不联网。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeZip } = require('./zip-maker');
const jarmeta = require('../src/jarmeta');
const modupdate = require('../src/modupdate');
const modplatforms = require('../src/modplatforms');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    console.log('  ✗ ' + msg);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-modupd-'));
const gameDir = path.join(tmp, 'gamedir');
const versionId = 'fabric-loader-0.15.7-1.20.1';
const modsDir = path.join(gameDir, 'versions', versionId, 'mods');
fs.mkdirSync(modsDir, { recursive: true });

// 1) fabric mod：custom.modrinth.project_id
makeZip(path.join(modsDir, 'sodium.jar'), {
  'fabric.mod.json': JSON.stringify({
    id: 'sodium',
    version: '0.5.3',
    name: 'Sodium',
    custom: { modrinth: { project_id: 'AANobbMI' } },
  }),
});
// 2) forge mod：mods.toml 注释里的 modrinth 链接
makeZip(path.join(modsDir, 'jei.jar'), {
  'META-INF/mods.toml':
    'modLoader="javafml"\n[[mods]]\nmodId="jei"\nversion="15.1.0"\n# https://modrinth.com/mod/jei\n',
});
// 3) 完全没有来源信息的 mod
makeZip(path.join(modsDir, 'mystery.jar'), { 'foo.txt': 'nothing' });
// 4) jar 里没有任何 modrinth 痕迹、但文件 hash 能在 Modrinth 上查到的 mod
makeZip(path.join(modsDir, 'litematica.jar'), { 'foo.txt': 'x' });
// 4) jar 内无元数据、但本启动器安装时写了 sidecar 的 mod
makeZip(path.join(modsDir, 'iris.jar'), { 'foo.txt': 'x' });
fs.writeFileSync(
  path.join(modsDir, '.mclauncher-mods.json'),
  JSON.stringify({
    iris: {
      projectId: 'YL57xq9U',
      slug: 'YL57xq9U',
      versionId: 'v1',
      versionNumber: '1.6.4',
      loader: 'fabric',
      gameVersions: ['1.20.1'],
    },
  })
);

console.log('jar 元数据解析');
const mSodium = jarmeta.readJarMeta(path.join(modsDir, 'sodium.jar'));
ok(mSodium.slug === 'AANobbMI', 'fabric.mod.json 里的 modrinth project_id 被识别：' + mSodium.slug);
ok(mSodium.version === '0.5.3', 'fabric mod 版本解析正确：' + mSodium.version);
ok(mSodium.loaderHint === 'fabric', '加载器提示为 fabric');

const mJei = jarmeta.readJarMeta(path.join(modsDir, 'jei.jar'));
ok(mJei.slug === 'jei', 'mods.toml 注释里的 modrinth 链接被识别：' + mJei.slug);
ok(mJei.version === '15.1.0', 'forge mod 版本解析正确：' + mJei.version);
ok(mJei.loaderHint === 'forge', '加载器提示为 forge');

const mMystery = jarmeta.readJarMeta(path.join(modsDir, 'mystery.jar'));
ok(!mMystery.slug, '无来源信息的 mod 不误判来源');

console.log('更新状态判定（桩数据，实例 mc=1.20.1 / fabric）');
const DB = {
  AANobbMI: [
    { id: 'old', version_number: '0.5.3', game_versions: ['1.20.1'], loaders: ['fabric'], date_published: '2023-06-01' },
    { id: 'new', version_number: '0.5.8', game_versions: ['1.20.1'], loaders: ['fabric'], date_published: '2024-01-01' },
    { id: 'mc119', version_number: '0.5.9', game_versions: ['1.19.4'], loaders: ['fabric'], date_published: '2024-06-01' },
  ],
  jei: [{ id: 'jei-new', version_number: '15.2.0', game_versions: ['1.20.1'], loaders: ['forge'], date_published: '2024-02-01' }],
  YL57xq9U: [
    { id: 'iris1', version_number: '1.6.4', game_versions: ['1.20.1'], loaders: ['fabric'], date_published: '2024-03-01' },
  ],
  // 版本号字符串与 jar 内写法不同（Modrinth 上常见 mc1.20.1-0.5.13-fabric 这类），
  // 只有靠 hash 拿到 version id 才能判准，否则会被误判成「有更新」
  litematica: [
    { id: 'L1', version_number: 'mc1.20.1-0.5.13-fabric', game_versions: ['1.20.1'], loaders: ['fabric'], date_published: '2024-05-01' },
  ],
};
modplatforms.getProjectVersions = async (slug) => DB[slug] || [];

(async () => {
  // hash 反查桩：sodium 命中旧版 0.5.3，iris 命中 1.6.4，litematica 命中唯一版本 L1
  const sha = async (f) => await modplatforms.sha1File(path.join(modsDir, f));
  const HASH_DB = {};
  HASH_DB[await sha('sodium.jar')] = { id: 'old', project_id: 'AANobbMI', version_number: '0.5.3' };
  HASH_DB[await sha('iris.jar')] = { id: 'iris1', project_id: 'YL57xq9U', version_number: '1.6.4' };
  HASH_DB[await sha('litematica.jar')] = { id: 'L1', project_id: 'litematica', version_number: '0.5.13+mc1.20.1' };
  modplatforms.getVersionsByHashes = async (hashes) => {
    const out = {};
    (hashes || []).forEach((x) => { if (HASH_DB[x]) out[x] = HASH_DB[x]; });
    return out;
  };

  const res = await modupdate.checkUpdates({
    gameDir,
    versionId,
    isolated: false,
    versionMeta: { id: versionId, inheritsFrom: '1.20.1' },
  });
  ok(res.ok, 'checkUpdates 返回 ok');
  const rows = res.results || [];
  ok(rows.length === 5, '参与检测的模组数为 5（实际 ' + rows.length + '）');
  const by = (n) => rows.find((r) => r.name.indexOf(n) === 0);

  const sodium = by('sodium');
  ok(sodium && sodium.status === 'update', 'sodium 判定为可更新');
  ok(sodium && sodium.latestVersion === '0.5.8', 'sodium 取到本 mc 版本下的最新 0.5.8（不是 1.19.4 的 0.5.9）');
  ok(sodium && sodium.latestVersionId === 'new', 'sodium 最新版 id 正确');

  const jei = by('jei');
  ok(jei && jei.status === 'update', 'jei 判定为可更新');
  ok(jei && jei.loaderMismatch === true, 'jei 在 fabric 实例下被标记加载器不符');

  const mystery = by('mystery');
  ok(mystery && mystery.status === 'unknown', '无来源 mod 判定为无法检测');

  const iris = by('iris');
  ok(iris && iris.status === 'latest', '仅靠 sidecar 也能识别，且已最新判定正确');

  const lite = by('litematica');
  ok(lite && lite.status === 'latest', 'jar 里无来源信息、但 hash 命中最新版的 mod 判定为已最新');
  ok(lite && lite.exact === true, 'hash 命中时用 version id 精确比较（版本号字符串不同也不会误报更新）');

  console.log('sidecar 读写');
  modupdate.recordMod(modsDir, 'sodium', { projectId: 'AANobbMI', slug: 'AANobbMI', versionNumber: '0.5.8' });
  const sc = modupdate.readSidecar(modsDir);
  ok(sc.sodium && sc.sodium.versionNumber === '0.5.8', 'recordMod 写入 sidecar 成功');
  modupdate.removeMod(modsDir, 'sodium');
  ok(!modupdate.readSidecar(modsDir).sodium, 'removeMod 删除 sidecar 记录成功');

  console.log('空目录 / 无模组场景');
  const empty = await modupdate.checkUpdates({
    gameDir: path.join(tmp, 'empty'),
    versionId: '1.20.1',
    isolated: false,
    versionMeta: { id: '1.20.1' },
  });
  ok(empty.ok && (empty.results || []).length === 0, '没有模组的实例返回空结果，不报错');

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (fail) process.exit(1);
})();
