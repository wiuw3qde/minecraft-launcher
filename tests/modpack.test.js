'use strict';
/* 整合包导入/导出（#4/#5）纯 Node 测试：用 zipwrite 造 zip，再测 detect/import/export 往返。
 * 不联网（mrpack 的远程 mod 下载不在此覆盖）。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const modpack = require('../src/modpack');
const { writeZipFiles } = require('../src/zipwrite');
const { extractAll, listEntries, readText } = require('../src/zip');

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-modpack-'), { encoding: 'utf8' }); }

// 用稳定内容生成临时文件（abs 路径需真实存在，writeZipFiles 会读）
const _cache = new Map();
function fake(rel, content) {
  if (_cache.has(rel)) return _cache.get(rel);
  const d = tmpdir();
  const p = path.join(d, rel.replace(/\//g, '_'));
  fs.writeFileSync(p, content || 'data-' + rel);
  _cache.set(rel, p);
  return p;
}

async function buildZip(files) {
  const d = tmpdir();
  const zip = path.join(d, 'pack.zip');
  await writeZipFiles(zip, files);
  return zip;
}

(async function run() {
  console.log('整合包 detect / import / export 测试');

  // 1) 普通 zip 检测
  const plainFiles = [
    { rel: 'mods/a.jar', abs: fake('mods/a.jar') },
    { rel: 'config/mod.json', abs: fake('config/mod.json') },
    { rel: 'options.txt', abs: fake('options.txt') },
  ];
  const plainZip = await buildZip(plainFiles);
  assert((await modpack.detectModpack(plainZip)).format === 'zip', '普通 zip 识别为 zip');

  // 2) mrpack 检测
  const mrFiles = [
    { rel: 'modrinth.index.json', abs: fake('modrinth.index.json', JSON.stringify({ name: 'X', overrides: 'overrides', files: [] })) },
    { rel: 'overrides/config/x.json', abs: fake('overrides/config/x.json') },
  ];
  const mrZip = await buildZip(mrFiles);
  assert((await modpack.detectModpack(mrZip)).format === 'mrpack', 'Modrinth mrpack 识别为 mrpack');

  // 3) HMCL 检测
  const hmFiles = [
    { rel: 'mcbbs.modpackmeta', abs: fake('mcbbs.modpackmeta', '{}') },
    { rel: 'minecraft/mods/a.jar', abs: fake('minecraft/mods/a.jar') },
  ];
  const hmZip = await buildZip(hmFiles);
  assert((await modpack.detectModpack(hmZip)).format === 'hmcl', 'HMCL 整合包识别为 hmcl');

  // 4) 普通 zip 导入（覆盖到 .minecraft）
  const gameDir = tmpdir();
  const imp = await modpack.importModpack(plainZip, gameDir, { target: 'overlay' }, {});
  assert(imp.ok, '普通 zip 导入成功');
  assert(fs.existsSync(path.join(gameDir, 'mods/a.jar')), '导入后 mods/a.jar 存在');
  assert(fs.existsSync(path.join(gameDir, 'options.txt')), '导入后 options.txt 存在');

  // 5) 导出（再打成 zip），应排除 saves/logs 等
  const outDir = tmpdir();
  // 造一个含 saves/logs 的目录，验证导出时被排除
  fs.mkdirSync(path.join(gameDir, 'saves', 'World'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'saves', 'World', 'level.dat'), 'lv');
  fs.mkdirSync(path.join(gameDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'logs', 'latest.log'), 'log');
  const exp = await modpack.exportModpack(outDir, gameDir, 'global', {}, {});
  assert(exp.ok, '导出成功');
  assert(fs.existsSync(exp.outPath), '导出文件存在：' + exp.outPath);
  const names = listEntries(exp.outPath);
  assert(names.includes('mods/a.jar'), '导出 zip 含 mods/a.jar');
  assert(!names.some((n) => n.startsWith('saves/')), '导出排除了 saves/');
  assert(!names.some((n) => n.startsWith('logs/')), '导出排除了 logs/');

  // 6) 导出 zip 可被自带的 zip.js 正确解压（格式合法性交叉验证）
  const reimport = tmpdir();
  extractAll(exp.outPath, reimport);
  assert(fs.existsSync(path.join(reimport, 'mods/a.jar')), '导出 zip 可被 zip.js 解压，mods/a.jar 还原');

  // 7) 公共顶层目录剥离（普通 zip 带一层包装）
  const wrapped = [
    { rel: 'my-modpack/mods/a.jar', abs: fake('my-modpack/mods/a.jar') },
    { rel: 'my-modpack/options.txt', abs: fake('my-modpack/options.txt') },
  ];
  const wZip = await buildZip(wrapped);
  const g2 = tmpdir();
  await modpack.importModpack(wZip, g2, { target: 'overlay' }, {});
  assert(fs.existsSync(path.join(g2, 'mods/a.jar')), '带公共根的 zip 剥离了 my-modpack/ 前缀');
  assert(!fs.existsSync(path.join(g2, 'my-modpack')), '未残留包装目录');

  // 8) HMCL 解压剥离 minecraft/ 前缀
  const g3 = tmpdir();
  await modpack.importModpack(hmZip, g3, { target: 'overlay' }, {});
  assert(fs.existsSync(path.join(g3, 'mods/a.jar')), 'HMCL 整合包剥离 minecraft/ 前缀，mods/a.jar 落到根');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
