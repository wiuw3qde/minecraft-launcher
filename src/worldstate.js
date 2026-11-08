'use strict';
/**
 * 世界状态记录（ROADMAP 第六章 S0 共用底座，支撑 N3 跨版本开档守卫 / N2 时光机）。
 *
 * 核心取舍：**不硬编码「MC 版本 ↔ DataVersion」全表**。
 * 那张表需要逐版人工复核，写错会误报甚至误导玩家降级开档。这里改用本地相对判据：
 * 记录该世界上次成功打开时的 DataVersion 与当时的版本 id，只在「换了版本」或
 * 「DataVersion 变了」时提示风险，把最终判断交给玩家。
 *
 * 边界：只读写调用方传入的一个 JSON 文件（默认落在已存在的 backups/auto/ 下），
 * 绝不读写任何世界文件、绝不联网。
 */
const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 20;

/** 默认状态文件位置：复用 #13 已建立的自动备份目录，不新增目录 */
function defaultStatePath(gameDir) {
  return path.join(String(gameDir || ''), 'backups', 'auto', '_worldstate.json');
}

function keyOf(gameDir, folder) {
  return String(gameDir || '') + '|' + String(folder || '');
}

function emptyState() {
  return { version: 1, worlds: {}, history: {} };
}

function load(statePath) {
  try {
    const j = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!j || typeof j !== 'object' || !j.worlds || typeof j.worlds !== 'object') return emptyState();
    if (!j.history || typeof j.history !== 'object') j.history = {};
    return j;
  } catch (e) {
    return emptyState();
  }
}

function save(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, statePath); // 原子替换，避免写一半损坏
}

function snapshot(opts) {
  return {
    gameDir: String(opts.gameDir || ''),
    folder: String(opts.folder || ''),
    versionId: String(opts.versionId || ''),
    dataVersion: typeof opts.dataVersion === 'number' && Number.isFinite(opts.dataVersion) ? opts.dataVersion : null,
    levelName: opts.levelName == null ? null : String(opts.levelName),
    updatedAt: Date.now(),
  };
}

/**
 * 检查本次打开是否存在跨版本风险。纯读取，不修改状态。
 * @returns {{kind:string, risk:string, message:string, previous:object|null}}
 *   kind: first | same | version-changed | dataversion-changed | unknown
 *   risk: none | low | high
 */
function check(statePath, opts) {
  const state = load(statePath);
  const key = keyOf(opts.gameDir, opts.folder);
  const prev = state.worlds[key] || null;
  const curVersionId = String(opts.versionId || '');
  const curData = typeof opts.dataVersion === 'number' && Number.isFinite(opts.dataVersion) ? opts.dataVersion : null;

  if (!prev) {
    return {
      kind: 'first', risk: 'none', previous: null,
      message: '首次记录这个世界的版本信息，本次不做风险判断。',
    };
  }
  if (curData === null || prev.dataVersion === null || prev.dataVersion === undefined) {
    return {
      kind: 'unknown', risk: 'low', previous: prev,
      message: '无法读取 DataVersion，只能记录，无法判断跨版本风险。请自行确认该存档适用的游戏版本。',
    };
  }
  if (String(prev.versionId || '') !== curVersionId) {
    return {
      kind: 'version-changed', risk: 'high', previous: prev,
      message: '这个世界上次是用「' + (prev.versionId || '未知版本') + '」打开的，现在改用「' + (curVersionId || '未知版本') + '」。跨版本打开可能损坏存档，建议先做快照，或复制一份再打开。',
    };
  }
  if (prev.dataVersion !== curData) {
    return {
      kind: 'dataversion-changed', risk: 'high', previous: prev,
      message: '同一个版本下，这个世界的 DataVersion 从 ' + prev.dataVersion + ' 变成了 ' + curData + '，可能已被其它工具升级或替换。建议先做快照再打开。',
    };
  }
  return {
    kind: 'same', risk: 'none', previous: prev,
    message: '版本与存档数据版本均与上次一致，未发现跨版本风险。',
  };
}

/** 记录一次「成功打开」的状态（应由调用方在确认无风险 / 用户明确继续后调用） */
function record(statePath, opts) {
  const state = load(statePath);
  const key = keyOf(opts.gameDir, opts.folder);
  const snap = snapshot(opts);
  state.worlds[key] = snap;
  const hist = Array.isArray(state.history[key]) ? state.history[key] : [];
  const last = hist[hist.length - 1];
  // 相同版本 + 相同 DataVersion 的重复打开不刷历史，避免时间轴被刷屏
  if (!last || last.versionId !== snap.versionId || last.dataVersion !== snap.dataVersion) {
    hist.push({ at: snap.updatedAt, versionId: snap.versionId, dataVersion: snap.dataVersion, levelName: snap.levelName });
    state.history[key] = hist.slice(-MAX_HISTORY);
  }
  save(statePath, state);
  return snap;
}

/** 世界被删除时清理记录 */
function forget(statePath, gameDir, folder) {
  const state = load(statePath);
  const key = keyOf(gameDir, folder);
  if (!state.worlds[key]) return false;
  delete state.worlds[key];
  delete state.history[key];
  save(statePath, state);
  return true;
}

module.exports = { defaultStatePath, load, check, record, forget, keyOf };
