'use strict';
/* 无 Java 时自动下载合适版本（#2）。
 * 数据源：Adoptium（Temurin，GPL+CE 可自由再分发）。
 * 通过官方 API 取「latest 二进制」直链（302 跳转到 GitHub Release 资源），
 * 跟随重定向下载，解压到启动器自管 runtime 目录，定位各平台的 java 可执行文件。
 * 2026-11-13：OS 段不再写死 windows，macOS 取 mac/x64，Linux 取 linux/x64。 */
const fs = require('fs');
const path = require('path');
const { extractAll } = require('./zip');
const downloader = require('./downloader');
const platform = require('./platform');

/** 构造 Adoptium 直链（返回 302，由 downloader 跟随） */
function buildUrl(major, plat) {
  return platform.adoptiumUrl(major, undefined, plat);
}

/** 在解压目录里递归找平台的 java 可执行文件 */
function findJavaExe(dir, plat) {
  const names = platform.javaFileNames(plat);
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let items;
    try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const it of items) {
      const full = path.join(cur, it.name);
      if (it.isDirectory()) stack.push(full);
      else if (names.indexOf(it.name.toLowerCase()) >= 0) return full;
    }
  }
  return null;
}

/**
 * 下载并安装某大版本 JDK 到 destParent/jdk-<major>/
 * @returns { ok, javaPath, dir, error, cancelled }
 */
async function installJava(major, destParent, hooks) {
  hooks = hooks || {};
  const apiUrl = buildUrl(major);
  const zipPath = path.join(destParent, 'jdk-' + major + '.downloading.zip');
  const finalDir = path.join(destParent, 'jdk-' + major);

  if (hooks.onLog) hooks.onLog('正在从 Adoptium 获取 Java ' + major + '…');
  try {
    await downloader.downloadFile([apiUrl], zipPath, {
      size: 0,
      sha1: null,
      onChunk: () => {
        if (hooks.onProgress) hooks.onProgress({ percent: 60 });
      },
    });
  } catch (e) {
    try { fs.rmSync(zipPath, { force: true }); } catch (x) { /* ignore */ }
    return { ok: false, error: '下载失败：' + e.message };
  }

  if (hooks.shouldCancel && hooks.shouldCancel()) {
    try { fs.rmSync(zipPath, { force: true }); } catch (x) { /* ignore */ }
    return { ok: false, cancelled: true, error: '已取消' };
  }

  try {
    if (hooks.onLog) hooks.onLog('正在解压 Java 运行时…');
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.mkdirSync(finalDir, { recursive: true });
    extractAll(zipPath, finalDir);
    if (hooks.onProgress) hooks.onProgress({ percent: 100 });
  } catch (e) {
    try { fs.rmSync(zipPath, { force: true }); } catch (x) { /* ignore */ }
    return { ok: false, error: '解压失败：' + e.message };
  }
  try { fs.rmSync(zipPath, { force: true }); } catch (e) { /* ignore */ }

  const javaPath = findJavaExe(finalDir);
  if (!javaPath) {
    return { ok: false, error: '解压后未找到 ' + platform.javaFileNames().join(' / ') };
  }
  // 双保险：某些 zip 不带 Unix external attributes，zip.js 无法自动恢复 +x。
  if (!platform.IS_WIN) {
    try { fs.chmodSync(javaPath, 0o755); } catch (e) { /* ignore */ }
  }
  if (hooks.onLog) hooks.onLog('Java ' + major + ' 已安装：' + javaPath);
  return { ok: true, javaPath, dir: finalDir };
}

module.exports = { installJava, buildUrl, findJavaExe };
