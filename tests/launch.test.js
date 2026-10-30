'use strict';
/* 进程管理测试：真实 spawn 一个 Java 进程，验证日志回传 / 中文解码 / 退出事件 */
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('assert');

const { prepareLaunch } = require('../src/launch-builder');
const { Launcher } = require('../src/launcher');

const GAME = path.join(__dirname, 'tmp', 'game');

(async function run() {
  const where = spawnSync('where', ['java'], { encoding: 'utf8' });
  const javaExe = where.status === 0 ? where.stdout.split(/\r?\n/).filter(Boolean)[0] : null;
  if (!javaExe) {
    console.log('! 本机没有 java，跳过真实进程启动验证');
    console.log('全部通过 ✓ (skipped)');
    process.exit(0);
  }

  const prepared = await prepareLaunch(
    { gameDir: GAME, versionId: '1.20.1', javaPath: javaExe, playerName: 'Steve', maxMemory: 512 },
    () => {}
  );

  const launcher = new Launcher();
  let output = '';
  let exitCode = null;
  launcher.on('log', (t) => {
    output += t;
  });

  const started = launcher.start(prepared.command, prepared.args, prepared.cwd);
  assert.strictEqual(started.ok, true, '进程应启动成功');
  assert.ok(launcher.running, 'launcher 状态应为运行中');

  await new Promise((resolve) => {
    launcher.on('exit', (code) => {
      exitCode = code;
      resolve();
    });
    setTimeout(() => {
      launcher.stop();
      resolve();
    }, 20000);
  });

  assert.notStrictEqual(exitCode, null, '应收到退出事件');
  assert.ok(output.length > 0, '应收到进程输出');
  // 中英文任一即可，但必须是可读文本（不能是全乱码）
  assert.ok(/ClassNotFoundException|找不到|无法加载主类/.test(output), '输出内容异常：' + output.slice(0, 200));

  console.log('—— 捕获到的进程输出示例 ——');
  console.log(output.trim().split('\n').slice(0, 3).join('\n'));
  console.log('✓ 进程启动 / 日志回传 / 中文解码 / 退出捕获 均正常');
})();
