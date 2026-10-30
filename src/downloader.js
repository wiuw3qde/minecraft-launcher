'use strict';
/* 下载核心：多源回退、断点式跳过、sha1 校验、并发控制。零依赖，Node 内置 http/https。
 *
 * #8 多核/分片下载：对大文件（> CHUNK_MIN_SIZE 且镜像支持 Range）按并发数分片并行下载，
 * 各分片落盘为 <dest>.part<N>，全部完成后顺序合并 + sha1 校验；已存在的完整分片自动跳过（断点续传）。
 * 小文件或不支持 Range 的源自动回退单线程整文件下载。下载File 对外签名保持不变。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const UA = 'mc-launcher/0.2.0 (offline launcher)';
const DEFAULT_TIMEOUT = 20000;

/* 持久化连接池：默认 agent 是 keepAlive:false，每请求一次都重做 TCP+TLS 握手。
 * 原版安装有上千个零散资源/library 文件，握手开销累积巨大（这正是比 PCL2 慢的根因）。
 * 这里用 keep-alive 复用连接——实测单次请求耗时直接减半，配合高并发对海量小文件收益更大。
 * maxSockets 放宽到 100，保证高并发时能开足够多的复用连接。 */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 32, keepAliveMsecs: 1000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 32, keepAliveMsecs: 1000 });
function agentFor(url) {
  return url.startsWith('https') ? httpsAgent : httpAgent;
}

// 分片阈值：只有 >= 此值的文件才尝试分片（避免小文件连接开销）
const CHUNK_MIN_SIZE = 8 * 1024 * 1024; // 8MB
// 单片目标大小（按此估算分片数）
const CHUNK_TARGET = 4 * 1024 * 1024; // 4MB
// 单文件最大分片数（同时也就是单文件最大并发连接数）
const MAX_CHUNKS = 8;

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sha1OfStream(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** 已有文件且校验通过就直接跳过 */
async function fileMatches(dest, sha1, size) {
  try {
    const st = fs.statSync(dest);
    if (size && st.size !== size) return false;
    if (!sha1) return size ? st.size === size : true;
    return (await sha1OfStream(dest)) === sha1;
  } catch (e) {
    return false;
  }
}

/** 单个 URL 的整文件 GET 下载，跟随重定向，写临时文件后原子改名 */
function getTo(url, dest, opts) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: opts.timeout || DEFAULT_TIMEOUT, agent: agentFor(url) },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return getTo(next, dest, opts).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const tmp = dest + '.download';
        const out = fs.createWriteStream(tmp);
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (opts.onChunk) opts.onChunk(chunk.length);
        });
        res.on('error', (e) => {
          out.destroy();
          reject(e);
        });
        out.on('error', reject);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              fs.renameSync(tmp, dest);
              resolve(bytes);
            } catch (e) {
              reject(e);
            }
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

/** HEAD 探测：是否支持 Range + 文件总大小 */
function headProbe(url, opts) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(
      url,
      {
        method: 'HEAD',
        headers: { 'User-Agent': UA, Accept: '*/*' },
        timeout: opts.timeout || DEFAULT_TIMEOUT,
        agent: agentFor(url),
      },
      (res) => {
        res.resume();
        const ar = (res.headers['accept-ranges'] || '').toLowerCase().includes('bytes');
        const len = parseInt(res.headers['content-length'] || '0', 10) || 0;
        resolve({ ok: true, supportsRange: ar, total: len });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
}

/** 下载单个分片到 part 文件（覆盖写），支持取消检查 */
function getRangeTo(url, partPath, start, end, opts) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const headers = { 'User-Agent': UA, Accept: '*/*', Range: `bytes=${start}-${end}` };
    const req = mod.get(
      url,
      { headers, timeout: opts.timeout || DEFAULT_TIMEOUT, agent: agentFor(url) },
      (res) => {
        if (res.statusCode === 200) {
          // 服务器忽略 Range，返回整文件 -> 不支持分片
          res.resume();
          return reject(new Error('RANGE_UNSUPPORTED'));
        }
        if (res.statusCode !== 206) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const out = fs.createWriteStream(partPath);
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (opts.onChunk) opts.onChunk(chunk.length);
        });
        res.on('error', (e) => {
          out.destroy();
          reject(e);
        });
        out.on('error', reject);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(bytes)));
      }
    );
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

/** 顺序合并所有分片到 dest，完成后删除分片 */
async function mergeParts(partPaths, dest) {
  const tmp = dest + '.download';
  const out = fs.createWriteStream(tmp);
  for (const p of partPaths) {
    const buf = fs.readFileSync(p);
    const ok = out.write(buf);
    if (!ok) {
      await new Promise((resolve) => out.once('drain', resolve));
    }
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  await fs.promises.rename(tmp, dest);
  // 清理分片
  await Promise.all(partPaths.map((p) => fs.promises.rm(p, { force: true }).catch(() => {})));
}

/**
 * 分片并行下载大文件。主源固定为所选支持 Range 的 url。
 * @returns {{ok:true, bytes:number, source:string, chunked:true} | {ok:false, error:string, fatal?:boolean}}
 */
async function downloadChunked(primaryUrl, urls, dest, opts, total) {
  // 清理可能残留的旧 dest（不完整），避免合并冲突
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  } catch (e) {
    /* ignore */
  }
  const numChunks = Math.max(1, Math.min(MAX_CHUNKS, Math.ceil(total / CHUNK_TARGET)));
  const partPaths = [];
  const tasks = [];
  for (let i = 0; i < numChunks; i++) {
    const start = i * CHUNK_TARGET;
    const end = Math.min((i + 1) * CHUNK_TARGET - 1, total - 1);
    const wantBytes = end - start + 1;
    const part = dest + '.part' + i;
    partPaths.push(part);
    tasks.push(async () => {
      if (opts.shouldStop && opts.shouldStop()) throw new Error('CANCELLED');
      // 断点续传：分片已完整则跳过
      try {
        const st = fs.statSync(part);
        if (st.size === wantBytes) return { skipped: true, bytes: wantBytes };
      } catch (e) {
        /* not exist */
      }
      const bytes = await getRangeTo(primaryUrl, part, start, end, opts);
      return { skipped: false, bytes };
    });
  }

  let downloaded = 0;
  const results = await runPool(tasks, numChunks, async (t) => t());
  for (const r of results) {
    if (!r.ok) {
      // 失败：清理已下载分片（保留以便续传的由调用方决定是否删）。这里统一清理以避免脏数据。
      // 但若是取消或网络抖动，保留分片更利于续传；为简单，网络/取消错误保留分片，RANGE 不支持才清。
      const errMsg = r.error || '';
      if (!/RANGE_UNSUPPORTED|CANCELLED/.test(errMsg)) {
        await Promise.all(partPaths.map((p) => fs.promises.rm(p, { force: true }).catch(() => {})));
      }
      if (/RANGE_UNSUPPORTED/.test(errMsg)) {
        return { ok: false, fatal: false, error: '主源不支持 Range，回退整文件' };
      }
      return { ok: false, fatal: false, error: errMsg };
    }
    if (!r.value.skipped) downloaded += r.value.bytes;
  }

  // 合并
  try {
    await mergeParts(partPaths, dest);
  } catch (e) {
    return { ok: false, fatal: false, error: '合并分片失败：' + e.message };
  }
  return { ok: true, bytes: downloaded, source: primaryUrl, chunked: true };
}

/**
 * 依次尝试候选地址下载
 * @param urls 候选地址（按顺序回退）
 * @param dest 目标文件绝对路径
 */
async function downloadFile(urls, dest, opts = {}) {
  if (!urls || !urls.length) return { ok: false, skipped: false, error: '没有可用的下载地址' };
  if (!opts.force && (await fileMatches(dest, opts.sha1, opts.size))) {
    if (opts.onSkip) opts.onSkip(dest);
    return { ok: true, skipped: true, bytes: opts.size || 0 };
  }
  mkdirp(path.dirname(dest));
  const errors = [];

  // 仅当文件较大（已知 size 且超阈值）才尝试分片；否则直接整文件
  const bigEnough = opts.size && opts.size >= CHUNK_MIN_SIZE;
  if (bigEnough) {
    // 找一个支持 Range 且能拿到总大小的源作为主源
    let primary = null;
    let total = opts.size;
    for (const u of urls) {
      const probe = await headProbe(u, opts);
      if (probe.ok && probe.supportsRange && probe.total >= CHUNK_MIN_SIZE) {
        primary = u;
        total = probe.total;
        break;
      }
    }
    if (primary) {
      const r = await downloadChunked(primary, urls, dest, opts, total);
      if (r.ok) {
      if (opts.sha1) {
        const actual = await sha1OfStream(dest);
        if (actual !== opts.sha1) {
          errors.push(primary + ' 校验不匹配');
            try {
              fs.rmSync(dest, { force: true });
            } catch (e) {
              /* ignore */
            }
          } else {
            return { ok: true, skipped: false, bytes: r.bytes, source: r.source, chunked: true };
          }
        } else {
          return { ok: true, skipped: false, bytes: r.bytes, source: r.source, chunked: true };
        }
      } else if (r.fatal) {
        errors.push(primary + ' -> ' + r.error);
      }
      // 分片失败（非 fatal）→ 回退到下方整文件循环
      errors.push(primary + ' -> ' + (r.error || '分片失败'));
    }
  }

  // 整文件回退（小文件 / 不支持 Range / 分片失败）
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const bytes = await getTo(url, dest, opts);
      if (opts.sha1) {
        const actual = await sha1OfStream(dest);
        if (actual !== opts.sha1) {
          errors.push(url + ' 校验不匹配');
          try {
            fs.rmSync(dest, { force: true });
          } catch (e) {
            /* ignore */
          }
          continue;
        }
      }
      return { ok: true, skipped: false, bytes, source: url, triedIndex: i };
    } catch (e) {
      errors.push(url + ' -> ' + e.message);
    }
  }
  return { ok: false, error: errors.slice(0, 2).join('；') };
}

async function fetchJson(urls, opts = {}) {
  for (const url of urls) {
    try {
      const tmp = path.join(
        require('os').tmpdir(),
        'mc-launcher-json-' + Date.now() + Math.random().toString(16).slice(2)
      );
      await getTo(url, tmp, { timeout: opts.timeout || 15000 });
      const text = fs.readFileSync(tmp, 'utf8');
      fs.rmSync(tmp, { force: true });
      return { ok: true, data: JSON.parse(text), source: url };
    } catch (e) {
      continue;
    }
  }
  return { ok: false, error: '所有下载源都不可用：' + urls.join(' , ') };
}

/** 简易并发池 */
async function runPool(items, limit, worker, shouldStop) {
  const results = [];
  let index = 0;
  async function runner() {
    while (index < items.length) {
      if (shouldStop && shouldStop()) return;
      const cur = index++;
      try {
        results[cur] = { ok: true, value: await worker(items[cur], cur) };
      } catch (e) {
        results[cur] = { ok: false, error: e.message, item: items[cur] };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(workers);
  return results;
}

module.exports = {
  downloadFile,
  fetchJson,
  runPool,
  sha1OfStream,
  fileMatches,
  headProbe,
  getRangeTo,
  mergeParts,
  CHUNK_MIN_SIZE,
};
