'use strict';
/* S2 / N1：冒险日记（日志尾部解析、按局切分、隐私边界、版本日志优先级） */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const timeline = require('../src/timeline');

const ROOT = path.join(__dirname, 'tmp', 'timeline');
const GAME = path.join(ROOT, '.minecraft');
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
rmrf(ROOT);
fs.mkdirSync(path.join(GAME, 'logs'), { recursive: true });

const LOG = [
  '[12:00:01] [Render thread/INFO]: Preparing level "生存世界"',
  '[12:00:05] [Render thread/INFO]: Loading 42 mods',
  '[12:01:10] [Server thread/INFO]: Player joined the game',
  '[12:02:00] [Server thread/INFO]: Player has made the advancement [Stone Age]',
  '[12:02:30] [Render thread/INFO]: [CHAT] <Player> secret123456',
  '[12:03:00] [Server thread/INFO]: Player was slain by Zombie',
  '[12:04:00] [Server thread/INFO]: Player moved to dimension minecraft:the_nether',
  '[12:05:00] [Server thread/INFO]: Stopping server',
].join('\n') + '\n';
fs.writeFileSync(path.join(GAME, 'logs', 'latest.log'), LOG);

/* ---------- 1. 正常解析：事件、统计、分局 ---------- */
{
  const r = timeline.readTimeline({ gameDir: GAME, versionId: '1.20.1', isolated: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empty, false);
  assert.ok(r.events.length >= 6);
  assert.strictEqual(r.stats.worldOpens, 1);
  assert.strictEqual(r.stats.worldCloses, 1);
  assert.strictEqual(r.stats.deaths, 1);
  assert.strictEqual(r.stats.advancements, 1);
  assert.strictEqual(r.stats.crashes, 0);
  assert.strictEqual(r.stats.joins, 1);
  assert.ok(r.stats.dimensions.includes('minecraft:the_nether'));
  assert.ok(r.stats.durationSeconds > 0, '应能从首尾时间戳算出时长');
  assert.strictEqual(r.sessions.length, 1, '一次进入 + 一次退出应切成一局');
  assert.ok(/生存世界/.test(r.sessions[0].world));
  assert.strictEqual(r.sessions[0].startTime, '12:00:01');
  assert.strictEqual(r.sessions[0].endTime, '12:05:00');
  assert.ok(r.source.path.endsWith(path.join('logs', 'latest.log')));
}

/* ---------- 2. 隐私：不返回日志原文 / 未识别行样例 / 聊天内容 ---------- */
{
  const r = timeline.readTimeline({ gameDir: GAME, versionId: '1.20.1' });
  const all = JSON.stringify(r);
  assert.ok(!/secret123456/.test(all), '聊天隐私绝不能出现在返回结果里');
  assert.ok(!/Render thread/.test(all), '不得返回日志原文');
  assert.ok(!Object.prototype.hasOwnProperty.call(r, 'unknownSample'), '不得暴露未识别行样例');
  assert.strictEqual(typeof r.stats.unknown, 'number', '只统计未识别行数');
}

/* ---------- 3. 尾部读取：大日志只解析末尾，不丢事件 ---------- */
{
  const p = path.join(ROOT, 'big.log');
  const tail = '[12:00:01] [Render thread/INFO]: Preparing level "尾部世界"\n';
  fs.writeFileSync(p, '#'.repeat(4000) + '\n' + tail);
  const r = timeline.readTail(p, 1024);
  assert.ok(/尾部世界/.test(r), '尾部事件必须保留');
  assert.ok(!r.startsWith('#'), '被截断的半行应被丢弃');

  const g2 = path.join(ROOT, 'big-game');
  fs.mkdirSync(path.join(g2, 'logs'), { recursive: true });
  fs.copyFileSync(p, path.join(g2, 'logs', 'latest.log'));
  const t = timeline.readTimeline({ gameDir: g2, versionId: '1.20.1', maxBytes: 1024 });
  assert.strictEqual(t.ok, true);
  assert.strictEqual(t.truncated, true);
  assert.ok(t.events.some((e) => /尾部世界/.test(e.text)), '截断后仍能解析到尾部事件');
}

/* ---------- 4. 版本日志优先级：即使共享日志更新，也优先本版本 ---------- */
{
  const g3 = path.join(ROOT, 'multi');
  fs.mkdirSync(path.join(g3, 'versions', '1.20.1', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(g3, 'instances', '1.20.1', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(g3, 'logs'), { recursive: true });
  const a = path.join(g3, 'versions', '1.20.1', 'logs', 'latest.log');
  const b = path.join(g3, 'instances', '1.20.1', 'logs', 'latest.log');
  const shared = path.join(g3, 'logs', 'latest.log');
  fs.writeFileSync(a, '[09:00:00] [x]: Preparing level "版本日志"\n');
  fs.writeFileSync(b, '[10:00:00] [x]: Preparing level "隔离日志"\n');
  fs.writeFileSync(shared, '[11:00:00] [x]: Preparing level "共享日志"\n');
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(shared, future, future); // 共享日志更新，也不能抢走本版本
  const r1 = timeline.readTimeline({ gameDir: g3, versionId: '1.20.1', isolated: false });
  assert.ok(r1.source.path.includes(path.join('versions', '1.20.1')), '应优先版本目录日志');
  const r2 = timeline.readTimeline({ gameDir: g3, versionId: '1.20.1', isolated: true });
  assert.ok(r2.source.path.includes(path.join('instances', '1.20.1')), '隔离时优先实例目录日志');
  assert.strictEqual(r2.sources.length, 3);
  assert.strictEqual(new Set(r2.sources.map((s) => path.resolve(s.path))).size, 3, '候选不得重复');
}

/* ---------- 5. 无日志 / 缺参数：安全降级，不抛异常 ---------- */
{
  const empty = timeline.readTimeline({ gameDir: path.join(ROOT, '不存在'), versionId: 'x' });
  assert.strictEqual(empty.ok, true);
  assert.strictEqual(empty.empty, true);
  assert.deepStrictEqual(empty.events, []);
  assert.ok(/没有找到日志文件/.test(empty.message));
  const none = timeline.readTimeline({ gameDir: '' });
  assert.strictEqual(none.empty, true);
  assert.strictEqual(timeline.candidateLogs('', 'x', false).length, 0);
  assert.deepStrictEqual(timeline.sessions([]), []);
}

rmrf(ROOT);
console.log('timeline.test.js 全部通过 \u2713');
