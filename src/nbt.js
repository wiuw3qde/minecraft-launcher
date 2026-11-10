'use strict';
/**
 * 只读 NBT 解析 + level.dat 摘要（ROADMAP 第六章 S0 共用底座）。
 *
 * 由 src/instance.js 原有的 parseNbt/readLevelDat 抽取而来，行为保持兼容，
 * 并补上：边界检查、深度/节点数限制、损坏输入安全降级、跨版本字段摘要。
 *
 * 设计约束（硬边界）：
 *   - 只读，绝不写任何世界文件；
 *   - 解析失败返回 null / {ok:false}，不向调用方抛异常；
 *   - 零第三方依赖，只依赖 Node 内置 zlib。
 */
const fs = require('fs');
const zlib = require('zlib');

const DEFAULT_LIMITS = {
  maxDepth: 32,
  maxStringLen: 1 << 20,
  maxArrayLen: 1 << 20,
  maxNodes: 200000,
  // TAG_Long 默认仍转 Number（兼容旧调用方）；readLevelSummary 会开启
  // longAsBigInt 以保留 64 位种子的精确值，避免大种子被 IEEE754 截尾。
  longAsBigInt: false,
};

/**
 * 解析 NBT 字节流（大端）。根标签名会被跳过，返回根值对应的 JS 值。
 * @param {Buffer} buf 未压缩的 NBT 数据
 * @param {object} [limits] 防护上限；longAsBigInt=true 时 TAG_Long 返回 BigInt
 * @returns {*} 解析结果；数据损坏/超限时抛 Error（由 readLevelDat 捕获）
 */
function parseNbt(buf, limits) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('NBT 数据为空');
  const lim = Object.assign({}, DEFAULT_LIMITS, limits || {});
  let pos = 0;
  let nodes = 0;

  function need(n) {
    if (n < 0 || pos + n > buf.length) throw new Error('NBT 数据截断');
  }
  function u8() { need(1); const v = buf.readUInt8(pos); pos += 1; return v; }
  function i8() { need(1); const v = buf.readInt8(pos); pos += 1; return v; }
  function i16() { need(2); const v = buf.readInt16BE(pos); pos += 2; return v; }
  function i32() { need(4); const v = buf.readInt32BE(pos); pos += 4; return v; }
  function i64() { need(8); const v = buf.readBigInt64BE(pos); pos += 8; return lim.longAsBigInt ? v : Number(v); }
  function f32() { need(4); const v = buf.readFloatBE(pos); pos += 4; return v; }
  function f64() { need(8); const v = buf.readDoubleBE(pos); pos += 8; return v; }
  function str() {
    need(2);
    const len = buf.readUInt16BE(pos); pos += 2;
    if (len > lim.maxStringLen) throw new Error('NBT 字符串过长');
    need(len);
    const s = buf.slice(pos, pos + len).toString('utf8');
    pos += len;
    return s;
  }
  function count(label) {
    const n = i32();
    if (n < 0 || n > lim.maxArrayLen) throw new Error('NBT ' + label + ' 长度异常：' + n);
    return n;
  }
  function readValue(type, depth) {
    if (++nodes > lim.maxNodes) throw new Error('NBT 节点数超限');
    if (depth > lim.maxDepth) throw new Error('NBT 嵌套过深');
    switch (type) {
      case 0: return null;
      case 1: return i8();
      case 2: return i16();
      case 3: return i32();
      case 4: return i64();
      case 5: return f32();
      case 6: return f64();
      case 7: { const n = count('ByteArray'); const v = Buffer.from(buf.slice(pos, pos + n)); pos += n; return v; }
      case 8: return str();
      case 9: {
        const et = u8();
        const n = count('List');
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(readValue(et, depth + 1));
        return arr;
      }
      case 10: {
        const obj = {};
        for (;;) {
          const t = u8();
          if (t === 0) break;
          const name = str();
          obj[name] = readValue(t, depth + 1);
        }
        return obj;
      }
      case 11: { const n = count('IntArray'); const arr = []; for (let i = 0; i < n; i++) arr.push(i32()); return arr; }
      case 12: { const n = count('LongArray'); const arr = []; for (let i = 0; i < n; i++) arr.push(i64()); return arr; }
      default: throw new Error('不支持的 NBT 标签：' + type);
    }
  }

  const rootType = u8();
  str(); // 根标签名（通常为空）
  return readValue(rootType, 0);
}

/** 读取 gzip 压缩的 level.dat，返回原始 NBT 对象；失败返回 null（不抛） */
function readLevelDat(filePath, limits) {
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(filePath));
    return parseNbt(raw, limits);
  } catch (e) {
    return null;
  }
}

function num(v) {
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const k of p) {
      if (cur && typeof cur === 'object' && !Buffer.isBuffer(cur) && Object.prototype.hasOwnProperty.call(cur, k)) cur = cur[k];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined && cur !== null) return cur;
  }
  return null;
}
function firstNum(obj, paths) {
  return num(pick(obj, paths));
}

/**
 * 把原始 level.dat NBT 整理成跨版本稳定的摘要。
 * 字段位置随 MC 版本变化，因此逐字段多路径探测；缺失一律 null，绝不猜测。
 * 同时兼容真实结构 {Data:{...}} 与扁平结构（旧测试 / 极老版本）。
 * @returns {{name:string|null, dataVersion:number|null, lastPlayed:number|null,
 *   gameTicks:number|null, gameSeconds:number|null, dayTime:number|null,
 *   seed:number|null, seedText:string|null, versionName:string|null, versionId:string|null,
 *   gameType:number|null, hardcore:boolean|null, allowCommands:boolean|null,
 *   difficulty:number|null, player:object, source:'nbt'}}
 */
function summarizeLevel(nbt) {
  const d = (nbt && typeof nbt === 'object' && nbt.Data && typeof nbt.Data === 'object') ? nbt.Data : (nbt && typeof nbt === 'object' ? nbt : {});
  const gameTicks = firstNum(d, [['Time']]);
  const player = (d.Player && typeof d.Player === 'object') ? d.Player : {};
  const pos = pick(player, [['Pos']]);
  const seedRaw = pick(d, [['WorldGenSettings', 'seed'], ['RandomSeed'], ['worldGenSettings', 'seed']]);
  const versionName = pick(d, [['Version', 'Name'], ['Version', 'name']]);
  const versionId = pick(d, [['Version', 'Id'], ['Version', 'id']]);
  const dimRaw = pick(player, [['Dimension'], ['dimension']]);
  // 64 位种子必须按十进制文本保留，Number 会丢精度（玩家常用超 2^53 的种子）。
  const seedText = (function () {
    if (typeof seedRaw === 'bigint') return seedRaw.toString();
    if (typeof seedRaw === 'number' && Number.isSafeInteger(seedRaw)) return String(seedRaw);
    return null;
  })();
  return {
    name: typeof d.LevelName === 'string' ? d.LevelName : null,
    dataVersion: firstNum(d, [['DataVersion']]),
    lastPlayed: firstNum(d, [['LastPlayed']]),
    gameTicks,
    gameSeconds: gameTicks === null ? null : Math.max(0, Math.round(gameTicks / 20)),
    dayTime: firstNum(d, [['DayTime']]),
    seed: num(seedRaw),
    seedText,
    versionName: typeof versionName === 'string' ? versionName : null,
    versionId: typeof versionId === 'string' ? versionId : null,
    gameType: firstNum(d, [['GameType']]),
    hardcore: typeof d.hardcore === 'number' ? d.hardcore === 1 : (typeof d.hardcore === 'boolean' ? d.hardcore : null),
    allowCommands: typeof d.allowCommands === 'number' ? d.allowCommands === 1 : (typeof d.allowCommands === 'boolean' ? d.allowCommands : null),
    difficulty: firstNum(d, [['Difficulty']]),
    player: {
      pos: Array.isArray(pos) && pos.length >= 3 ? [num(pos[0]), num(pos[1]), num(pos[2])] : null,
      dimension: dimRaw === null || dimRaw === undefined ? null : String(dimRaw),
      health: firstNum(player, [['Health'], ['health']]),
      xpLevel: firstNum(player, [['XpLevel'], ['xpLevel']]),
      foodLevel: firstNum(player, [['foodLevel'], ['FoodLevel']]),
      spawn: (function () {
        const x = firstNum(player, [['SpawnX']]);
        const y = firstNum(player, [['SpawnY']]);
        const z = firstNum(player, [['SpawnZ']]);
        return x === null && y === null && z === null ? null : [x, y, z];
      })(),
    },
    source: 'nbt',
  };
}

/** 读取并摘要一个 level.dat；失败返回 {ok:false}，绝不抛异常 */
function readLevelSummary(filePath) {
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(filePath));
    return { ok: true, summary: summarizeLevel(parseNbt(raw, { longAsBigInt: true })) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : '解析失败' };
  }
}

module.exports = {
  parseNbt,
  readLevelDat,
  summarizeLevel,
  readLevelSummary,
  DEFAULT_LIMITS,
};
