'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const platform = require('./src/platform');
const { app, BrowserWindow, ipcMain, dialog, shell, session, clipboard } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const https = require('https');
const http = require('http');

const scanner = require('./src/scanner');
const integrity = require('./src/integrity');
const javaFinder = require('./src/java-finder');
const { prepareLaunch } = require('./src/launch-builder');
const { Launcher } = require('./src/launcher');
const { clearNatives } = require('./src/natives');
const { createOfflineAccount } = require('./src/offline-auth');
const installer = require('./src/installer');
const loaders = require('./src/loaders');
const { MIRRORS } = require('./src/mirrors');
const { MsaAuth } = require('./src/msauth');
const modplatforms = require('./src/modplatforms');
const maps = require('./src/maps');
const importConfig = require('./src/import-config');
const logDiagnose = require('./src/log-diagnose');
const instance = require('./src/instance');
const modpack = require('./src/modpack');
const javadl = require('./src/javadl');
const zip = require('./src/zip');
const worldguard = require('./src/worldguard');
const timeline = require('./src/timeline');
const modupdate = require('./src/modupdate');
const { autoUpdater } = require('electron-updater');

// 版本号统一以 package.json 为准，避免打包升版后启动器里显示的仍是旧号
const APP_VERSION = require('./package.json').version;
// 默认更新源：开箱即用，无需用户手动填；用户也可在设置里改成自己的仓库
const DEFAULT_UPDATER_URL = 'https://github.com/wiuw3qde/minecraft-launcher';

let win = null;
const launcher = new Launcher();

function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

/**
 * 配置迁移：开发版（start.bat）的 userData 目录叫 mc-launcher，
 * 打包版 productName 是「MC 启动器」，目录名不同。
 * 首次运行时把旧配置搬过来，用户的游戏目录 / 登录态不丢。
 */
function migrateLegacyConfig() {
  try {
    const target = configFile();
    if (fs.existsSync(target)) return;
    const legacy = path.join(app.getPath('appData'), 'mc-launcher', 'config.json');
    if (fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(legacy, target);
    }
  } catch (e) {
    /* 迁移失败不影响使用，顶多回到默认设置 */
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- 自动备份（#13）配置默认与合并 ---------------- */
function defaultBackup() {
  return { enabled: false, intervalDays: 7, keep: 5, scope: 'world', targets: [], lastRun: 0 };
}
/** 合并/校正 backup 配置，保证所有字段类型正确、scope 合法 */
function mergeBackup(cfg) {
  const d = defaultBackup();
  const b = (cfg && cfg.backup) || {};
  const scope = b.scope === 'version' ? 'version' : 'world';
  const targets = Array.isArray(b.targets) ? b.targets.filter((x) => typeof x === 'string') : [];
  return {
    enabled: !!b.enabled,
    intervalDays: Number.isFinite(b.intervalDays) ? b.intervalDays : d.intervalDays,
    keep: Number.isFinite(b.keep) ? b.keep : d.keep,
    scope,
    targets,
    lastRun: Number.isFinite(b.lastRun) ? b.lastRun : 0,
  };
}
function bkStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
/** 执行一次自动备份（force=true 时忽略间隔立即执行）。返回摘要。 */
async function runAutoBackup(opts) {
  opts = opts || {};
  const cfg = readConfig();
  const b = mergeBackup(cfg);
  if (!b.enabled) return { ok: true, skipped: 'disabled' };
  const due = b.lastRun && Date.now() - b.lastRun < b.intervalDays * 86400000;
  if (!opts.force && due) return { ok: true, skipped: 'not-due' };
  const gameDir = cfg.gameDir || scanner.defaultGameDir();
  const summary = { ok: true, versionCount: 0, backups: [], errors: [] };
  for (const versionId of b.targets) {
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    try {
      const r = instance.autoBackup(gameDir, versionId, isolated, b.scope);
      if (r.ok) {
        summary.versionCount++;
        (r.results || []).forEach((x) => summary.backups.push(versionId + (x.folder ? '/' + x.folder : '') + (x.scope === 'version' ? ' (整版本)' : '')));
        instance.pruneAutoBackups(gameDir, versionId, b.scope, b.keep);
      } else {
        summary.errors.push(versionId + ': ' + (r.error || '失败'));
      }
    } catch (e) {
      summary.errors.push(versionId + ': ' + e.message);
    }
  }
  // 更新 lastRun（保留其他配置字段）
  const stored = readConfig();
  stored.backup = Object.assign(mergeBackup(stored), { lastRun: Date.now() });
  writeConfig(stored);
  summary.lastRun = stored.backup.lastRun;
  return summary;
}
/** 启动后延迟调度自动备份，绝不阻塞启动 */
function scheduleAutoBackup() {
  setTimeout(() => {
    runAutoBackup().then((summary) => {
      if (win && !win.isDestroyed() && summary && summary.versionCount) {
        win.webContents.send('backup:auto-result', summary);
      }
    }).catch((e) => console.error('[backup] 自动备份异常', e.message));
  }, 5000);
}

/** 依据物理内存自动给出合理的 JVM 堆上限（MB）。
 * 给系统留出足够余量，避免 OOM：1.18+ 更吃内存，这里统一略宽松。 */
function autoMemoryMB() {
  const totalGB = os.totalmem() / (1024 * 1024 * 1024);
  let max;
  if (totalGB <= 3) max = 1536;
  else if (totalGB <= 6) max = 2048;
  else if (totalGB <= 10) max = 3072;
  else if (totalGB <= 16) max = 4096;
  else if (totalGB <= 24) max = 6144;
  else if (totalGB <= 32) max = 8192;
  else max = 8192;
  const min = Math.max(512, Math.round(max * 0.25));
  return { maxMB: max, minMB: min };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 920,
    minHeight: 640,
    title: 'MC 启动器',
    icon: path.join(__dirname, 'assets', 'icon-512.png'),
    backgroundColor: '#0a0e14',
    titleBarStyle: 'hidden', // 自定义标题栏
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // 兜底：页面加载异常也要把窗口显示出来，避免黑屏卡死
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }, 5000);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 最大化状态变化同步给渲染进程（切换按钮图标）
  const notifyMax = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:maximize-change', win.isMaximized());
  };
  win.on('maximize', notifyMax);
  win.on('unmaximize', notifyMax);

  // 把渲染进程的报错转发到终端，方便排查界面问题
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 1) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (event, code, desc) => {
    console.log('[renderer] 页面加载失败 ' + code + ' ' + desc);
  });
  launcher.on('log', (text) => {
    if (win && !win.isDestroyed()) win.webContents.send('launch:log', text);
  });
  launcher.on('exit', (code) => {
    if (win && !win.isDestroyed()) win.webContents.send('launch:exit', code);
  });
  // 启动后把遗留的崩溃 dump 推给渲染层，由主页面弹横幅引导「一键上报」
  win.webContents.on('did-finish-load', () => {
    const dumps = listCrashDumps();
    if (win && !win.isDestroyed()) win.webContents.send('app:crash-detected', dumps);
  });
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  /* Planet Minecraft 有 Cloudflare 防护：Electron 默认 UA 里带 "Electron/x.y"，
   * 会被判定为自动程序，导致「正在进行安全验证」无限循环。
   * 这里把该分区的 UA 换成与内置 Chromium 版本一致的普通 Chrome UA（去掉 Electron 段）。 */
  const pmcSession = session.fromPartition('persist:pmc');
  const chromeVer = (process.versions && process.versions.chrome) || '130.0.0.0';
  // UA 按真实平台生成（原先两处都写死 Windows，会在 macOS 上误报系统），
  // Chrome 版本仍取当前 Electron 内置版本，Windows 下的 UA 与原来完全一致。
  const chromeUa = platform.userAgent(undefined, undefined, chromeVer);
  pmcSession.setUserAgent(chromeUa);

  // 地图页 webview（partition persist:pmc）的下载：自动存到下载文件夹并通知渲染进程
  pmcSession.on('will-download', (event, item) => {
    const dir = app.getPath('downloads');
    const safe = String(item.getFilename() || 'download').replace(/[\\/:*?"<>|]/g, '_');
    const fp = path.join(dir, safe);
    item.setSavePath(fp);
    item.on('done', (e, state) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('maps:download-done', { ok: state === 'completed', path: fp, name: item.getFilename() });
      }
    });
  });

  // 陶瓦联机 webview 分区：同样用普通 Chrome UA（localhost 服务一般不在意 UA，但统一规避 Electron UA 潜在问题）
  const tcSession = session.fromPartition('persist:terracotta');
  tcSession.setUserAgent(chromeUa);

  migrateLegacyConfig();
  // 把启动器自管运行时目录加入 Java 搜索范围，下载安装后可直接被识别
  try {
    javaFinder.addJavaRoot(path.join(app.getPath('userData'), 'runtime'));
  } catch (e) { /* ignore */ }
  createWindow();
  // 自动备份（#13）：启动后延迟执行，按间隔备份目标版本，绝不阻塞启动
  scheduleAutoBackup();
  // 自动更新：打包后启动 3 秒后静默检查一次
  initUpdater();
  if (app.isPackaged) {
    setTimeout(() => {
      // 必须先 configureUpdaterFeed() 调 setFeedURL()，否则 clientPromise 为 null，
      // electron-updater 会退化去读 resources/app-update.yml（缺失则 ENOENT）
      if (!configureUpdaterFeed()) return;
      try { autoUpdater.checkForUpdates(); } catch (e) { console.error('[updater] 自动检查失败', e.message); }
    }, 3000);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- 自动更新（仅打包后生效） ---------------- */
/** 把更新状态推给所有窗口的渲染进程 */
function pushUpdater(payload) {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('updater:status', payload);
  });
}
/** 根据 config.updaterUrl 配置更新源；未配置或失败返回 null */
function configureUpdaterFeed() {
  const cfg = readConfig();
  // 未配置时使用默认更新源，保证开箱即可自动更新
  const raw = (cfg.updaterUrl || '').trim() || DEFAULT_UPDATER_URL;
  // GitHub Releases：用内置 github provider（自动找最新 release + 下载资产，公开仓库无需令牌）
  const m = raw.match(/github\.com\/([^\/\s?#]+)\/([^\/\s?#]+)/i);
  if (m) {
    const owner = m[1];
    let repo = m[2];
    if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
    try {
      autoUpdater.setFeedURL({ provider: 'github', owner, repo });
      return raw;
    } catch (e) {
      console.error('[updater] setFeedURL(github) 失败:', e.message);
      return null;
    }
  }
  // 其他静态地址：generic provider
  const url = raw.endsWith('/') ? raw : raw + '/';
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url });
    return url;
  } catch (e) {
    console.error('[updater] setFeedURL(generic) 失败:', e.message);
    return null;
  }
}
/** 绑定自动更新事件监听（只绑一次）。
 *  关键：无论启动时是否已配置地址都要先绑，否则事后保存 URL 再检查时，
 *  事件监听尚未注册，update-available / update-not-available 永远收不到，
 *  渲染端就会一直卡在「正在检查更新…」而无法刷新状态。 */
let updaterListenersBound = false;
function bindUpdaterListeners() {
  if (updaterListenersBound) return;
  updaterListenersBound = true;
  autoUpdater.autoDownload = false; // 先提示，用户确认后再下载
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) =>
    pushUpdater({ type: 'available', version: info.version, current: APP_VERSION })
  );
  autoUpdater.on('update-not-available', (info) =>
    pushUpdater({ type: 'not-available', version: info.version, current: APP_VERSION })
  );
  autoUpdater.on('download-progress', (p) =>
    pushUpdater({ type: 'progress', percent: p.percent || 0, transferred: p.transferred, total: p.total })
  );
  autoUpdater.on('update-downloaded', (info) =>
    pushUpdater({ type: 'downloaded', version: info.version })
  );
  autoUpdater.on('error', (e) => pushUpdater({ type: 'error', message: e && e.message ? e.message : String(e) }));
}

/** 注册自动更新（仅打包后调用） */
function initUpdater() {
  if (!app.isPackaged) return; // 开发模式不检查，避免误连
  bindUpdaterListeners(); // 无条件先绑监听（见上方说明）
  // 本机若配置了指向本地的不可靠代理（如 127.0.0.1:xxxx），
  // 会让 electron 网络层在更新检查时卡死；打包后强制走直连规避。
  const envProxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY ||
    process.env.http_proxy || process.env.https_proxy || '';
  if (envProxy && /127\.0\.0\.1|localhost|::1/.test(envProxy) && session && session.defaultSession) {
    session.defaultSession.setProxy({ proxyRules: 'direct://' }).catch(() => {});
  }
}

/* ---------------- IPC ---------------- */

ipcMain.handle('config:get', () => {
  const cfg = readConfig();
  if (!cfg.gameDir) cfg.gameDir = scanner.defaultGameDir();
  if (!cfg.maxMemory) cfg.maxMemory = 2048;
  if (!cfg.minMemory) cfg.minMemory = 512;
  if (!cfg.width) cfg.width = 854;
  if (!cfg.height) cfg.height = 480;
  if (!cfg.playerName) cfg.playerName = 'Player';
  if (!cfg.theme) cfg.theme = 'dark';
  if (cfg.accent === undefined) cfg.accent = '';
  if (!cfg.launcherTitle) cfg.launcherTitle = 'MC 启动器';
  if (cfg.easterEgg === undefined) cfg.easterEgg = false;
  if (!cfg.memoryMode) cfg.memoryMode = 'auto';
  if (!cfg.updaterUrl) cfg.updaterUrl = DEFAULT_UPDATER_URL;
  cfg.backup = mergeBackup(cfg);
  return cfg;
});

ipcMain.handle('config:set', (event, cfg) => {
  // 合并写入：界面只提交自己那部分字段，auth（正版账号）等必须保留
  const merged = Object.assign({}, readConfig(), cfg || {});
  const ok = writeConfig(merged);
  // 标题文字变化时同步更新真实窗口标题（任务栏）
  if (merged && merged.launcherTitle !== undefined && win && !win.isDestroyed()) {
    win.setTitle(merged.launcherTitle && merged.launcherTitle.trim() ? merged.launcherTitle.trim() : 'MC 启动器');
  }
  return ok;
});

/* 自动更新 IPC */
ipcMain.handle('updater:info', () => {
  const cfg = readConfig();
  return { current: APP_VERSION, url: (cfg.updaterUrl || '').trim(), packaged: app.isPackaged };
});
ipcMain.handle('updater:check', async () => {
  if (!app.isPackaged) return { ok: false, dev: true };
  if (!configureUpdaterFeed()) return { ok: false, noUrl: true };
  bindUpdaterListeners(); // 兜底：检查前再绑一次，确保事件必达渲染端
  try {
    const checkPromise = autoUpdater.checkForUpdates();
    // 超时兜底：网络卡死时也不让界面永久停在「正在检查更新…」
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('检查超时（15 秒内无响应，可能是网络或代理问题）')), 15000)
    );
    const r = await Promise.race([checkPromise, timeout]);
    return { ok: true, updateInfo: r ? r.updateInfo : null };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle('updater:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle('updater:quit-install', () => {
  try {
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('dir:default', () => scanner.defaultGameDir());

ipcMain.handle('dir:pick', async (event, current) => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择 ' + platform.gameDirName() + ' 游戏目录',
    defaultPath: current && fs.existsSync(current) ? current : scanner.defaultGameDir(),
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const normalized = scanner.normalizeGameDir(res.filePaths[0]);
  return { path: normalized, valid: scanner.looksLikeGameDir(normalized) };
});

ipcMain.handle('dir:open', async (event, dir) => {
  if (!dir || !fs.existsSync(dir)) return false;
  const result = await shell.openPath(dir);
  return result === '' || result === undefined;
});

ipcMain.handle('versions:list', (event, gameDir) => scanner.listVersions(gameDir));

ipcMain.handle('versions:check', (event, gameDir, versionId) => {
  try {
    return { ok: true, report: integrity.checkVersion(gameDir, versionId, {}) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('versions:clear-natives', (event, gameDir, versionId) => {
  try {
    const dir = path.join(gameDir, 'versions', versionId, 'natives');
    return { ok: true, cleared: clearNatives(dir) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('java:find', async (event, gameDir) => javaFinder.findJavaCandidates(gameDir, 12));

ipcMain.handle('java:info', async (event, javaPath) => javaFinder.getJavaInfo(javaPath));

ipcMain.handle('auth:offline', (event, playerName) => {
  try {
    return { ok: true, account: createOfflineAccount(playerName) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ---------------- 微软正版登录 ---------------- */

const msa = new MsaAuth();

function msaSend(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('auth:msa-event', payload);
}

msa.on('code', (d) => msaSend(Object.assign({ type: 'code' }, d)));
msa.on('live-url', (d) => msaSend(Object.assign({ type: 'live-url' }, d)));
msa.on('progress', (d) => msaSend(Object.assign({ type: 'progress' }, d)));
msa.on('error', (d) => msaSend(Object.assign({ type: 'error' }, d)));
msa.on('success', (d) => {
  // 登录成功：持久化账号
  const cfg = readConfig();
  cfg.auth = Object.assign({}, cfg.auth, { mode: 'msa', msa: d.account });
  writeConfig(cfg);
  msaSend(Object.assign({ type: 'success' }, d));
});

/** 读取已保存的登录态 */
function savedAuth() {
  const cfg = readConfig();
  return {
    mode: (cfg.auth && cfg.auth.mode) || 'offline',
    playerName: cfg.playerName || 'Player',
    msaClientId: (cfg.auth && cfg.auth.msaClientId) || '',
    msa: (cfg.auth && cfg.auth.msa) || null,
  };
}

ipcMain.handle('auth:state', () => savedAuth());

ipcMain.handle('auth:msa-start', async () => {
  const res = await msa.startLiveLogin();
  return { ok: res.ok, error: res.error };
});

ipcMain.handle('auth:msa-submit-code', async (event, code) => {
  const res = await msa.submitLiveCode(code);
  return { ok: res.ok, error: res.error, hint: res.hint };
});

ipcMain.handle('auth:msa-cancel', () => {
  msa.cancel();
  return true;
});

ipcMain.handle('auth:msa-logout', () => {
  msa.cancel();
  const cfg = readConfig();
  cfg.auth = Object.assign({}, cfg.auth, { mode: 'offline', msa: null });
  writeConfig(cfg);
  return true;
});

ipcMain.handle('auth:msa-refresh', async () => {
  const { msa: account } = savedAuth();
  if (!account) return { ok: false, error: '尚未登录' };
  const res = await msa.loginWithRefreshToken(account.clientId, account.refreshToken);
  if (res.ok) {
    const cfg = readConfig();
    cfg.auth = Object.assign({}, cfg.auth, { mode: 'msa', msa: res.account });
    writeConfig(cfg);
  }
  return res;
});

ipcMain.handle('java:recommend', (event, gameDir, versionId) => {
  try {
    const { loadProfile } = require('./src/version-profile');
    const profile = loadProfile(gameDir, versionId);
    return { ok: true, major: javaFinder.recommendJavaMajor(profile) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function javaSend(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 无合适 Java 时：确定该版本所需 major，已装则复用，否则自动下载安装 */
ipcMain.handle('java:auto-fix', async (event, opts) => {
  opts = opts || {};
  let major;
  try {
    const { loadProfile } = require('./src/version-profile');
    major = javaFinder.recommendJavaMajor(loadProfile(opts.gameDir, opts.versionId));
  } catch (e) {
    return { ok: false, error: '无法确定所需 Java 版本：' + e.message };
  }
  const cands = await javaFinder.findJavaCandidates(opts.gameDir, 12);
  const hit = cands.find((c) => c.major === major);
  if (hit) return { ok: true, already: true, javaPath: hit.path, major };
  const runtimeDir = path.join(app.getPath('userData'), 'runtime');
  const r = await javadl.installJava(major, runtimeDir, {
    onLog: (t) => javaSend('java:log', { text: t }),
    onProgress: (p) => javaSend('java:progress', Object.assign({ major }, p)),
  });
  return Object.assign({ major }, r);
});

/** 手动下载指定 major 的 Java */
ipcMain.handle('java:download', async (event, opts) => {
  const major = opts && opts.major;
  if (!major) return { ok: false, error: '未指定 Java 大版本' };
  const runtimeDir = path.join(app.getPath('userData'), 'runtime');
  const r = await javadl.installJava(major, runtimeDir, {
    onLog: (t) => javaSend('java:log', { text: t }),
    onProgress: (p) => javaSend('java:progress', Object.assign({ major }, p)),
  });
  return Object.assign({ major }, r);
});

ipcMain.handle('java:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: platform.javaPickTitle(),
    properties: ['openFile'],
    // macOS 的 java 没有扩展名，写死 ['exe'] 会让用户根本选不到文件
    filters: platform.javaPickFilters().concat([{ name: '全部文件', extensions: ['*'] }]),
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

/** S2 / N3 守卫：把提示写进启动日志面板，不额外弹窗打断 */
function guardLog(msg) {
  try { if (win && !win.isDestroyed()) win.webContents.send('launch:log', msg); } catch (e) { /* ignore */ }
}

/**
 * 启动前的跨版本开档守卫。
 * 评估永远执行（纯只读，用于积累「上次成功打开版本」）；只有开启开关且检出 high 风险才弹窗。
 * 任何异常 / 快照失败都只降级为提示，绝不阻塞启动（第六章硬边界）。
 */
async function guardBeforeLaunch(opts) {
  let ev;
  try {
    ev = worldguard.evaluate(opts);
  } catch (e) {
    return { ok: true, degraded: e && e.message ? e.message : '评估异常' };
  }
  if (!ev.ok) {
    guardLog('[存档守卫] 评估跳过：' + ev.error);
    return { ok: true, warnings: [ev.error] };
  }
  if (!opts.enabled || !ev.risky.length) return { ok: true, evaluation: ev, warnings: [] };

  const boxOpts = {
    type: 'warning',
    buttons: ['先做快照再启动', '复制存档副本再启动', '取消启动'],
    defaultId: 0,
    cancelId: 2,
    title: '跨版本开档提醒',
    message: '检测到 ' + ev.risky.length + ' 个存档的打开版本与上次不同',
    detail: ev.risky.slice(0, 6).map((i) => '· ' + i.name + '：' + i.message).join('\n') +
      (ev.risky.length > 6 ? '\n…另有 ' + (ev.risky.length - 6) + ' 个' : '') +
      '\n\n建议先留一份可回退的副本，再启动游戏。',
    checkboxLabel: '以后不再提醒（可在「设置 → 存档安全」重新开启）',
    checkboxChecked: false,
    noLink: true,
  };
  let choice;
  try {
    const parent = (win && !win.isDestroyed()) ? win : null;
    choice = parent ? await dialog.showMessageBox(parent, boxOpts) : await dialog.showMessageBox(boxOpts);
  } catch (e) {
    guardLog('[存档守卫] 对话框异常，按无风险继续：' + (e && e.message ? e.message : ''));
    return { ok: true, evaluation: ev, warnings: ['对话框异常，已跳过提醒'] };
  }
  if (choice.checkboxChecked) {
    try { const c = readConfig(); c.worldGuard = false; writeConfig(c); } catch (e) { /* ignore */ }
  }
  if (choice.response === 2) {
    guardLog('[存档守卫] 用户取消启动（跨版本风险）');
    return { ok: false, cancelled: true, error: '已取消启动：检测到跨版本开档风险' };
  }
  const folders = ev.risky.map((i) => i.folder);
  const action = choice.response === 0 ? 'snapshot' : 'copy';
  let results;
  try {
    results = action === 'snapshot' ? worldguard.snapshot(ev.savesDir, folders) : worldguard.copy(ev.savesDir, folders);
  } catch (e) {
    return { ok: true, evaluation: ev, warnings: ['快照/复制执行异常：' + (e && e.message ? e.message : '')] };
  }
  const okCount = results.filter((r) => r.ok).length;
  const warnings = results.filter((r) => !r.ok).map((r) => r.folder + '：' + r.error);
  guardLog('[存档守卫] ' + (action === 'snapshot' ? '已创建快照' : '已复制升级前副本') +
    ' ' + okCount + '/' + folders.length + ' 个' + (warnings.length ? '（有失败项，仅提示不阻止启动）' : ''));
  return { ok: true, evaluation: ev, action, results, warnings };
}

ipcMain.handle('launch:start', async (event, cfg) => {
  if (launcher.running) return { ok: false, error: '已有 Minecraft 正在运行' };
  try {
    const stored = readConfig();
    // S2 / N3：跨版本开档守卫（评估只读；有风险时由用户决定快照 / 复制副本 / 取消）
    const guard = await guardBeforeLaunch({
      gameDir: stored.gameDir || cfg.gameDir,
      versionId: cfg.versionId,
      isolated: !!(stored.versionSettings && cfg.versionId && (stored.versionSettings[cfg.versionId] || {}).isolated),
      enabled: stored.worldGuard !== false,
    });
    if (!guard.ok) return { ok: false, error: guard.error, cancelled: !!guard.cancelled };

    // 正版登录：先确保 mc token 有效（过期会自动用 refresh token 刷新）
    let account = null;
    if (cfg.authMode === 'msa') {
      const { msa: saved } = savedAuth();
      if (!saved) return { ok: false, error: '尚未登录微软账号，请先在「启动」页完成正版登录' };
      account = await msa.ensureFresh(saved);
      const c = readConfig();
      c.auth = Object.assign({}, c.auth, { mode: 'msa', msa: account });
      writeConfig(c);
    }

    // 合并「版本管理」页设置的每版本覆盖参数（留空则沿用全局）
    const vs = (stored.versionSettings && cfg.versionId && stored.versionSettings[cfg.versionId]) || {};
    const instanceDir = vs.isolated ? path.join(stored.gameDir || cfg.gameDir, 'instances', cfg.versionId) : null;
    // 内存解析：版本级覆盖 > 手动模式取配置 > 自动模式按物理内存算
    const memMode = stored.memoryMode === 'manual' ? 'manual' : 'auto';
    const auto = autoMemoryMB();
    const minMemory = vs.minMemory || (memMode === 'manual' ? (cfg.minMemory || 512) : auto.minMB);
    const maxMemory = vs.maxMemory || (memMode === 'manual' ? (cfg.maxMemory || 2048) : auto.maxMB);
    const effective = Object.assign({}, cfg, {
      javaPath: vs.javaPath || cfg.javaPath,
      minMemory,
      maxMemory,
      width: vs.width || cfg.width,
      height: vs.height || cfg.height,
      fullscreen: vs.fullscreen != null ? !!vs.fullscreen : cfg.fullscreen,
      extraJvmArgs: vs.extraJvmArgs || cfg.extraJvmArgs,
      instanceDir,
    });

    const prepared = await prepareLaunch(Object.assign({}, effective, { account }), (msg) => {
      if (win && !win.isDestroyed()) win.webContents.send('launch:log', msg);
    });
    const res = launcher.start(prepared.command, prepared.args, prepared.cwd);
    if (!res.ok) return res;
    // 启动成功后才记录状态：启动失败不应污染「上次成功打开的版本」判据
    try {
      if (guard && guard.evaluation && guard.evaluation.items && guard.evaluation.items.length) {
        worldguard.record(guard.evaluation.statePath, guard.evaluation.items);
      }
    } catch (e) { /* 状态记录失败绝不影响已启动的游戏 */ }
    return {
      ok: true,
      pid: res.pid,
      command: prepared.command,
      args: prepared.args,
      jarPath: prepared.jarPath,
      nativesDir: prepared.nativesDir,
      assets: prepared.assets,
      classpathCount: prepared.classpathCount,
      missingNatives: prepared.missingNatives,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch:stop', () => launcher.stop());

ipcMain.handle('launch:running', () => launcher.running);

/* ---------------- 下载 / 安装 ---------------- */

const dlState = { cancel: false };

function dlSend(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle('dl:mirrors', () => MIRRORS);

ipcMain.handle('dl:manifest', async (event, mirrorIds, includeUnlisted) => {
  const res = await installer.loadManifest(mirrorIds, includeUnlisted, (t) => dlSend('dl:log', t));
  return {
    ok: res.ok,
    error: res.error,
    source: res.source,
    versions: (res.versions || []).map((v) => ({
      id: v.id,
      type: v.type,
      releaseTime: v.releaseTime || '',
      unlisted: !!v.unlisted,
    })),
  };
});

ipcMain.handle('dl:install', async (event, opts) => {
  dlState.cancel = false;
  try {
    const res = await installer.installVersion({
      gameDir: opts.gameDir,
      versionId: opts.versionId,
      mirrorIds: opts.mirrorIds,
      skipAssets: !!opts.skipAssets,
      concurrency: Number(opts.concurrency) || 32,
      includeUnlisted: !!opts.includeUnlisted,
      onLog: (t) => dlSend('dl:log', t),
      onProgress: (p) => dlSend('dl:progress', p),
      shouldCancel: () => dlState.cancel,
    });
    dlSend('dl:done', res);
    return res;
  } catch (e) {
    const res = { ok: false, error: e.message };
    dlSend('dl:done', res);
    return res;
  }
});

ipcMain.handle('dl:cancel', () => {
  dlState.cancel = true;
  return true;
});

ipcMain.handle('dl:loaders', async (event, kind, mcVersion, mirrorIds) => {
  let res;
  if (kind === 'fabric') res = await loaders.listFabric(mcVersion, mirrorIds);
  else if (kind === 'forge') res = await loaders.listForge(mcVersion, mirrorIds);
  else if (kind === 'neoforge') res = await loaders.listNeoForge(mcVersion, mirrorIds);
  else if (kind === 'optifine') res = await loaders.listOptiFine(mcVersion, mirrorIds);
  else return { ok: false, error: '未知加载器类型：' + kind, versions: [] };
  return {
    ok: res.ok,
    error: res.error,
    source: res.source,
    versions: (res.versions || []).map((v) => ({
      version: v.version,
      raw: v.raw,
      stable: v.stable,
      installerPath: v.installerPath,
      filename: v.filename,
      forge: v.forge,
      type: v.type,
      patch: v.patch,
    })),
  };
});

ipcMain.handle('dl:install-loader', async (event, opts) => {
  dlState.cancel = false;
  const base = {
    gameDir: opts.gameDir,
    mirrorIds: opts.mirrorIds,
    javaPath: opts.javaPath,
    onLog: (t) => dlSend('dl:log', t),
    onProgress: (p) => dlSend('dl:progress', p),
    shouldCancel: () => dlState.cancel,
    concurrency: Number(opts.concurrency) || 32,
  };
  let res;
  try {
    if (opts.kind === 'fabric') {
      res = await loaders.installFabric(Object.assign(base, { gameVersion: opts.gameVersion, loaderVersion: opts.loaderVersion }));
    } else if (opts.kind === 'forge') {
      res = await loaders.installForgeLike(
        Object.assign(base, {
          kind: 'Forge',
          rawVersion: opts.rawVersion,
          installerUrl: loaders.forgeInstallerUrl(opts.rawVersion),
          fileName: `forge-${opts.rawVersion}-installer.jar`,
        })
      );
    } else if (opts.kind === 'neoforge') {
      const roots = require('./src/mirrors').resolveMirrors(opts.mirrorIds).filter((m) => m.apiRoot);
      const root = roots[0] ? roots[0].apiRoot : 'https://maven.minecraftforge.net';
      const path1 = opts.installerPath
        ? root + opts.installerPath
        : `https://maven.minecraftforge.net/net/neoforged/forge/${opts.gameVersion}-${opts.version}/forge-${opts.gameVersion}-${opts.version}-installer.jar`;
      res = await loaders.installForgeLike(
        Object.assign(base, {
          kind: 'NeoForge',
          rawVersion: opts.version,
          installerUrl: path1,
          fileName: path.basename(new URL(path1).pathname),
        })
      );
    } else if (opts.kind === 'optifine') {
      res = await loaders.installOptiFine({
        gameDir: opts.gameDir,
        mcVersion: opts.gameVersion,
        type: opts.type,
        patch: opts.patch,
        forge: opts.forge,
        filename: opts.filename,
        comboForge: !!opts.comboForge,
        mirrorIds: opts.mirrorIds,
        javaPath: opts.javaPath,
        onLog: base.onLog,
        onProgress: base.onProgress,
        timeoutMs: opts.timeoutMs,
      });
    } else {
      res = { ok: false, error: '未知加载器类型：' + opts.kind };
    }
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  dlSend('dl:done', res);
  return res;
});

ipcMain.handle('dl:run-installer', async (event, jarPath, gameDir, javaPath) => {
  const before = loaders.snapshotVersions(gameDir);
  const run = await loaders.runInstallerJar({
    jarPath,
    gameDir,
    javaPath,
    onLog: (t) => dlSend('dl:log', t),
  });
  const added = loaders.snapshotVersions(gameDir).filter((d) => !before.includes(d));
  return { ok: run.ok, timeout: run.timeout, exitCode: run.exitCode, addedVersions: added };
});

/* ---------------- 模组下载（Modrinth） ---------------- */

const modCancels = {};
function modSend(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle('mods:filters', async () => {
  try {
    return { ok: true, ...(await modplatforms.getFilters()) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mods:search', async (event, opts) => {
  try {
    return { ok: true, ...(await modplatforms.searchModrinth(opts || {})) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* 模组详情：项目信息 + 全量版本 + 前置模组 */
ipcMain.handle('mods:detail', async (event, projectId) => {
  try {
    return { ok: true, ...(await modplatforms.getModDetail(projectId)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mods:download', async (event, opts) => {
  const taskId = opts.taskId || 't' + Date.now() + Math.random().toString(16).slice(2);
  modCancels[taskId] = false;
  try {
    // versionId 存在时（详情页指定）严格用该版本，否则按筛选项回退选最新
    const resolved = await modplatforms.resolveDownload(opts.projectId, {
      gameVersion: opts.gameVersion || '',
      loader: opts.loader || '',
      versionId: opts.versionId || '',
    });
    const payload = {
      taskId,
      name: resolved.file.filename,
      versionName: resolved.versionName,
      loaders: resolved.loaders,
      gameVersions: resolved.gameVersions,
    };
    modSend('mods:progress', Object.assign({ percent: 0, loaded: 0, total: 0 }, payload));
    const res = await modplatforms.downloadFileWithProgress(resolved.file, opts.destDir, {
      onProgress: (p) => modSend('mods:progress', Object.assign({}, payload, p)),
      onLog: (t) => modSend('mods:log', { taskId, text: t }),
      shouldCancel: () => modCancels[taskId],
    });
    // 安装成功：写 sidecar 元数据，供「Mod 更新检测」可靠识别由本启动器安装的 mod
    if (res.ok && res.dest) {
      try {
        const base = path.basename(res.dest).replace(/\.(jar|zip)$/i, '');
        modupdate.recordMod(opts.destDir, base, {
          projectId: opts.projectId,
          slug: opts.projectId,
          versionId: resolved.versionId,
          versionNumber: resolved.versionNumber || resolved.versionName,
          loader: (resolved.loaders || [])[0] || '',
          gameVersions: resolved.gameVersions || [],
        });
      } catch (e) {
        /* sidecar 写入失败不影响下载结果 */
      }
    }
    const done = {
      ok: res.ok,
      skipped: !!res.skipped,
      cancelled: !!res.cancelled,
      dest: res.dest,
      error: res.error,
      taskId,
      name: resolved.file.filename,
    };
    modSend('mods:done', done);
    return done;
  } catch (err) {
    const done = { ok: false, error: err.message, taskId, name: opts.name || '' };
    modSend('mods:done', done);
    return done;
  } finally {
    delete modCancels[taskId];
  }
});

ipcMain.handle('mods:cancel', (event, taskId) => {
  if (taskId) modCancels[taskId] = true;
  return true;
});

/* ---------------- 版本管理页：Mod 更新检测（A 功能） ---------------- */

ipcMain.handle('version:mods-check-updates', async (event, gameDir, versionId) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const res = scanner.listVersions(gameDir);
    const meta = (res.versions || []).find((v) => v.id === versionId) || {};
    return await modupdate.checkUpdates({ gameDir, versionId, isolated, versionMeta: meta });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:mods-update', async (event, opts) => {
  const taskId = opts.taskId || 'upd' + Date.now() + Math.random().toString(16).slice(2);
  const gameDir = opts.gameDir;
  const versionId = opts.versionId;
  const modName = opts.modName; // 待替换的旧文件名（含 .jar / .jar.disabled）
  const projectId = opts.projectId;
  const mrVersionId = opts.mrVersionId;
  if (!gameDir || !versionId || !projectId || !mrVersionId) {
    return { ok: false, error: '参数不完整', taskId };
  }
  const cfg = readConfig();
  const settings = cfg.versionSettings || {};
  const isolated = !!(settings[versionId] && settings[versionId].isolated);
  const modsDir = instance.modsDirFor(gameDir, versionId, isolated);
  modCancels[taskId] = false;
  try {
    const resolved = await modplatforms.resolveDownload(projectId, { versionId: mrVersionId });
    const payload = {
      taskId,
      name: resolved.file.filename,
      versionName: resolved.versionName,
      loaders: resolved.loaders,
      gameVersions: resolved.gameVersions,
    };
    modSend('mods:progress', Object.assign({ percent: 0, loaded: 0, total: 0 }, payload));
    const res = await modplatforms.downloadFileWithProgress(resolved.file, modsDir, {
      onProgress: (p) => modSend('mods:progress', Object.assign({}, payload, p)),
      onLog: (t) => modSend('mods:log', { taskId, text: t }),
      shouldCancel: () => modCancels[taskId],
    });
    if (!res.ok) {
      const done = { ok: false, cancelled: !!res.cancelled, error: res.error, taskId };
      modSend('mods:done', done);
      return done;
    }
    // 下载成功：删除旧的 mod 文件（含 .disabled 变体），并更新 sidecar
    let removed = [];
    try {
      const baseOld = modName.replace(/\.disabled$/i, '').replace(/\.(jar|zip)$/i, '');
      const newPath = path.resolve(res.dest);
      ['', '.disabled'].forEach((suf) => {
        const cand = path.join(modsDir, baseOld + '.jar' + suf);
        // 关键：新版文件名可能和旧版完全一样，此时绝不能删（会把刚下载的删掉）
        if (path.resolve(cand) === newPath) return;
        if (fs.existsSync(cand)) { fs.unlinkSync(cand); removed.push(path.basename(cand)); }
      });
      modupdate.removeMod(modsDir, baseOld);
      const baseNew = path.basename(res.dest).replace(/\.(jar|zip)$/i, '');
      modupdate.recordMod(modsDir, baseNew, {
        projectId,
        slug: projectId,
        versionId: resolved.versionId,
        versionNumber: resolved.versionNumber || resolved.versionName,
        loader: (resolved.loaders || [])[0] || '',
        gameVersions: resolved.gameVersions || [],
      });
    } catch (e) {
      /* 删旧文件/写 sidecar 失败不阻断成功结果 */
    }
    const done = { ok: true, dest: res.dest, removed, taskId, name: resolved.file.filename };
    modSend('mods:done', done);
    return done;
  } catch (err) {
    const done = { ok: false, error: err.message, taskId };
    modSend('mods:done', done);
    return done;
  } finally {
    delete modCancels[taskId];
  }
});

/* ---------------- 工具箱：任意链接下载（#9） ---------------- */
const toolCancels = {};

function safeFileName(s) {
  return String(s || 'download').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, 'download');
}

ipcMain.handle('tools:download-url', async (event, opts) => {
  const taskId = opts.taskId || 'tool' + Date.now() + Math.random().toString(16).slice(2);
  toolCancels[taskId] = false;
  let filename = opts.filename && opts.filename.trim() ? safeFileName(opts.filename.trim()) : '';
  if (!filename) {
    try {
      const u = new URL(opts.url);
      const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      filename = safeFileName(seg) || 'download';
    } catch (e) {
      filename = 'download';
    }
  }
  const file = { url: opts.url, filename, size: -1, sha1: null };
  const payload = { taskId, name: filename };
  try {
    const res = await modplatforms.downloadFileWithProgress(file, opts.destDir, {
      onProgress: (p) => {
        if (win && !win.isDestroyed()) win.webContents.send('tools:progress', Object.assign({}, payload, p));
      },
      onLog: (t) => {
        if (win && !win.isDestroyed()) win.webContents.send('tools:log', { taskId, text: t });
      },
      shouldCancel: () => toolCancels[taskId],
    });
    const done = {
      ok: res.ok,
      skipped: !!res.skipped,
      cancelled: !!res.cancelled,
      dest: res.dest,
      error: res.error,
      taskId,
      name: filename,
    };
    if (win && !win.isDestroyed()) win.webContents.send('tools:done', done);
    return done;
  } catch (err) {
    const done = { ok: false, error: err.message, taskId, name: filename };
    if (win && !win.isDestroyed()) win.webContents.send('tools:done', done);
    return done;
  } finally {
    delete toolCancels[taskId];
  }
});

ipcMain.handle('tools:cancel', (event, taskId) => {
  if (taskId) toolCancels[taskId] = true;
  return true;
});

/* ---------------- 工具箱：整合包导入 / 导出（#4 / #5） ---------------- */
const modpackCancels = {};

function mpSend(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle('modpack:import', async (event, opts) => {
  const taskId = opts.taskId || 'mp' + Date.now();
  modpackCancels[taskId] = false;
  const payload = { taskId };
  try {
    const r = await modpack.importModpack(opts.zipFilePath, opts.gameDir, opts, {
      onLog: (t) => mpSend('modpack:log', Object.assign({ taskId }, { text: t })),
      onProgress: (p) => mpSend('modpack:progress', Object.assign({}, payload, p)),
      shouldCancel: () => modpackCancels[taskId],
    });
    const done = Object.assign({ taskId, ok: true }, r);
    mpSend('modpack:done', done);
    return done;
  } catch (err) {
    const done = { taskId, ok: false, error: err.message };
    mpSend('modpack:done', done);
    return done;
  } finally {
    delete modpackCancels[taskId];
  }
});

ipcMain.handle('modpack:export', async (event, opts) => {
  const taskId = opts.taskId || 'mpe' + Date.now();
  const payload = { taskId };
  try {
    const outDir = app.getPath('downloads');
    const r = await modpack.exportModpack(outDir, opts.gameDir, opts.source, opts, {
      onLog: (t) => mpSend('modpack:log', Object.assign({ taskId }, { text: t })),
      onProgress: (p) => mpSend('modpack:progress', Object.assign({}, payload, p)),
      shouldCancel: () => modpackCancels[taskId],
    });
    const done = Object.assign({ taskId, ok: true }, r);
    mpSend('modpack:done', done);
    return done;
  } catch (err) {
    const done = { taskId, ok: false, error: err.message };
    mpSend('modpack:done', done);
    return done;
  }
});

ipcMain.handle('modpack:cancel', (event, taskId) => {
  if (taskId) modpackCancels[taskId] = true;
  return true;
});

/* ---------------- Modrinth 资源包 / 光影（通用，按 projectType） ---------------- */
const mrCancels = {};

function mrSend(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle('mr:filters', async (event, projectType) => {
  try {
    return { ok: true, ...(await modplatforms.getFilters(projectType)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mr:search', async (event, opts) => {
  try {
    return { ok: true, ...(await modplatforms.searchModrinth(opts || {})) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mr:download', async (event, opts) => {
  const taskId = opts.taskId || 'mr' + Date.now() + Math.random().toString(16).slice(2);
  mrCancels[taskId] = false;
  try {
    const resolved = await modplatforms.resolveDownload(opts.projectId, {
      gameVersion: opts.gameVersion || '',
      loader: opts.loader || '',
    });
    const payload = {
      taskId,
      name: resolved.file.filename,
      versionName: resolved.versionName,
      loaders: resolved.loaders,
      gameVersions: resolved.gameVersions,
    };
    mrSend('mr:progress', Object.assign({ percent: 0, loaded: 0, total: 0 }, payload));
    const res = await modplatforms.downloadFileWithProgress(resolved.file, opts.destDir, {
      onProgress: (p) => mrSend('mr:progress', Object.assign({}, payload, p)),
      onLog: (t) => mrSend('mr:log', { taskId, text: t }),
      shouldCancel: () => mrCancels[taskId],
    });
    const done = {
      ok: res.ok,
      skipped: !!res.skipped,
      cancelled: !!res.cancelled,
      dest: res.dest,
      error: res.error,
      taskId,
      name: resolved.file.filename,
    };
    mrSend('mr:done', done);
    return done;
  } catch (err) {
    const done = { ok: false, error: err.message, taskId, name: opts.name || '' };
    mrSend('mr:done', done);
    return done;
  } finally {
    delete mrCancels[taskId];
  }
});

ipcMain.handle('mr:cancel', (event, taskId) => {
  if (taskId) mrCancels[taskId] = true;
  return true;
});

/* ---------------- 地图本地安装（Planet Minecraft 下载的 zip → saves/） ---------------- */
function resolveSavesDir(gameDir, target) {
  if (!target || target === 'global') return path.join(gameDir, 'saves');
  if (target.indexOf('ver:') === 0) {
    const id = target.slice(4);
    const cfg = readConfig();
    const iso = !!(cfg.versionSettings && cfg.versionSettings[id] && cfg.versionSettings[id].isolated);
    return iso ? path.join(gameDir, 'instances', id, 'saves') : path.join(gameDir, 'versions', id, 'saves');
  }
  return path.join(gameDir, 'saves');
}

ipcMain.handle('maps:install-zip', async (event, opts) => {
  try {
    const { zipFilePath, gameDir, target } = opts || {};
    if (!gameDir) return { ok: false, error: '未设置游戏目录' };
    const savesDir = resolveSavesDir(gameDir, target);
    return Object.assign({ ok: true }, maps.installWorldZip(zipFilePath, savesDir));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ---------------- 单版本实例管理 ---------------- */

function withConfigVersionSettings() {
  const cfg = readConfig();
  if (!cfg.versionSettings) cfg.versionSettings = {};
  return cfg;
}

ipcMain.handle('version:settings', () => {
  const cfg = readConfig();
  return cfg.versionSettings || {};
});

ipcMain.handle('version:set-settings', (event, versionId, patch) => {
  if (!versionId) return { ok: false, error: '缺少版本 id' };
  const cfg = withConfigVersionSettings();
  const cur = cfg.versionSettings[versionId] || {};
  cfg.versionSettings[versionId] = Object.assign({}, cur, patch || {});
  writeConfig(cfg);
  return { ok: true, settings: cfg.versionSettings[versionId] };
});

/** 给模组安装页用的：每个版本的「有效模组目录」+ 是否隔离 */
ipcMain.handle('version:targets', async (event, gameDir) => {
  const cfg = readConfig();
  const settings = cfg.versionSettings || {};
  const res = scanner.listVersions(gameDir);
  const versions = res.versions || [];
  // 与版本管理页 / 启动页保持一致：隐藏「被加载器版本继承的父版本」
  // （如 1.20.1 之于 fabric-loader-x-1.20.1）。它们只是加载器的依赖，不是可单独
  // 启动 / 装模的独立版本；若作为模组安装位置列出，用户装到父版本后加载器版并不会加载。
  const inheritedParents = new Set(versions.filter((v) => v.inheritsFrom).map((v) => v.inheritsFrom));
  return versions
    .filter((v) => !(!v.inheritsFrom && inheritedParents.has(v.id)))
    .map((v) => {
      const isolated = !!(settings[v.id] && settings[v.id].isolated);
      return {
        id: v.id,
        isolated,
        modsDir: instance.modsDirFor(gameDir, v.id, isolated),
        hasJar: !!v.hasJar,
      };
    });
});

ipcMain.handle('version:detail', async (event, gameDir, versionId) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const res = scanner.listVersions(gameDir);
    const meta = (res.versions || []).find((v) => v.id === versionId) || {};
    return { ok: true, ...instance.detail(gameDir, versionId, isolated, meta) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:mods', (event, gameDir, versionId) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = instance.modsDirFor(gameDir, versionId, isolated);
    return { ok: true, modsDir: dir, mods: instance.listMods(dir) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:mod-toggle', (event, gameDir, versionId, name) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = instance.modsDirFor(gameDir, versionId, isolated);
    return Object.assign({ ok: true }, instance.toggleMod(dir, name));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:mod-delete', (event, gameDir, versionId, name) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = instance.modsDirFor(gameDir, versionId, isolated);
    return Object.assign({ ok: true }, instance.deleteFileSafe(dir, name));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:worlds', (event, gameDir, versionId) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = instance.savesDirFor(gameDir, versionId, isolated);
    return { ok: true, savesDir: dir, worlds: instance.listWorlds(dir) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ROADMAP S1 / N12：批量读取世界存档卡片数据（纯本地、只读，不写任何世界文件）。
// folders 支持单个字符串或数组；上限 200 个，防止一次 IPC 拉爆主进程。
ipcMain.handle('world:info', (event, gameDir, versionId, folders) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = instance.savesDirFor(gameDir, versionId, isolated);
    const list = (Array.isArray(folders) ? folders : (folders == null ? [] : [folders]))
      .slice(0, 200)
      .map((f) => String(f));
    return { ok: true, savesDir: dir, items: list.map((f) => instance.worldInfo(dir, f)) };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
});

// ROADMAP S2 / N1：冒险日记（只读日志尾部，纯本地，不返回日志原文）
ipcMain.handle('world:timeline', (event, gameDir, versionId) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    return timeline.readTimeline({ gameDir: gameDir || cfg.gameDir, versionId, isolated });
  } catch (e) {
    return { ok: false, error: e.message, events: [], sessions: [], sources: [] };
  }
});

ipcMain.handle('version:world-open', (event, gameDir, versionId, folder) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = path.join(instance.savesDirFor(gameDir, versionId, isolated), folder);
    if (!fs.existsSync(dir)) return { ok: false, error: '世界不存在' };
    return { ok: true, opened: shell.openPath(dir) === '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:world-backup', (event, gameDir, versionId, folder) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const savesDir = instance.savesDirFor(gameDir, versionId, isolated);
    return Object.assign({ ok: true }, instance.backupWorld(savesDir, folder));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:world-delete', (event, gameDir, versionId, folder) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = path.join(instance.savesDirFor(gameDir, versionId, isolated), folder);
    if (!fs.existsSync(dir)) return { ok: false, error: '世界不存在' };
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:resourcepacks', (event, gameDir, versionId) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = instance.resourcepacksDirFor(gameDir, versionId, isolated);
    const txt = instance.optionsTxtFor(gameDir, versionId, isolated);
    return { ok: true, resourcepacksDir: dir, packs: instance.listResourcePacks(dir, txt) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:rp-toggle', (event, gameDir, versionId, id, enable) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const txt = instance.optionsTxtFor(gameDir, versionId, isolated);
    return Object.assign({ ok: true }, instance.setResourcePackEnabled(txt, id, !!enable));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:rp-delete', (event, gameDir, versionId, name) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = instance.resourcepacksDirFor(gameDir, versionId, isolated);
    return Object.assign({ ok: true }, instance.deleteFileSafe(dir, name));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:screenshots', (event, gameDir, versionId) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = instance.screenshotsDirFor(gameDir, versionId, isolated);
    return { ok: true, screenshotsDir: dir, screenshots: instance.listScreenshots(dir) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:ss-open', (event, gameDir, versionId, name) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const fp = path.join(instance.screenshotsDirFor(gameDir, versionId, isolated), name);
    if (!fs.existsSync(fp)) return { ok: false, error: '截图不存在' };
    return { ok: true, opened: shell.openPath(fp) === '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:ss-delete', (event, gameDir, versionId, name) => {
  try {
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const dir = instance.screenshotsDirFor(gameDir, versionId, isolated);
    return Object.assign({ ok: true }, instance.deleteFileSafe(dir, name));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:backup', (event, gameDir, versionId) => {
  try {
    return Object.assign({ ok: true }, instance.backupVersion(gameDir, versionId));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:delete', (event, gameDir, versionId) => {
  try {
    return Object.assign({ ok: true }, instance.deleteVersion(gameDir, versionId));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ---------------- 自动备份（#13） ---------------- */
ipcMain.handle('version:backups-list', (event, gameDir, versionId) => {
  try {
    return Object.assign({ ok: true }, instance.listAutoBackups(gameDir, versionId));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('version:backup-restore', (event, gameDir, versionId, opts) => {
  try {
    opts = opts || {};
    const cfg = readConfig();
    const settings = cfg.versionSettings || {};
    const isolated = !!(settings[versionId] && settings[versionId].isolated);
    const savesDir = instance.savesDirFor(gameDir, versionId, isolated);
    let dest;
    if (opts.scope === 'version') {
      dest = gameDir; // zip 内根为 versions/<id> 与 instances/<id>，直接释回 gameDir
    } else {
      const folder = opts.folder || '';
      if (!folder) return { ok: false, error: '缺少世界名' };
      dest = opts.mode === 'copy'
        ? path.join(savesDir, folder + '-恢复-' + bkStamp())
        : path.join(savesDir, folder);
    }
    zip.extractAll(opts.zipPath, dest);
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('backup:run-now', async () => {
  try {
    return await runAutoBackup({ force: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ---------------- 窗口控制（自定义标题栏） ---------------- */

ipcMain.handle('win:minimize', () => {
  if (win) win.minimize();
});

ipcMain.handle('win:toggle-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.handle('win:close', () => {
  if (win) win.close();
});

ipcMain.handle('app:info', () => ({
  version: APP_VERSION,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
}));

ipcMain.handle('app:auto-memory', () => autoMemoryMB());

ipcMain.handle('app:downloads', () => {
  try { return app.getPath('downloads'); } catch (e) { return ''; }
});

ipcMain.handle('app:open-external', async (event, url) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return false;
    await shell.openExternal(url);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('app:open-path', async (event, dir) => {
  try {
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: '路径不存在' };
    const r = await shell.openPath(dir);
    return { ok: r === '' || r === undefined, error: r || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** 跨进程可靠写入系统剪贴板（绕过渲染层剪贴板权限问题，最稳） */
ipcMain.handle('app:copy-text', (event, text) => {
  try {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** 读取本地文件为 base64，用于截图缩略图预览 */
ipcMain.handle('app:file-base64', (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
    return { ok: true, mime, data: buf.toString('base64') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ===================== 陶瓦联机（Terracotta）集成 #12 =====================
 * Terracotta 是基于 EasyTier 的 Rust 独立二进制（GUI 程序），靠房间码联机，无需公网 IP/端口映射。
 * AGPLv3 例外允许启动器打包未修改二进制 / 通过 HTTP API 交互，并需在 UI 显著处标注版权。
 * 本启动器采用「下载官方二进制 + 启动/停止后台进程 + 显著版权标注」方式集成。 */

/* ---------------- 外部配置导入（#3 PCL2/HMCL）/ 日志诊断（#6） ---------------- */

ipcMain.handle('config:scan-external', () => {
  try {
    return { ok: true, files: importConfig.scanExternalConfigs() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('config:parse-external', (event, filePath) => {
  try {
    return importConfig.parseExternalConfig(filePath);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('config:import-external', (event, data) => {
  data = data || {};
  const cfg = readConfig();
  const applied = [];
  const warnings = [];
  if (data.playerName) {
    cfg.playerName = String(data.playerName).trim();
    applied.push('玩家名（' + cfg.playerName + '）');
  }
  if (data.javaPath) {
    const jp = String(data.javaPath).trim().replace(/^["']|["']$/g, '');
    if (fs.existsSync(jp)) {
      cfg.javaPath = jp;
      applied.push('Java 路径');
    } else {
      warnings.push('Java 路径不存在，已跳过：' + jp);
    }
  }
  if (data.maxMemory && Number(data.maxMemory) > 0) {
    cfg.maxMemory = Number(data.maxMemory);
    applied.push('内存（' + cfg.maxMemory + ' MB）');
  }
  if (data.version) {
    cfg.lastVersion = String(data.version).trim();
    applied.push('建议版本（' + cfg.lastVersion + '）');
  }
  writeConfig(cfg);
  return { ok: true, applied, warnings };
});

ipcMain.handle('log:diagnose', (event, text) => {
  try {
    return logDiagnose.diagnose(text);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('log:recent', (event, gameDir) => {
  const logs = [];
  const push = (p) => {
    try {
      const st = fs.statSync(p);
      logs.push({ path: p, mtime: st.mtimeMs, size: st.size, content: fs.readFileSync(p, 'utf8') });
    } catch (e) {
      /* ignore */
    }
  };
  if (gameDir) {
    push(path.join(gameDir, 'logs', 'latest.log'));
    try {
      fs.readdirSync(path.join(gameDir, 'versions')).forEach((v) =>
        push(path.join(gameDir, 'versions', v, 'logs', 'latest.log'))
      );
    } catch (e) {
      /* ignore */
    }
    try {
      fs.readdirSync(path.join(gameDir, 'instances')).forEach((v) =>
        push(path.join(gameDir, 'instances', v, 'logs', 'latest.log'))
      );
    } catch (e) {
      /* ignore */
    }
  }
  logs.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, logs: logs.slice(0, 3) };
});

/* ---------------- 反馈 / 上报（H 功能）：收集日志 + 创建 GitHub issue ---------------- */

const FEEDBACK_REPO = 'wiuw3qde/minecraft-launcher';
const GH_API = 'https://api.github.com';

function crashDir() {
  return path.join(app.getPath('userData'), 'crashes');
}

/** 收集崩溃 dump 列表（由全局崩溃处理器写入） */
function listCrashDumps() {
  try {
    const dir = crashDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /crash-.*\.json$/i.test(f))
      .map((f) => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return { file: f, time: d.time, message: d.message, stack: d.stack };
        } catch (e) {
          return { file: f, time: '', message: '', stack: '' };
        }
      })
      .sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  } catch (e) {
    return [];
  }
}

function loadFeedbackToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const f = path.join(__dirname, '.github_token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}

function ghPost(p, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      GH_API + p,
      {
        method: 'POST',
        headers: {
          Authorization: 'token ' + token,
          'User-Agent': 'mc-launcher-feedback',
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = buf ? JSON.parse(buf) : null; } catch (e) { /* ignore */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error('HTTP ' + res.statusCode + ' ' + (json && json.message ? json.message : buf.slice(0, 200))));
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** 截断过长内容，避免 issue 正文爆炸 */
function clip(text, max) {
  text = String(text || '');
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…（已截断，共 ${text.length} 字符）`;
}

ipcMain.handle('feedback:collect', (event, gameDir) => {
  const logs = [];
  const pushLog = (p) => {
    try {
      const st = fs.statSync(p);
      logs.push({ name: path.basename(p), mtime: st.mtimeMs, size: st.size, content: fs.readFileSync(p, 'utf8') });
    } catch (e) {
      /* ignore */
    }
  };
  if (gameDir) {
    pushLog(path.join(gameDir, 'logs', 'latest.log'));
    try {
      fs.readdirSync(path.join(gameDir, 'crash-reports'))
        .filter((f) => /\.txt$/i.test(f))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 3)
        .forEach((f) => pushLog(path.join(gameDir, 'crash-reports', f)));
    } catch (e) {
      /* ignore */
    }
  }
  const appInfo = {
    version: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
  };
  return {
    ok: true,
    app: appInfo,
    gameDir: gameDir || '',
    logs: logs.slice(0, 4),
    crashReports: [],
    launcherCrashes: listCrashDumps(),
  };
});

ipcMain.handle('feedback:submit-issue', async (event, payload) => {
  const token = loadFeedbackToken();
  if (!token) return { ok: false, error: '未找到 GitHub 令牌（.github_token），无法自动创建 issue' };
  const description = String(payload.description || '').trim() || '(用户未填写描述)';
  const collected = payload.collected || {};
  const app = collected.app || {};
  const lines = [];
  lines.push('## 描述');
  lines.push(description);
  lines.push('');
  lines.push('## 环境');
  lines.push(`- 启动器版本：${app.version || '?'}（${app.platform || '?'} ${app.arch || '?'} · ${app.osRelease || '?'} · 内存 ${app.totalMemoryMB || '?'}MB）`);
  lines.push(`- 游戏目录：${collected.gameDir || '(未提供)'}`);
  lines.push('');
  const logs = collected.logs || [];
  if (logs.length) {
    lines.push('## 游戏 / 崩溃日志');
    logs.forEach((l) => {
      lines.push(`### ${l.name}（${l.size || 0} 字节）`);
      lines.push('```');
      lines.push(clip(l.content, 6000));
      lines.push('```');
    });
    lines.push('');
  }
  const lcs = collected.launcherCrashes || [];
  if (lcs.length) {
    lines.push('## 启动器崩溃记录');
    lcs.slice(0, 3).forEach((c) => {
      lines.push(`### ${c.file} · ${c.time || ''}`);
      if (c.message) lines.push(`- 信息：${c.message}`);
      lines.push('```');
      lines.push(clip(c.stack, 4000));
      lines.push('```');
    });
    lines.push('');
  }
  lines.push('\n---\n由 MC 启动器内置「上报问题」自动生成');
  const title = '用户反馈（v' + (app.version || '?') + '）：' + String(description || '').slice(0, 40);
  try {
    const issue = await ghPost(`/repos/${FEEDBACK_REPO}/issues`, { title: title.slice(0, 128), body: lines.join('\n') }, token);
    return { ok: true, url: issue.html_url, number: issue.number };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('feedback:ack-crash', (event, files) => {
  try {
    const dir = crashDir();
    (files || []).forEach((f) => {
      const fp = path.join(dir, path.basename(f));
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ---------------- 全局崩溃处理器：写 dump，下次启动弹窗提示上报 ---------------- */
let crashGuard = false;
function writeCrashDump(err) {
  if (crashGuard) return;
  crashGuard = true;
  try {
    const dir = crashDir();
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'crash-' + Date.now() + '.json');
    fs.writeFileSync(
      f,
      JSON.stringify({ time: new Date().toISOString(), message: err && err.message, stack: err && err.stack, kind: 'uncaught' }, null, 2)
    );
  } catch (e) {
    /* 写 dump 失败不影响其它逻辑 */
  }
}
process.on('uncaughtException', (e) => {
  writeCrashDump(e);
  // 主进程致命异常：dump 已落盘，退出后下次启动会提示上报
  setTimeout(() => process.exit(1), 50);
});
process.on('unhandledRejection', (e) => {
  // 未处理的 Promise 拒绝：记录但不退出，尽量维持运行
  writeCrashDump(e && e.stack ? e : new Error('unhandledRejection: ' + (e && (e.message || e))));
});

const TC_DIR = path.join(app.getPath('userData'), 'terracotta');
const TC_VERSION = '0.4.2';
// 官方 Release 资产名按平台区分：windows-x86_64 / macos-x86_64 / macos-arm64 …
const TC_ARCH = platform.terracottaArch();
const TC_FALLBACK = platform.terracottaFallback(TC_VERSION);
// macOS 的 pkg 会安装 LaunchAgent 守护进程（TUN/路由需要特权），首次使用需手动安装一次。
const TC_DAEMON_PLIST = '/Library/LaunchAgents/net.burningtnt.terracotta.daemon.plist';
// 官方 HMCL 集成模式：启动时把随机监听端口写进此文件（{"port": N}），启动器据此嵌入 Web 界面
const TC_HMCL_FILE = path.join(TC_DIR, 'hmcl-port.json');
let tcProc = null;
let tcPort = null; // 运行时随机端口（127.0.0.1），由 --hmcl 文件或锁文件发现

function tcSend(channel, payload) {
  if (win && win.webContents && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

/** Windows 找 .exe；macOS/Linux 的包里主程序是「无扩展名」的 Mach-O / ELF。
 *  官方 mac 包内容已核对：terracotta-<ver>-macos-x86_64（chmod 755）+ 同名 .pkg。 */
function tcIsExeName(name) {
  if (platform.IS_WIN) return /\.exe$/i.test(name);
  if (/\.(pkg|app|dmg|zip|tar|gz|7z|json|lock|txt|md|yml|yaml|log|sh|dylib|so|a|plist|png|ico)$/i.test(name)) return false;
  return true;
}

function tcExecutable(full) {
  try {
    if (!fs.statSync(full).isFile()) return false;
    if (platform.IS_WIN) return true;
    fs.accessSync(full, fs.constants.X_OK);
    return true;
  } catch (e) { return false; }
}

/** 在 TC_DIR 内递归查找 terracotta 可执行文件 */
function findTcExe() {
  try {
    const stack = [TC_DIR];
    let fallback = null;
    while (stack.length) {
      const cur = stack.pop();
      let items;
      try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
      for (const it of items) {
        const full = path.join(cur, it.name);
        if (it.isDirectory()) {
          // .app bundle（官方 .pkg 会装到 /Applications，这里兼容手工放到 TC_DIR 的情况）
          if (!platform.IS_WIN && /\.app$/i.test(it.name)) {
            const macDir = path.join(full, 'Contents', 'MacOS');
            try {
              for (const f of fs.readdirSync(macDir)) {
                const p = path.join(macDir, f);
                if (!/daemon$/i.test(f) && tcExecutable(p)) return p;
              }
            } catch (e) { /* ignore */ }
          }
          stack.push(full);
          continue;
        }
        if (!tcIsExeName(it.name) || !tcExecutable(full)) continue;
        if (/^terracotta/i.test(it.name)) return full; // 官方主二进制优先
        if (!fallback) fallback = full;
      }
    }
    return fallback;
  } catch (e) { /* ignore */ }
  return null;
}

/** macOS：tar 解压后确保可执行位，并清除从网络下载继承的隔离属性 */
function prepareTcMac() {
  if (!platform.IS_MAC) return;
  try { execFileSync('chmod', ['-R', 'u+rwX', TC_DIR], { timeout: 15000 }); } catch (e) { /* ignore */ }
  // Gatekeeper 会把 quarantine 传播到归档解压出的二进制；不清除会直接被系统拦下
  try { execFileSync('xattr', ['-c', '-r', TC_DIR], { timeout: 15000 }); } catch (e) { /* 无该属性时返回非 0，忽略 */ }
}

/** 官方 mac 包里附带 .pkg：安装 LaunchAgent 守护进程，TUN/路由需要它 */
function findTcPkg() {
  if (!platform.IS_MAC) return null;
  try {
    const stack = [TC_DIR];
    while (stack.length) {
      const cur = stack.pop();
      for (const it of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, it.name);
        if (it.isDirectory()) { stack.push(full); continue; }
        if (/\.pkg$/i.test(it.name)) return full;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

function tcNeedsPrivilegedInstall(pkg) {
  return !!(platform.IS_MAC && pkg && !fs.existsSync(TC_DAEMON_PLIST));
}

/** 停止旧进程：Windows 用 taskkill /T 连子进程一起杀；POSIX 用信号 */
function stopTcProcess() {
  if (!tcProc || !isRunning(tcProc.pid)) return;
  const pid = tcProc.pid;
  if (platform.IS_WIN) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/F', '/T']); } catch (e) { /* ignore */ }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
    const t = setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch (x) { /* ignore */ } }, 1500);
    if (t.unref) t.unref();
  }
}

/** 检测 pid 是否存活（Windows 下 detached 进程） */
function isRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/** 跟随重定向下载文件到 dest，带进度（基于 content-length） */
function downloadToFile(url, dest, hooks) {
  hooks = hooks || {};
  return new Promise((resolve, reject) => {
    function attempt(u, redirects) {
      if (redirects > 8) return reject(new Error('重定向过多'));
      const req = https.get(u, { headers: { 'User-Agent': 'MC-Launcher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return attempt(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = Number(res.headers['content-length']) || 0;
        const out = fs.createWriteStream(dest);
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (total && hooks.onProgress) hooks.onProgress({ percent: Math.min(99, Math.floor((got / total) * 100)) });
        });
        res.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => resolve({ size: got, total }));
        res.pipe(out);
      });
      req.on('error', reject);
    }
    attempt(url, 0);
  });
}

/** 通过 GitHub API 动态获取 latest release 的 windows 包直链 */
function fetchTcDownloadUrl() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.github.com/repos/burningtnt/Terracotta/releases/latest', {
      headers: { 'User-Agent': 'MC-Launcher', 'Accept': 'application/vnd.github+json' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return reject(new Error('API 重定向，走兜底'));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const asset = (json.assets || []).find((a) => new RegExp(TC_ARCH + '-pkg\\.tar\\.gz$').test(a.name));
          resolve(asset ? asset.browser_download_url : null);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** 用系统 tar 解压（Windows 10+ 自带 bsdtar，自动识别 gzip） */
function tarExtract(file, dest) {
  return new Promise((resolve, reject) => {
    // Windows bsdtar 在遇到已存在对象时会报 "Can't unlink already-existing object"，
    // 因此调用方需先清空目标目录（见 terracotta:install）。这里加 -o 作为双保险（忽略已有文件）。
    execFile('tar', ['-xf', file, '-C', dest, '-o'], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/** 发现陶瓦联机当前随机端口：优先读 --hmcl 文件，其次读 terracotta.lock（2 字节大端） */
function discoverTcPort() {
  try {
    if (fs.existsSync(TC_HMCL_FILE)) {
      const j = JSON.parse(fs.readFileSync(TC_HMCL_FILE, 'utf8'));
      if (j && j.port) return j.port;
    }
  } catch (e) { /* ignore */ }
  try {
    const lock = path.join(TC_DIR, 'terracotta.lock');
    if (fs.existsSync(lock)) {
      const buf = fs.readFileSync(lock);
      if (buf.length >= 2) return buf.readUInt16BE(0);
    }
  } catch (e) { /* ignore */ }
  return null;
}

ipcMain.handle('terracotta:status', () => {
  const exe = findTcExe();
  const running = !!(tcProc && isRunning(tcProc.pid));
  if (running && !tcPort) tcPort = discoverTcPort();
  const pkg = findTcPkg();
  return {
    installed: !!exe,
    running,
    exePath: exe,
    port: tcPort,
    webUrl: tcPort ? ('http://127.0.0.1:' + tcPort + '/') : null,
    // macOS 首次使用需安装随包附带的 .pkg（LaunchAgent 守护进程）
    pkgPath: pkg,
    needsPrivilegedInstall: tcNeedsPrivilegedInstall(pkg),
    platform: process.platform,
  };
});

/** 打开随包附带的 .pkg，交给 macOS 安装器（会提示管理员密码） */
ipcMain.handle('terracotta:open-pkg', async () => {
  const pkg = findTcPkg();
  if (!pkg) return { ok: false, error: '未找到系统组件安装包（.pkg）' };
  try {
    const r = await shell.openPath(pkg);
    return { ok: !r, error: r || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('terracotta:install', async (event, opts) => {
  opts = opts || {};
  const taskId = opts.taskId || ('tc' + Date.now());
  let url = null;
  try {
    tcSend('terracotta:log', { taskId, text: '正在查询陶瓦联机最新版本…' });
    url = await fetchTcDownloadUrl();
  } catch (e) { url = null; }
  if (!url) {
    url = TC_FALLBACK;
    tcSend('terracotta:log', { taskId, text: '自动查询失败，改用已知版本直链：' + url });
  } else {
    tcSend('terracotta:log', { taskId, text: '下载地址：' + url });
  }
  // 下载到临时目录（不放在 TC_DIR 内，便于先清空目标再解压）
  const tmp = path.join(os.tmpdir(), 'terracotta-' + Date.now() + '.tar.gz');
  try {
    // 先停掉可能正在运行的旧进程，并清空目标目录，避免 bsdtar 因已存在对象失败
    stopTcProcess();
    tcProc = null; tcPort = null;
    try { fs.rmSync(TC_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    fs.mkdirSync(TC_DIR, { recursive: true });
    await downloadToFile(url, tmp, {
      onProgress: (p) => tcSend('terracotta:progress', Object.assign({ taskId }, p)),
    });
    tcSend('terracotta:log', { taskId, text: '下载完成，正在解压…' });
    await tarExtract(tmp, TC_DIR);
    prepareTcMac();
    try { fs.rmSync(tmp, { force: true }); } catch (e) { /* ignore */ }
    const exe = findTcExe();
    if (!exe) {
      tcSend('terracotta:done', { taskId, ok: false, error: '解压后未找到可执行文件' });
      return { ok: false, error: '解压后未找到可执行文件' };
    }
    tcSend('terracotta:done', { taskId, ok: true, exePath: exe });
    return { ok: true, exePath: exe };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (x) { /* ignore */ }
    tcSend('terracotta:done', { taskId, ok: false, error: e.message });
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('terracotta:launch', async () => {
  const exe = findTcExe();
  if (!exe) return { ok: false, error: '尚未安装陶瓦联机，请先安装' };
  if (tcProc && isRunning(tcProc.pid)) {
    if (!tcPort) tcPort = discoverTcPort();
    return { ok: true, alreadyRunning: true, pid: tcProc.pid, port: tcPort, webUrl: tcPort ? ('http://127.0.0.1:' + tcPort + '/') : null };
  }
  try {
    // 以官方 HMCL 集成模式启动：把随机端口写入文件，启动器据此嵌入 Web 界面（通常不弹外部浏览器）
    try { fs.rmSync(TC_HMCL_FILE, { force: true }); } catch (e) { /* ignore */ }
    tcPort = null;
    // 手工放置或 Gatekeeper 处理后可能丢失执行位，启动前补一次
    if (!platform.IS_WIN) {
      try { fs.chmodSync(exe, 0o755); } catch (e) { /* ignore */ }
      try { execFileSync('xattr', ['-c', exe], { timeout: 5000 }); } catch (e) { /* ignore */ }
    }
    const child = spawn(exe, ['--hmcl', TC_HMCL_FILE], { detached: true, stdio: 'ignore', cwd: TC_DIR, windowsHide: false });
    child.unref();
    tcProc = child;
    // 轮询端口文件（最多 8 秒）
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const p = discoverTcPort();
      if (p) { tcPort = p; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: true, pid: child.pid, port: tcPort, webUrl: tcPort ? ('http://127.0.0.1:' + tcPort + '/') : null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('terracotta:stop', async () => {
  stopTcProcess();
  tcProc = null;
  tcPort = null;
  try { fs.rmSync(TC_HMCL_FILE, { force: true }); } catch (e) { /* ignore */ }
  return { ok: true };
});

/** 调用陶瓦联机本地 REST API（127.0.0.1:{随机端口}）。
 *  p 形如 'state'、'state/scanning'、'state/guesting?room=CODE'。
 *  返回 { ok, status, body }（body 尝试 JSON，失败保留原文）。
 *  失败返回 { ok:false, error }，供前端容错降级。 */
function tcApiGet(p) {
  // 端口由 --hmcl 文件 / 锁文件发现，运行时缓存在 tcPort
  let port = tcPort || discoverTcPort();
  if (!port) return Promise.resolve({ ok: false, error: '陶瓦联机未运行或端口未知' });
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: port, path: '/' + String(p).replace(/^\/+/, ''), timeout: 3500 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let body = data;
          try { body = JSON.parse(data); } catch (e) { /* 保持原文 */ }
          resolve({ ok: true, status: res.statusCode, body });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, error: 'timeout' }); });
  });
}
ipcMain.handle('terracotta:api', async (event, p) => tcApiGet(p));
