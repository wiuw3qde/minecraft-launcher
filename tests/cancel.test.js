'use strict';
/* 下载取消回归测试（不联网）。
 * 背景：downloadFileWithProgress 原先只在开始前检查一次 shouldCancel，
 * 下载流里从不检查 —— 于是「取消」只是设了个没人读的标志，下载照跑到底。
 * 这里用假响应流模拟慢速下载，验证：
 *   1) 开始前取消 -> 立即返回 cancelled
 *   2) 下载中途取消 -> 真正中断，返回 cancelled，且不留下完整文件 / 半成品
 *   3) 不取消时 -> 正常下载完成
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

const modplatforms = require('../src/modplatforms');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

/** 用假响应替换 https.get：按固定节奏吐数据块，可随时被 destroy 掐断 */
function installFakeHttp(totalBytes, chunkBytes, intervalMs) {
  const realGet = https.get;
  const state = { destroyed: false, ended: false };
  https.get = function (url, opts, cb) {
    // req 只需要支持 .on('timeout')/.on('error')/.destroy()
    const req = new EventEmitter();
    req.destroy = function () {
      state.destroyed = true;
    };
    const res = new PassThrough();
    res.statusCode = 200;
    res.headers = { 'content-length': String(totalBytes) };
    process.nextTick(() => {
      cb(res);
      let sent = 0;
      const timer = setInterval(() => {
        if (state.destroyed || res.destroyed) {
          clearInterval(timer);
          return;
        }
        const n = Math.min(chunkBytes, totalBytes - sent);
        if (n <= 0) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          state.ended = true;
          return;
        }
        res.write(Buffer.alloc(n));
        sent += n;
        if (sent >= totalBytes) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          state.ended = true;
        }
      }, intervalMs);
      state.timer = timer;
    });
    return req;
  };
  return {
    state,
    restore: function () {
      if (state.timer) clearInterval(state.timer);
      https.get = realGet;
    },
  };
}

(async function run() {
  console.log('下载取消测试（不联网）');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-cancel-'));
  const TOTAL = 40000;
  const file = { url: 'https://example.invalid/big.bin', filename: 'big.bin', size: TOTAL, sha1: null };

  /* 1) 开始前就取消 */
  {
    const fake = installFakeHttp(TOTAL, 2000, 5);
    const r = await modplatforms.downloadFileWithProgress(file, dir, {
      shouldCancel: () => true,
      onProgress: () => {},
    });
    const res = r;
    fake.restore();
    fs.rmSync(path.join(dir, 'big.bin'), { force: true });
    check('开始前取消：返回 cancelled=true', () => {
      assert.strictEqual(res.cancelled, true);
      assert.strictEqual(res.ok, false);
    });
  }

  /* 2) 下载中途取消 */
  {
    const sub = path.join(dir, 'mid');
    fs.mkdirSync(sub, { recursive: true });
    const fake = installFakeHttp(TOTAL, 2000, 4);
    let cancel = false;
    let progressCount = 0;
    const p = modplatforms.downloadFileWithProgress(file, sub, {
      shouldCancel: () => cancel,
      onProgress: () => {
        progressCount++;
      },
    });
    // 等确实收到过至少一个进度回调再取消。
    // 原先固定 sleep 30ms，事件循环被前面的网络测试占满时可能一块都来不及发，
    // 导致 progressCount=0 的偶发失败（且会掐断整条 npm test && 链）。
    const deadline = Date.now() + 3000;
    while (progressCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    cancel = true;
    const res = await p;
    const destroyed = fake.state.destroyed;
    fake.restore();

    check('中途取消：返回 cancelled=true', () => {
      assert.strictEqual(res.cancelled, true, JSON.stringify(res));
      assert.strictEqual(res.ok, false);
    });
    check('中途取消：确实收到过进度（说明是真在下载中被掐断）', () => {
      assert.ok(progressCount > 0, 'progressCount=' + progressCount);
    });
    check('中途取消：不会产出完整文件', () => {
      const dest = path.join(sub, 'big.bin');
      // 允许残留正在写的 .download 半成品，但绝不能有已完成的 big.bin
      assert.strictEqual(fs.existsSync(dest), false, 'big.bin 不应存在');
    });
    // 清理可能的半成品
    fs.rmSync(path.join(sub, 'big.bin.download'), { force: true });
  }

  /* 3) 不取消：正常完成 */
  {
    const sub = path.join(dir, 'ok');
    fs.mkdirSync(sub, { recursive: true });
    const fake = installFakeHttp(TOTAL, 8000, 2);
    const res = await modplatforms.downloadFileWithProgress(file, sub, {
      shouldCancel: () => false,
      onProgress: () => {},
    });
    fake.restore();
    check('不取消：正常下载完成', () => {
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      assert.strictEqual(res.cancelled, undefined, '不应标记 cancelled');
    });
    check('不取消：文件已生成且大小正确', () => {
      const dest = path.join(sub, 'big.bin');
      assert.ok(fs.existsSync(dest), 'big.bin 应存在');
      assert.strictEqual(fs.statSync(dest).size, TOTAL);
    });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
