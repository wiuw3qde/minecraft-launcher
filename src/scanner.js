'use strict';
const fs = require('fs');
const path = require('path');
const { readJsonFile } = require('./util');

function defaultGameDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, '.minecraft');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'minecraft');
  return path.join(home, '.minecraft');
}

function looksLikeGameDir(dir) {
  try {
    return fs.existsSync(dir) && fs.existsSync(path.join(dir, 'versions'));
  } catch (e) {
    return false;
  }
}

/** 容错处理：用户可能选中 .minecraft 本身、它的父目录，或人为挑错 */
function normalizeGameDir(dir) {
  if (!dir) return null;
  try {
    const st = fs.statSync(dir);
    if (st.isFile()) dir = path.dirname(dir);
  } catch (e) {
    return null;
  }
  if (looksLikeGameDir(dir)) return dir;
  const candidate = path.join(dir, '.minecraft');
  if (looksLikeGameDir(candidate)) return candidate;
  return dir;
}

/**
 * 列出所有可识别的版本
 * @returns {{versions: Array, error: string|null}}
 */
function listVersions(gameDir) {
  if (!gameDir) return { versions: [], error: '未指定游戏目录' };
  if (!fs.existsSync(gameDir)) return { versions: [], error: '目录不存在：' + gameDir };
  const versionsRoot = path.join(gameDir, 'versions');
  if (!fs.existsSync(versionsRoot)) {
    return { versions: [], error: '该目录下没有 versions 文件夹，请选择 .minecraft 目录或其上级' };
  }

  let dirs = [];
  try {
    dirs = fs.readdirSync(versionsRoot).filter((d) => {
      try {
        return fs.statSync(path.join(versionsRoot, d)).isDirectory();
      } catch (e) {
        return false;
      }
    });
  } catch (e) {
    return { versions: [], error: '无法读取 versions 目录：' + e.message };
  }

  const versions = [];
  for (const d of dirs) {
    const vdir = path.join(versionsRoot, d);
    const jsonPath = path.join(vdir, d + '.json');
    const json = readJsonFile(jsonPath);
    if (!json || !json.id) continue;
    const id = json.id;
    const jarPath = path.join(vdir, id + '.jar');
    const hasJar = fs.existsSync(jarPath);
    versions.push({
      id,
      dirName: d,
      versionDir: vdir,
      jsonPath,
      jarPath,
      hasJar,
      type: json.type || 'release',
      releaseTime: json.releaseTime || '',
      assetIndex: (json.assetIndex && json.assetIndex.id) || '',
      inheritsFrom: json.inheritsFrom || '',
      mainClass: json.mainClass || '',
      javaMajorVersion: (json.javaVersion && json.javaVersion.majorVersion) || null,
    });
  }

  versions.sort((a, b) => {
    if (a.releaseTime && b.releaseTime && a.releaseTime !== b.releaseTime) {
      return b.releaseTime.localeCompare(a.releaseTime);
    }
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });

  return {
    versions,
    error: versions.length ? null : 'versions 目录里没有找到任何版本（每个版本需要 文件夹名/文件夹名.json）',
  };
}

module.exports = { defaultGameDir, normalizeGameDir, looksLikeGameDir, listVersions };
