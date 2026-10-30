'use strict';
const fs = require('fs');

/** 读取 JSON，失败返回 null（版本 json 可能缺失或格式异常） */
function readJsonFile(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

/** Rule 里的 os.name 用的是 windows/osx/linux */
function currentOsName() {
  const p = process.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'osx';
  return 'linux';
}

/** group:name:version[:classifier] -> maven 相对路径 */
function mavenPathFromName(name) {
  const parts = String(name).split(':');
  const [g, a, v, c] = parts;
  const file = `${a}-${v}${c ? '-' + c : ''}.jar`;
  return `${g.replace(/\./g, '/')}/${a}/${v}/${file}`;
}

function unique(arr) {
  return Array.from(new Set(arr));
}

module.exports = { readJsonFile, currentOsName, mavenPathFromName, unique };
