'use strict';
/* S0 共用底座：日志事件规则库测试（含隐私边界与「不猜测」约束） */
const assert = require('assert');
const er = require('../src/eventrules');

/* 1. 典型一局：进世界 → 加入 → 维度 → 进度 → 死亡 → 离开 → 退出 */
{
  const log = [
    '[08:00:00] [main/INFO]: Loading 42 mods',
    '[08:00:05] [main/INFO]: Starting integrated minecraft server version 1.20.1',
    '[08:00:06] [Server thread/INFO]: Preparing level "生存世界"',
    '[08:00:10] [Server thread/INFO]: Steve joined the game',
    '[08:05:00] [Server thread/INFO]: Steve has made the advancement [Stone Age]',
    '[08:10:00] [Server thread/INFO]: Steve moved to dimension minecraft:the_nether',
    '[08:20:00] [Server thread/INFO]: Steve was slain by Zombie',
    '[08:30:00] [Server thread/INFO]: Steve left the game',
    '[08:31:00] [Server thread/INFO]: Stopping server',
  ].join('\n');
  const r = er.parseLog(log);
  assert.strictEqual(r.ok, true);
  const s = r.stats;
  assert.strictEqual(s.worldOpens, 2, 'Starting integrated server + Preparing level 都算进世界');
  assert.strictEqual(s.joins, 1);
  assert.strictEqual(s.leaves, 1);
  assert.strictEqual(s.advancements, 1);
  assert.strictEqual(s.deaths, 1);
  assert.strictEqual(s.worldCloses, 1);
  assert.deepStrictEqual(s.dimensions, ['minecraft:the_nether']);
  assert.strictEqual(s.startTime, '08:00:00');
  assert.strictEqual(s.endTime, '08:31:00');
  assert.strictEqual(s.durationSeconds, 31 * 60);
  const advancement = r.events.find((e) => e.type === 'advancement');
  assert.ok(/达成进度/.test(advancement.text) && /Stone Age/.test(advancement.text));
  const death = r.events.find((e) => e.type === 'death');
  assert.ok(death.text.indexOf('Steve') === 0);
  assert.strictEqual(death.actor, 'Steve');
  const mods = r.events.find((e) => e.id === 'mods-loaded');
  assert.strictEqual(mods.modCount, 42);
}

/* 2. 崩溃 / OOM */
{
  const r = er.parseLog([
    '[10:00:00] [main/ERROR]: ---- Minecraft Crash Report ----',
    '[10:00:01] [main/ERROR]: java.lang.OutOfMemoryError: Java heap space',
  ].join('\n'));
  assert.strictEqual(r.stats.crashes, 2);
  assert.ok(r.events.some((e) => /游戏崩溃/.test(e.text)));
  assert.ok(r.events.some((e) => /内存不足/.test(e.text)));
}

/* 3. 不认识的行只计数，绝不编造事件；聊天内容不采集 */
{
  const r = er.parseLog([
    '[12:00:00] [main/INFO]: some unknown internal chatter',
    '[12:00:01] [Client thread/INFO]: [CHAT] <Steve> 我的账号密码是 secret123',
    '[12:00:02] [main/INFO]: another opaque line',
  ].join('\n'));
  assert.strictEqual(r.events.length, 0);
  assert.strictEqual(r.stats.unknown, 3);
  assert.strictEqual(r.unknownSample.length, 3);
  const all = JSON.stringify(r.events) + JSON.stringify(r.unknownSample);
  assert.ok(!/secret123/.test(all), '聊天原文既不能进事件，也不能进未识别行样例');
  assert.ok(r.unknownSample.includes('[已省略：聊天内容]'));
  assert.ok(r.unknownSample.some((l) => /unknown internal chatter/.test(l)), '非聊天行仍保留样例便于扩充规则');
}

/* 4. 跨午夜时长估算 */
{
  const r = er.parseLog([
    '[23:59:00] [Server thread/INFO]: Steve joined the game',
    '[00:01:00] [Server thread/INFO]: Steve left the game',
  ].join('\n'));
  assert.strictEqual(r.stats.durationSeconds, 120);
  assert.strictEqual(r.stats.durationEstimated, true);
}

/* 5. 空 / 非字符串输入不抛异常 */
{
  assert.strictEqual(er.parseLog('').events.length, 0);
  assert.strictEqual(er.parseLog(null).stats.lines, 1);
  assert.strictEqual(er.parseLog(undefined).ok, true);
}

/* 6. parseClock */
{
  assert.strictEqual(er.parseClock('12:34:56').text, '12:34:56');
  assert.strictEqual(er.parseClock('2026-11-08 12:34:56').seconds, 45296);
  assert.strictEqual(er.parseClock('没有时间'), null);
  assert.strictEqual(er.parseClock('99:00:00'), null);
}

/* 7. 行数上限（防超大日志打爆内存） */
{
  const big = new Array(1000).fill('[01:00:00] [main/INFO]: noise').join('\n');
  assert.strictEqual(er.parseLog(big, { maxLines: 10 }).stats.lines, 10);
}

console.log('eventrules.test.js 全部通过 ✓');
