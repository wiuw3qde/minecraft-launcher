'use strict';
/**
 * 下载源定义与 URL 重写。
 * 规则全部实测过：BMCLAPI / OpenBMCLAPI / HKMC 三个源目录结构一致，
 * 官方源作为兜底，任何源挂掉都会自动切下一个。
 */

const MIRRORS = [
  { id: 'bmclapi', name: 'BMCLAPI（国内首选，白山 CDN）', apiRoot: 'https://bmclapi2.bangbang93.com' },
  { id: 'openbmclapi', name: 'OpenBMCLAPI（分布式节点）', apiRoot: 'https://openbmclapi.bangbang93.com' },
  { id: 'hkmc', name: 'HKMC 光速镜像', apiRoot: 'https://mirror.hkmc.online' },
  { id: 'official', name: 'Mojang 官方（海外服务器）', apiRoot: null },
];

// 官方地址前缀 -> 镜像下的路径前缀
const REWRITE_RULES = [
  { prefix: 'https://libraries.minecraft.net/', to: '/maven/' },
  { prefix: 'http://libraries.minecraft.net/', to: '/maven/' },
  { prefix: 'https://files.minecraftforge.net/maven/', to: '/maven/' },
  { prefix: 'https://maven.minecraftforge.net/', to: '/maven/' },
  { prefix: 'https://maven.fabricmc.net/', to: '/maven/' },
  { prefix: 'https://resources.download.minecraft.net/', to: '/assets/' },
  { prefix: 'http://resources.download.minecraft.net/', to: '/assets/' },
  { prefix: 'https://launchermeta.mojang.com/', to: '/' },
  { prefix: 'https://launcher.mojang.com/', to: '/' },
  { prefix: 'https://piston-meta.mojang.com/', to: '/' },
  { prefix: 'https://piston-data.mojang.com/', to: '/' },
];

const OFFICIAL_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

// 未列出版本（愚人节、上古版本等），来自 zkitefly/unlisted-versions-of-minecraft
const UNLISTED_MANIFESTS = [
  'https://alist.8mi.tech/d/mirror/unlisted-versions-of-minecraft/Auto/version_manifest.json',
  'https://zkitefly.github.io/unlisted-versions-of-minecraft/version_manifest.json',
];

function getMirror(id) {
  return MIRRORS.find((m) => m.id === id) || MIRRORS[0];
}

function resolveMirrors(ids) {
  const list = (Array.isArray(ids) && ids.length ? ids : ['bmclapi']).map(getMirror);
  return list.filter((m, i) => list.indexOf(m) === i);
}

/** 把官方地址改写到指定镜像；官方源返回原地址 */
function rewriteUrl(url, mirror) {
  if (!mirror || !mirror.apiRoot) return url;
  for (const rule of REWRITE_RULES) {
    if (url.startsWith(rule.prefix)) {
      return mirror.apiRoot + rule.to + url.slice(rule.prefix.length);
    }
  }
  return null;
}

/**
 * 生成候选地址列表：优先用户选的镜像，依次回退到其余镜像，最后回到官方原始地址
 */
function candidatesFor(url, mirrorIds) {
  const mirrors = resolveMirrors(mirrorIds);
  const list = [];
  if (url.startsWith('http')) {
    for (const m of mirrors) {
      const rewritten = rewriteUrl(url, m);
      if (rewritten && !list.includes(rewritten)) list.push(rewritten);
    }
    if (!list.includes(url)) list.push(url);
  }
  return list;
}

/** 版本清单地址（按镜像顺序） */
function manifestUrls(mirrorIds) {
  const mirrors = resolveMirrors(mirrorIds);
  const list = mirrors
    .filter((m) => m.apiRoot)
    .map((m) => m.apiRoot + '/mc/game/version_manifest.json');
  list.push(OFFICIAL_MANIFEST);
  return Array.from(new Set(list));
}

module.exports = {
  MIRRORS,
  OFFICIAL_MANIFEST,
  UNLISTED_MANIFESTS,
  getMirror,
  resolveMirrors,
  rewriteUrl,
  candidatesFor,
  manifestUrls,
};
