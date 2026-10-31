'use strict';
/* 从模组 jar 里读取元数据，定位 Modrinth 来源与版本。
 * 零依赖：自带最小 ZIP 中央目录读取器（仅取单个条目），支持 store(0) 与 deflate(8)。
 * 解析支持：fabric.mod.json / quilt.mod.json（JSON）、META-INF/mods.toml（Forge，轻量解析）。
 */
const fs = require('fs');
const zlib = require('zlib');

const MODRINTH_RE = /modrinth\.com\/(?:mod|project)\/([A-Za-z0-9_-]+)/i;

/* ---------- 最小 ZIP 单条目读取 ---------- */

/** 在文件末尾搜索 EOCD（End Of Central Directory）签名 */
function findEocd(buf) {
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** 读取 zip 中名为 entryName 的条目文本；找不到或损坏返回 null */
function readZipEntryText(jarPath, entryName) {
  let buf;
  try {
    buf = fs.readFileSync(jarPath);
  } catch (e) {
    return null;
  }
  if (buf.readUInt32LE(0) !== 0x04034b50 && buf.readUInt32LE(0) !== 0x504b0304) {
    // 不是 zip（某些 mod 是 zip 但首 4 字节应 0x04034b50）；容错：仍尝试
  }
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let localOffset = -1;
  let compSize = -1;
  let method = -1;
  let nameLen = -1;
  let extraLen = -1;
  while (p + 46 <= cdEnd && buf.readUInt32LE(p) === 0x02014b50) {
    const cSize = buf.readUInt32LE(p + 20);
    const compMethod = buf.readUInt16LE(p + 10);
    const nLen = buf.readUInt16LE(p + 28);
    const xLen = buf.readUInt16LE(p + 30);
    const cLen = buf.readUInt16LE(p + 32); // comment length
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nLen);
    if (name === entryName) {
      localOffset = lho;
      compSize = cSize;
      method = compMethod;
      nameLen = nLen;
      extraLen = xLen;
      break;
    }
    p += 46 + nLen + xLen + cLen;
  }
  if (localOffset < 0) return null;
  // 本地文件头：30 固定 + name + extra，之后是数据
  const dataStart = localOffset + 30 + nameLen + extraLen;
  if (dataStart + compSize > buf.length) return null;
  const comp = buf.slice(dataStart, dataStart + compSize);
  if (method === 0) return comp.toString('utf8');
  if (method === 8) {
    try {
      return zlib.inflateRawSync(comp).toString('utf8');
    } catch (e) {
      return null;
    }
  }
  return null;
}

/* ---------- 元数据解析 ---------- */

function firstModrinthSlug(text) {
  if (!text) return null;
  const m = String(text).match(MODRINTH_RE);
  return m ? m[1] : null;
}

/** 解析 fabric.mod.json / quilt.mod.json */
function parseFabricJson(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return null;
  }
  // Modrinth 注入位置有两种：顶层 modrinth（老写法）与 custom.modrinth（官方注入写法），
  // 字段名也有 project_id / projectId / id / slug 几种变体，全部兼容。
  let slug = null;
  const nodes = [j.modrinth, j.custom && j.custom.modrinth, j.custom && j.custom.modupdater];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    slug = n.project_id || n.projectId || n.slug || n.id || slug;
    if (slug) break;
  }
  if (slug) slug = String(slug);
  // 从 contact 各种 URL 找 modrinth
  const contacts = j.contact || {};
  for (const k of Object.keys(contacts)) {
    if (!slug) slug = firstModrinthSlug(contacts[k]);
  }
  if (!slug) slug = firstModrinthSlug(JSON.stringify(j));
  return {
    slug,
    version: j.version || '',
    name: j.name || '',
  };
}

/** 轻量解析 Forge 的 META-INF/mods.toml（不依赖 toml 库） */
function parseForgeToml(text) {
  const slug = firstModrinthSlug(text);
  let version = '';
  // 取第一个 [[mods]] 块里的 version = "..."
  const blockMatch = text.match(/\[\[mods\]\]([\s\S]*?)(\n\[\[|\n\[[a-z]|$)/i);
  const block = blockMatch ? blockMatch[1] : text;
  const vm = block.match(/version\s*=\s*"([^"]*)"/i);
  if (vm) version = vm[1];
  return { slug, version, name: '' };
}

/** 从文件名里尽力猜出版本（兜底用） */
function guessVersionFromFilename(name) {
  // 形如 sodium-fabric-mc1.20.1-0.5.3.jar 或 mod-1.2.3.jar
  const m = name.replace(/\.(jar|zip)$/i, '').match(/[-_]?v?(\d+\.\d+(?:\.\d+)?(?:[-.+][A-Za-z0-9.+-]+)?)\s*$/i);
  return m ? m[1] : '';
}

/**
 * 综合读取一个模组 jar 的元数据。
 * @returns {{slug:?string, version:string, loaderHint:?string}} slug 为 Modrinth 项目 id/slug，找不到为 null
 */
function readJarMeta(jarPath) {
  if (!/\.(jar|zip)$/i.test(jarPath)) return { slug: null, version: '', loaderHint: null };
  // 依次尝试常见元数据文件
  const candidates = [
    { name: 'fabric.mod.json', loader: 'fabric' },
    { name: 'quilt.mod.json', loader: 'quilt' },
    { name: 'META-INF/mods.toml', loader: 'forge' },
  ];
  let parsed = null;
  let usedLoader = null;
  for (const c of candidates) {
    const text = readZipEntryText(jarPath, c.name);
    if (!text) continue;
    if (c.loader === 'fabric' || c.loader === 'quilt') {
      const r = parseFabricJson(text);
      if (r && (r.slug || r.version)) { parsed = r; usedLoader = c.loader; }
    } else {
      const r = parseForgeToml(text);
      if (r && (r.slug || r.version)) { parsed = r; usedLoader = c.loader; }
    }
    if (parsed) break;
  }
  if (!parsed) {
    return { slug: null, version: guessVersionFromFilename(jarPath), loaderHint: null };
  }
  if (!parsed.version) parsed.version = guessVersionFromFilename(jarPath);
  parsed.loaderHint = usedLoader;
  return parsed;
}

module.exports = {
  readZipEntryText,
  readJarMeta,
  MODRINTH_RE,
};
