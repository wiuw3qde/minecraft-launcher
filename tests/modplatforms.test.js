'use strict';
/* Modrinth 平台模块 —— 不联网单元测试（验证字段映射、版本筛选、跳过逻辑） */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const MP = require('../src/modplatforms');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + ' :: ' + e.message);
  }
}
function sha1OfBuf(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

async function main() {
  console.log('Modrinth 平台模块测试\n');

  await check('normalizeHit 正确映射搜索结果字段', () => {
    const h = {
      project_id: 'abc',
      slug: 'abc-mod',
      title: 'ABC Mod',
      description: '  a   b  ',
      icon_url: 'http://x/i.png',
      author: 'someone',
      downloads: 12345,
      categories: ['fabric'],
      versions: ['1.20.1'],
      date_modified: '2024-01-01',
      license: { name: 'MIT' },
      project_type: 'mod',
    };
    const n = MP.normalizeHit(h);
    assert.strictEqual(n.id, 'abc');
    assert.strictEqual(n.slug, 'abc-mod');
    assert.strictEqual(n.title, 'ABC Mod');
    assert.strictEqual(n.iconUrl, 'http://x/i.png');
    assert.strictEqual(n.author, 'someone');
    assert.strictEqual(n.downloads, 12345);
    assert.deepStrictEqual(n.categories, ['fabric']);
    assert.deepStrictEqual(n.gameVersions, ['1.20.1']);
    assert.strictEqual(n.license, 'MIT');
    assert.strictEqual(n.description, 'a b');
  });

  await check('pickBestVersion：按 loader + gameVersion 筛选并取最新', () => {
    const versions = [
      { id: 'v1', version_number: '1', loaders: ['forge'], game_versions: ['1.20.1'], date_published: '2023-01-01', files: [{ primary: true, filename: 'a.jar' }] },
      { id: 'v2', version_number: '2', loaders: ['fabric'], game_versions: ['1.20.1'], date_published: '2024-01-01', files: [{ primary: true, filename: 'b.jar' }] },
      { id: 'v3', version_number: '3', loaders: ['fabric'], game_versions: ['1.19.2'], date_published: '2024-06-01', files: [{ primary: true, filename: 'c.jar' }] },
    ];
    assert.strictEqual(MP.pickBestVersion(versions, { loader: 'fabric', gameVersion: '1.20.1' }).id, 'v2');
    assert.strictEqual(MP.pickBestVersion(versions, { loader: 'fabric' }).id, 'v3'); // 最新 fabric
    assert.strictEqual(MP.pickBestVersion(versions, { loader: 'quilt' }).id, 'v3'); // 无匹配回退全部，仍取最新
  });

  await check('pickBestVersion：空数组返回 null', () => {
    assert.strictEqual(MP.pickBestVersion([], {}), null);
  });

  await check('downloadFileWithProgress：已存在且校验通过时跳过（不联网）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));
    const buf = Buffer.from('hello-modrinth');
    const file = path.join(dir, 'x.jar');
    fs.writeFileSync(file, buf);
    const res = await MP.downloadFileWithProgress(
      { url: 'http://127.0.0.1:9/nope', filename: 'x.jar', size: buf.length, sha1: sha1OfBuf(buf) },
      dir,
      {}
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'hello-modrinth'); // 未被改写
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
}

main();
