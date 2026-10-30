'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { execFile } = require('child_process');

/** Java 在 Windows 上默认用 GBK 输出，UTF-8 解不出来时回退一下 */
function decode(buf) {
  const utf8 = buf.toString('utf8');
  if (utf8.indexOf('�') === -1) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e) {
    return utf8;
  }
}

class Launcher extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
  }

  get running() {
    return !!(this.proc && this.proc.exitCode === null);
  }

  start(command, args, cwd) {
    if (this.running) return { ok: false, error: '已有 Minecraft 实例正在运行' };
    this.emit('log', `[启动器] 工作目录：${cwd}\n`);
    this.emit('log', `[启动器] 命令：${command}\n`);

    let proc;
    try {
      proc = spawn(command, args, { cwd, windowsHide: true, env: Object.assign({}, process.env) });
    } catch (e) {
      this.emit('log', `[错误] 启动失败：${e.message}\n`);
      return { ok: false, error: e.message };
    }
    this.proc = proc;

    const pump = (data) => this.emit('log', decode(data));
    proc.stdout.on('data', (d) => pump(d));
    proc.stderr.on('data', (d) => pump(d));
    proc.on('error', (e) => this.emit('log', `[错误] 进程异常：${e.message}\n`));
    proc.on('close', (code, signal) => {
      this.emit('log', `\n[启动器] 游戏进程已退出，退出码 ${code}${signal ? ' / 信号 ' + signal : ''}\n`);
      this.emit('exit', code);
      this.proc = null;
    });

    return { ok: true, pid: proc.pid };
  }

  stop() {
    if (!this.proc) return false;
    const pid = this.proc.pid;
    if (process.platform === 'win32') {
      // 连同子进程树一起结束，否则残留的 java 会一直占着内存
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try {
        process.kill(-pid);
      } catch (e) {
        try {
          process.kill(pid);
        } catch (e2) {
          /* ignore */
        }
      }
    }
    this.emit('log', '[启动器] 已请求结束游戏进程\n');
    return true;
  }
}

module.exports = { Launcher };
