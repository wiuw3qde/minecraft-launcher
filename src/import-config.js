'use strict';
/* 导入外部启动器配置（PCL2 / HMCL）基础版。
 * 思路：通用别名解析，兼容 JSON（HMCL accounts.json / PCL2 配置）与 INI/key=value（HMCL hmclversion.cfg）。
 * 不迁移正版 token（无法导出），只迁移可复用的离线账号名 / Java 路径 / 内存 / 游戏版本。 */
const fs = require('fs');
const path = require('path');
const scanner = require('./scanner');

// 规范字段 -> 别名（中英文 / 多种命名）
const FIELD_ALIASES = {
  playerName: [
    'username', 'name', 'playername', 'player', 'player_name', '玩家名', '用户名',
    'offlineusername', 'account', 'setupusername', 'lastusername', 'gamename', 'accountname',
  ],
  version: [
    'version', 'gameversion', 'mcversion', '游戏版本', 'mc版本', 'lastlaunchversion',
    'lastversion', 'defaultversion', 'selectedversion', 'startversion', 'launchversion',
  ],
  javaPath: [
    'java', 'javapath', 'javadir', 'javahome', 'java_path', 'java路径', 'javaexec',
    'javaexe', 'javapath', 'javadir', 'javabinary', 'java_location', 'path', 'jdk',
  ],
  maxMemory: [
    'memory', 'maxmemory', 'maxmem', 'ram', '内存', 'xmx', 'maxheap', 'memorymb', 'jvmram',
  ],
};

function normKey(k) {
  return String(k == null ? '' : k).trim().toLowerCase().replace(/[\s_\-]/g, '');
}

/** 把嵌套 JSON 拍平为 "a.b[0].c" -> value，便于别名匹配 */
function flattenJson(obj, prefix, out) {
  out = out || {};
  for (const k of Object.keys(obj)) {
    const nk = prefix ? prefix + '.' + k : k;
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenJson(v, nk, out);
    } else if (Array.isArray(v)) {
      v.forEach((it, i) => {
        if (it && typeof it === 'object') flattenJson(it, nk + '[' + i + ']', out);
        else out[nk + '[' + i + ']'] = it;
      });
    } else {
      out[nk] = v;
    }
  }
  return out;
}

/** 逐行解析 INI / key=value / 带冒号的配置 */
function parseIniLike(text) {
  const out = {};
  text.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';') || t.startsWith('//')) return;
    const m = t.match(/^([^=:]+)[=:](.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  });
  return out;
}

function extractFields(raw) {
  const map = {};
  for (const k of Object.keys(raw)) {
    if (/^accounts\[/.test(k)) continue; // 账号数组单独处理，避免 username 被当成玩家名覆盖
    const nk = normKey(k);
    const lastSeg = normKey(String(k).split('.').pop()); // 兼容嵌套 JSON（如 Game.Version）
    for (const std of Object.keys(FIELD_ALIASES)) {
      if (FIELD_ALIASES[std].some((a) => normKey(a) === nk || normKey(a) === lastSeg)) {
        let v = raw[k];
        if (v && typeof v === 'object') v = JSON.stringify(v);
        map[std] = String(v).trim();
      }
    }
  }
  return map;
}

/** HMCL accounts.json：提取离线 / 正版账号名 */
function extractAccounts(jsonObj) {
  const list = [];
  try {
    const arr = jsonObj.accounts || (Array.isArray(jsonObj) ? jsonObj : null);
    if (arr && Array.isArray(arr)) {
      arr.forEach((a) => {
        if (a && a.username) {
          const type = a.authType === 'microsoft' ? 'msa' : 'offline';
          list.push({ name: String(a.username), type });
        }
      });
    }
  } catch (e) {
    /* ignore */
  }
  return list;
}

/**
 * 解析一份外部配置文件。
 * @returns {{ok:boolean, type?:string, fields?:object, accounts?:Array, warnings?:Array, error?:string}}
 */
function parseExternalConfig(filePath) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, error: '无法读取文件：' + e.message };
  }
  const warnings = [];
  const base = path.basename(filePath).toLowerCase();
  let raw = {};
  let type = 'ini';
  let accounts = [];
  try {
    const j = JSON.parse(text);
    type = base === 'accounts.json' || j.accounts ? 'hmcl-accounts' : 'json';
    raw = flattenJson(j, '', {});
    accounts = extractAccounts(j);
  } catch (e) {
    raw = parseIniLike(text);
    type = base.endsWith('.cfg') || base.endsWith('.ini') || base.endsWith('.txt') ? 'ini' : 'text';
  }

  const fields = extractFields(raw);

  if (fields.maxMemory) {
    const m = fields.maxMemory.match(/\d+/);
    fields.maxMemory = m ? parseInt(m[0], 10) : null;
    if (!fields.maxMemory) warnings.push('内存字段无法识别为数字，已忽略');
  }
  if (fields.javaPath) {
    fields.javaPath = fields.javaPath.replace(/^["']|["']$/g, '').trim();
    if (fields.javaPath && !/(\.exe)$/i.test(fields.javaPath) && !fields.javaPath.includes('javaw') && !fields.javaPath.includes('java')) {
      // 可能指向 java 目录，尝试补 javaw.exe / bin/java
      const cand = [
        path.join(fields.javaPath, 'bin', 'javaw.exe'),
        path.join(fields.javaPath, 'bin', 'java.exe'),
        path.join(fields.javaPath, 'javaw.exe'),
      ];
      const hit = cand.find((c) => fs.existsSync(c));
      if (hit) fields.javaPath = hit;
    }
  }
  if (!fields.playerName && accounts.length) {
    const off = accounts.find((a) => a.type === 'offline');
    fields.playerName = (off || accounts[0]).name;
  }
  const hasMsa = accounts.some((a) => a.type === 'msa');
  if (hasMsa) warnings.push('检测到正版（Microsoft）账号，token 无法迁移，请在本启动器重新登录');

  return { ok: true, type, fields, accounts, warnings };
}

/** 扫描本机常见位置的外部配置（HMCL / PCL2） */
function scanExternalConfigs() {
  const found = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const appdata = process.env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : '');

  const mcRoots = [];
  if (appdata) mcRoots.push(path.join(appdata, '.minecraft'));
  if (home) mcRoots.push(path.join(home, '.minecraft'));

  const configFiles = [];
  mcRoots.forEach((mc) => {
    if (!fs.existsSync(mc)) return;
    configFiles.push({ path: path.join(mc, 'hmclversion.cfg'), kind: 'HMCL 版本配置' });
    configFiles.push({ path: path.join(mc, 'accounts.json'), kind: 'HMCL 账号' });
    // PCL2 常见位置：.minecraft/PCL/Setting/*.json 或 .minecraft/PCL/*.json
    const pclDirs = [path.join(mc, 'PCL'), path.join(mc, 'PCL', 'Setting'), path.join(mc, 'PCL', 'setting')];
    pclDirs.forEach((pd) => {
      if (!fs.existsSync(pd)) return;
      try {
        fs.readdirSync(pd).forEach((f) => {
          if (/\.(json|ini|cfg|txt|conf)$/i.test(f)) {
            configFiles.push({ path: path.join(pd, f), kind: 'PCL2 配置（' + path.basename(pd) + '）' });
          }
        });
      } catch (e) {
        /* ignore */
      }
    });
  });

  // 也扫描 HMCL 独立目录（%APPDATA%/HMCL）
  if (appdata) {
    const hmclDir = path.join(appdata, 'HMCL');
    if (fs.existsSync(hmclDir)) {
      try {
        fs.readdirSync(hmclDir).forEach((f) => {
          if (/\.(json|cfg)$/i.test(f)) configFiles.push({ path: path.join(hmclDir, f), kind: 'HMCL 配置' });
        });
      } catch (e) {
        /* ignore */
      }
    }
  }

  configFiles.forEach((f) => {
    if (fs.existsSync(f.path)) {
      let size = 0;
      try {
        size = fs.statSync(f.path).size;
      } catch (e) {
        /* ignore */
      }
      found.push({ path: f.path, kind: f.kind, size });
    }
  });
  return found;
}

module.exports = { parseExternalConfig, scanExternalConfigs, FIELD_ALIASES };
