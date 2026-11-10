'use strict';
/**
 * N1 冒险日记（ROADMAP 第六章 S2）：把 latest.log 转成可回顾的时间线。
 *
 * 硬边界：
 *   - 纯本地、只读、不联网、不写文件；
 *   - 只返回结构化事件与统计，**不返回日志原文 / 未识别行样例**（聊天内容等隐私一律不外泄）；
 *   - 只读日志文件尾部（默认 2MB），避免大日志打爆内存；
 *   - 任何 IO / 解析异常都降级为 {ok:false}，绝不向调用方抛异常。
 */
const fs = require('fs');
const path = require('path');
const rules = require('./eventrules');

const MAX_BYTES = 2 * 1024 * 1024;

function candidateLogs(gameDir, versionId, isolated) {
  const seen = Object.create(null);
  const out = [];
  const push = (p) => {
    const key = path.resolve(p);
    if (seen[key]) return;
    seen[key] = true;
    try {
      const st = fs.statSync(p);
      if (st.isFile()) out.push({ path: p, mtime: st.mtimeMs, size: st.size });
    } catch (e) { /* ignore */ }
  };
  if (!gameDir) return out;
  if (versionId) {
    if (isolated) push(path.join(gameDir, 'instances', versionId, 'logs', 'latest.log'));
    else push(path.join(gameDir, 'versions', versionId, 'logs', 'latest.log'));
  }
  push(path.join(gameDir, 'logs', 'latest.log'));
  // 兜底：该目录下其它版本 / 实例的日志（不递归，只扫一层）
  ['versions', 'instances'].forEach((sub) => {
    try {
      fs.readdirSync(path.join(gameDir, sub), { withFileTypes: true }).forEach((e) => {
        if (e.isDirectory()) push(path.join(gameDir, sub, e.name, 'logs', 'latest.log'));
      });
    } catch (e) { /* ignore */ }
  });
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function chooseSource(sources, gameDir, versionId, isolated) {
  if (versionId) {
    const preferred = [];
    if (isolated) preferred.push(path.join(gameDir, 'instances', versionId, 'logs', 'latest.log'));
    else {
      preferred.push(path.join(gameDir, 'versions', versionId, 'logs', 'latest.log'));
      preferred.push(path.join(gameDir, 'logs', 'latest.log'));
    }
    for (const p of preferred) {
      const key = path.resolve(p);
      const hit = sources.find((s) => path.resolve(s.path) === key);
      if (hit) return hit;
    }
  }
  return sources[0];
}

/** 只从文件尾部读 maxBytes，并丢掉被截断的半行 */
function readTail(p, maxBytes) {
  const st = fs.statSync(p);
  const size = Math.min(st.size, maxBytes);
  if (size <= 0) return '';
  const buf = Buffer.alloc(size);
  const fd = fs.openSync(p, 'r');
  try {
    let read = 0;
    while (read < size) {
      const n = fs.readSync(fd, buf, read, size - read, st.size - size + read);
      if (n <= 0) break;
      read += n;
    }
    if (read < size) buf.fill(0, read);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  if (st.size > maxBytes) {
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1);
  }
  return text;
}

/** 按「进入世界 → 退出/崩溃」把事件切成一局一局；没有进世界事件时返回空数组 */
function sessions(events) {
  const out = [];
  let cur = null;
  for (const e of events || []) {
    if (e.type === 'world-open') {
      if (cur) out.push(cur);
      cur = { world: e.text, startTime: e.time, events: [] };
    }
    if (cur) cur.events.push(e);
    if (cur && (e.type === 'world-close' || e.type === 'crash')) {
      cur.endTime = e.time;
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function emptyStats() {
  return {
    lines: 0, matched: 0, unknown: 0, worldOpens: 0, worldCloses: 0,
    joins: 0, leaves: 0, deaths: 0, advancements: 0, crashes: 0,
    dimensions: [], startTime: null, endTime: null, durationSeconds: null, durationEstimated: false,
  };
}

/**
 * 读取并解析一次游玩的冒险日记。
 * @param {{gameDir:string, versionId?:string, isolated?:boolean, maxBytes?:number}} opts
 */
function readTimeline(opts) {
  const gameDir = String((opts && opts.gameDir) || '');
  const versionId = String((opts && opts.versionId) || '');
  const isolated = !!(opts && opts.isolated);
  const maxBytes = (opts && opts.maxBytes) || MAX_BYTES;
  try {
    const sources = candidateLogs(gameDir, versionId, isolated);
    if (!sources.length) {
      return {
        ok: true, empty: true, events: [], sessions: [], sources: [], stats: emptyStats(),
        message: '没有找到日志文件（logs/latest.log）。启动一次游戏后即可生成冒险日记。',
      };
    }
    const chosen = chooseSource(sources, gameDir, versionId, isolated);
    const text = readTail(chosen.path, maxBytes);
    const parsed = rules.parseLog(text);
    const evs = parsed.events || [];
    return {
      ok: true,
      empty: evs.length === 0,
      events: evs,
      sessions: sessions(evs),
      stats: parsed.stats || emptyStats(),
      sources: sources.map((s) => ({ path: s.path, mtime: s.mtime, size: s.size })),
      source: { path: chosen.path, mtime: chosen.mtime, size: chosen.size },
      truncated: chosen.size > maxBytes,
      message: evs.length ? '' : '这次日志里没有可识别的事件（只展示能明确识别的日志特征，不猜测）。',
    };
  } catch (e) {
    return {
      ok: false, empty: true, events: [], sessions: [], sources: [], stats: emptyStats(),
      error: e && e.message ? e.message : '日志解析失败',
    };
  }
}

module.exports = { readTimeline, candidateLogs, sessions, readTail, MAX_BYTES };
