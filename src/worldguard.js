'use strict';
/**
 * N3 跨版本开档守卫（ROADMAP 第六章 S2）。
 *
 * 纯编排层：评估 / 快照 / 复制 / 记录，不含任何 UI（对话框在 main.js 用 electron.dialog）。
 * 判据沿用 S0 的「本地相对判据」：只比较「这个世界上次成功打开时的版本 id / DataVersion」
 * 与本次是否一致，**不硬编码 MC↔DataVersion 全表，不猜测版本兼容性**。
 *
 * 硬边界：评估阶段纯只读；快照/复制只在用户明确选择后执行，且只新建文件、不改动原世界。
 */
const fs = require('fs');
const instance = require('./instance');
const worldstate = require('./worldstate');

/** 启动关键路径上不要调 listWorlds（它会递归算每个世界的大小），只要目录名 */
function listWorldFolders(savesDir) {
  try {
    return fs.readdirSync(savesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (e) {
    return [];
  }
}

/** 评估本次启动涉及的世界的跨版本风险。纯读取，失败一律降级，绝不让启动崩掉。 */
function evaluate(opts) {
  const gameDir = String((opts && opts.gameDir) || '');
  const versionId = String((opts && opts.versionId) || '');
  try {
    if (!gameDir || !versionId) return { ok: false, error: '缺少游戏目录或版本 id', items: [], risky: [] };
    const savesDir = instance.savesDirFor(gameDir, versionId, !!(opts && opts.isolated));
    const statePath = worldstate.defaultStatePath(gameDir);
    const items = listWorldFolders(savesDir).map((folder) => {
      const info = instance.worldInfo(savesDir, folder);
      const summary = info.ok ? info.summary : null;
      const dataVersion = summary ? summary.dataVersion : null;
      const name = (summary && summary.name) || folder;
      const recordOpts = { gameDir, folder, versionId, dataVersion, levelName: name };
      const verdict = worldstate.check(statePath, recordOpts);
      return {
        folder,
        name,
        dataVersion,
        kind: verdict.kind,
        risk: verdict.risk,
        message: verdict.message,
        previous: verdict.previous,
        record: recordOpts,
      };
    });
    return {
      ok: true,
      savesDir,
      statePath,
      items,
      risky: items.filter((i) => i.risk === 'high'),
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : '评估失败', items: [], risky: [] };
  }
}

/** 对指定世界做单世界 zip 快照（复用 #13 已有的 backupWorld）。 */
function snapshot(savesDir, folders) {
  return (folders || []).map((f) => Object.assign({ folder: f }, instance.backupWorld(savesDir, f)));
}

/** 复制世界目录作为「升级前副本」。 */
function copy(savesDir, folders) {
  return (folders || []).map((f) => Object.assign({ folder: f }, instance.copyWorld(savesDir, f)));
}

/** 启动成功后记录状态，供下次判断；失败只降级，不影响已启动的游戏。 */
function record(statePath, items) {
  let n = 0;
  for (const it of items || []) {
    try {
      if (it && it.record) { worldstate.record(statePath, it.record); n += 1; }
    } catch (e) { /* 单个失败不影响其余 */ }
  }
  return n;
}

module.exports = { evaluate, snapshot, copy, record };
