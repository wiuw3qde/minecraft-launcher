'use strict';
const fs = require('fs');
const path = require('path');
const { readJsonFile } = require('./util');
const {
  loadProfile,
  resolveLibraries,
  resolveGameJar,
  resolveAssets,
  flattenArgs,
  gameDirOf,
} = require('./version-profile');

/**
 * 纯本地完整性检查：只报告缺失，不联网下载（下载模块后续接入）
 */
function checkVersion(gameDir, versionId, features) {
  features = features || {};
  const profile = loadProfile(gameDir, versionId);
  const { classpath, natives } = resolveLibraries(profile, features);
  const jarPath = resolveGameJar(profile);
  const { indexId, assetsRoot } = resolveAssets(profile, gameDir);

  const missingLibs = classpath.filter((p) => !fs.existsSync(p));
  const missingNatives = natives.filter((n) => !fs.existsSync(n.jar)).map((n) => n.relPath);

  const indexJson = indexId ? path.join(gameDir, 'assets', 'indexes', indexId + '.json') : null;
  const hasIndex = !!indexJson && fs.existsSync(indexJson);

  let assetsTotal = 0;
  let assetsMissing = 0;
  if (hasIndex) {
    const idx = readJsonFile(indexJson);
    if (idx && idx.objects) {
      const objectsDir = path.join(gameDir, 'assets', 'objects');
      for (const hash of Object.values(idx.objects).map((o) => o.hash)) {
        assetsTotal++;
        if (!fs.existsSync(path.join(objectsDir, hash.slice(0, 2), hash))) assetsMissing++;
      }
    }
  }

  return {
    versionId,
    jarPath,
    hasJar: fs.existsSync(jarPath),
    libraryTotal: classpath.length,
    missingLibs,
    nativesTotal: natives.length,
    missingNatives,
    indexId,
    indexJson,
    hasIndex,
    assetsRoot,
    assetsTotal,
    assetsMissing,
    ok: fs.existsSync(jarPath) && missingLibs.length === 0 && (!hasIndex ? true : assetsMissing === 0),
  };
}

module.exports = { checkVersion };
