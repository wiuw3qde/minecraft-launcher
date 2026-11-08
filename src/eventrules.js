'use strict';
/**
 * 日志事件规则库（ROADMAP 第六章 S0 共用底座，支撑 N1 冒险日记 / N2 时光机 / N5 自愈）。
 *
 * 把 latest.log 的纯文本转成结构化事件。原则：
 *   - **只匹配明确的英文日志特征**（MC 日志正文不随界面语言本地化），不认识的行只计数，
 *     绝不猜测、绝不编造事件；
 *   - 纯本地、只读、不联网、不写文件；聊天内容等隐私信息一律不采集；
 *   - 规则式可扩充，新增一条规则即可覆盖新版本 / 新 mod 的日志。
 */
const MAX_LINES = 200000;

function pad(n) { return String(n).padStart(2, '0'); }

/** 从日志行首的时间戳里取 HH:MM:SS；取不到返回 null */
function parseClock(raw) {
  const m = /(\d{1,2}):(\d{2}):(\d{2})/.exec(String(raw || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  if (h > 23 || mi > 59 || s > 59) return null;
  return { h, m: mi, s, seconds: h * 3600 + mi * 60 + s, text: pad(h) + ':' + pad(mi) + ':' + pad(s) };
}

const RULES = [
  {
    id: 'world-open', type: 'world-open',
    re: /(?:Preparing level ["']?([^"'\r\n]+?)["']?(?=\s|$)|Loading level\b|Starting integrated minecraft server version\s+(\S+))/i,
    build: (m) => ({ text: '进入世界' + (m[1] ? '「' + m[1] + '」' : (m[2] ? '（' + m[2] + '）' : '')) }),
  },
  {
    id: 'world-close', type: 'world-close',
    re: /Stopping server\b|Stopping!\b|Stopping singleplayer server/i,
    build: () => ({ text: '退出世界' }),
  },
  {
    id: 'join', type: 'join',
    re: /\b(\S+)\s+joined the game\b/i,
    build: (m) => ({ text: m[1] + ' 加入了游戏', actor: m[1] }),
  },
  {
    id: 'leave', type: 'leave',
    re: /\b(\S+)\s+(?:left the game|lost connection)\b/i,
    build: (m) => ({ text: m[1] + ' 离开了游戏', actor: m[1] }),
  },
  {
    id: 'advancement', type: 'advancement',
    re: /\b(\S+)\s+has (?:made the advancement|reached the goal|completed the challenge)\s*\[([^\]]+)\]/i,
    build: (m) => ({ text: m[1] + ' 达成进度「' + m[2] + '」', actor: m[1], advancement: m[2] }),
  },
  {
    id: 'death', type: 'death',
    re: /\b(\S+)\s+(?:was slain by|was shot by|was killed by|fell from a high place|fell into|drowned|burned to death|suffocated|blew up|hit the ground too hard|was pricked to death|died)\b/i,
    build: (m) => ({ text: m[1] + ' ' + m[0].slice(m[0].indexOf(m[1]) + m[1].length).trim(), actor: m[1] }),
  },
  {
    id: 'dimension', type: 'dimension',
    re: /(?:moved to dimension|Changing dimension to|Respawning in dimension)\s*[:]?\s*(minecraft:[\w_]+|[\w:]+)/i,
    build: (m) => ({ text: '切换维度：' + m[1], dimension: m[1] }),
  },
  {
    id: 'crash', type: 'crash',
    re: /---- Minecraft Crash Report ----|Crash report saved to|Game crashed!/i,
    build: () => ({ text: '游戏崩溃' }),
  },
  {
    id: 'oom', type: 'crash',
    re: /OutOfMemoryError|Java heap space/i,
    build: () => ({ text: '内存不足（OOM）' }),
  },
  {
    id: 'mods-loaded', type: 'mods-loaded',
    re: /(?:Loading|Found|Loaded)\s+(\d+)\s+mods?\b/i,
    build: (m) => ({ text: '加载了 ' + m[1] + ' 个 Mod', modCount: parseInt(m[1], 10) }),
  },
];

/**
 * 解析日志文本。
 * @param {string} text 日志全文
 * @param {{maxLines?:number}} [opts]
 * @returns {{ok:boolean, events:Array, stats:object, unknownSample:Array}}
 *   events 每项：{ index, time:string|null, seconds:number|null, type, id, text, ... }
 */
function parseLog(text, opts) {
  const maxLines = (opts && opts.maxLines) || MAX_LINES;
  const lines = String(text || '').split(/\r?\n/).slice(0, maxLines);
  const events = [];
  const unknownSample = [];
  let unknown = 0;
  let firstClock = null;
  let lastClock = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const head = /^\s*\[([^\]]{4,40})\]/.exec(line);
    const clock = head ? parseClock(head[1]) : null;
    if (clock) {
      if (!firstClock) firstClock = clock;
      lastClock = clock;
    }
    let hit = null;
    let match = null;
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (m) { hit = r; match = m; break; }
    }
    if (hit) {
      let extra;
      try { extra = hit.build(match, line) || {}; } catch (e) { extra = {}; }
      events.push(Object.assign({
        index: i,
        time: clock ? clock.text : null,
        seconds: clock ? clock.seconds : null,
        type: hit.type,
        id: hit.id,
        text: '事件',
      }, extra));
    } else {
      unknown++;
      if (unknownSample.length < 20) {
        // 未识别行只留本地内存样例，且对疑似聊天内容做脱敏（隐私边界：不采集聊天原文）
        const isChat = /\[CHAT\]|<[^>\s]{1,32}>/.test(line);
        unknownSample.push(isChat ? '[已省略：聊天内容]' : line.slice(0, 160));
      }
    }
  }

  let durationSeconds = null;
  if (firstClock && lastClock) {
    durationSeconds = lastClock.seconds - firstClock.seconds;
    if (durationSeconds < 0) durationSeconds += 86400; // 跨午夜
  }

  const count = (t) => events.filter((e) => e.type === t).length;
  const stats = {
    lines: lines.length,
    matched: events.length,
    unknown,
    worldOpens: count('world-open'),
    worldCloses: count('world-close'),
    joins: count('join'),
    leaves: count('leave'),
    deaths: count('death'),
    advancements: count('advancement'),
    crashes: count('crash'),
    dimensions: Array.from(new Set(events.filter((e) => e.type === 'dimension').map((e) => e.dimension).filter(Boolean))),
    startTime: firstClock ? firstClock.text : null,
    endTime: lastClock ? lastClock.text : null,
    durationSeconds,
    durationEstimated: durationSeconds !== null,
  };
  return { ok: true, events, stats, unknownSample };
}

module.exports = { parseLog, parseClock, RULES };
