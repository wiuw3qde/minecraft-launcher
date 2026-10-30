'use strict';
/* 地图本地安装：把 Planet Minecraft 下载的 zip 解压到 saves/ 下，自动识别含 level.dat 的世界文件夹。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractAll } = require('./zip');

function installWorldZip(zipFilePath, savesDir) {
  if (!zipFilePath || !fs.existsSync(zipFilePath)) return { ok: false, error: '未找到 zip 文件' };
  fs.mkdirSync(savesDir, { recursive: true });
  const tmp = path.join(os.tmpdir(), 'mc-launcher-map-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  fs.mkdirSync(tmp, { recursive: true });
  try {
    extractAll(zipFilePath, tmp);
    let worldFolder = null;
    const tops = fs.readdirSync(tmp).filter((n) => {
      try { return fs.statSync(path.join(tmp, n)).isDirectory(); } catch (e) { return false; }
    });
    for (const f of tops) {
      if (fs.existsSync(path.join(tmp, f, 'level.dat'))) { worldFolder = f; break; }
    }
    // 顶层无文件夹、level.dat 直接在根：用一个世界名包裹
    if (!worldFolder && fs.existsSync(path.join(tmp, 'level.dat'))) {
      worldFolder = path.basename(zipFilePath, '.zip') || 'world';
      fs.mkdirSync(path.join(tmp, worldFolder), { recursive: true });
      for (const n of fs.readdirSync(tmp)) {
        if (n === worldFolder) continue;
        fs.renameSync(path.join(tmp, n), path.join(tmp, worldFolder, n));
      }
    }
    if (!worldFolder) return { ok: false, error: '该 zip 不是有效的地图存档（未找到 level.dat）' };
    const dest = path.join(savesDir, worldFolder);
    if (fs.existsSync(dest)) return { ok: false, error: '已存在同名世界：' + worldFolder };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(path.join(tmp, worldFolder), dest);
    return { ok: true, installed: worldFolder, dest };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

module.exports = { installWorldZip };
