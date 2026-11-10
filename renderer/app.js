'use strict';
const $ = (id) => document.getElementById(id);
let versions = [];
let running = false;
let javaCandidates = [];
let javaTaskId = null;

/* ---------- 日志 ---------- */
function log(text) {
  const el = $('log');
  el.textContent += text;
  if (el.textContent.length > 300000) el.textContent = el.textContent.slice(-300000);
  el.scrollTop = el.scrollHeight;
}
function logLine(text) {
  log((text.endsWith('\n') ? text : text + '\n'));
}

/* ---------- 配置 ---------- */
async function collectConfig() {
  return {
    gameDir: $('gameDir').value.trim(),
    versionId: $('version').value,
    playerName: $('playerName').value.trim(),
    authMode: document.querySelector('input[name="authMode"]:checked').value,
    javaPath: $('javaPath').value.trim(),
    memoryMode: $('memoryMode').value,
    minMemory: Number($('minMemory').value) || 0,
    maxMemory: Number($('maxMemory').value) || 0,
    width: Number($('winWidth').value) || 0,
    height: Number($('winHeight').value) || 0,
    fullscreen: $('fullscreen').checked,
    extraJvmArgs: $('extraJvm').value.trim(),
  };
}

function saveConfig() {
  collectConfig().then((cfg) => window.launcher.config.set(cfg));
}

/* 内存分配模式：自动时禁用输入框并显示建议值，手动时启用 */
async function updateMemMode() {
  const mode = $('memoryMode').value;
  const manual = mode === 'manual';
  $('minMemory').disabled = !manual;
  $('maxMemory').disabled = !manual;
  const wm = $('wrapMinMemory');
  const wM = $('wrapMaxMemory');
  if (wm) wm.style.opacity = manual ? '1' : '0.5';
  if (wM) wM.style.opacity = manual ? '1' : '0.5';
  const hint = $('autoMemHint');
  if (!manual) {
    try {
      const a = await window.launcher.app.autoMemory();
      if (hint) {
        hint.hidden = false;
        hint.textContent = `自动模式：将按本机内存分配 最大 ${a.maxMB} MB / 最小 ${a.minMB} MB（可在「版本管理」单版本覆盖）`;
      }
      $('maxMemory').value = a.maxMB;
      $('minMemory').value = a.minMB;
    } catch (e) {
      if (hint) hint.hidden = true;
    }
  } else if (hint) {
    hint.hidden = true;
  }
}

/* ---------- 窗口控制（自定义标题栏） ---------- */
function setupWindowControls() {
  $('winMin').addEventListener('click', () => window.launcher.window.minimize());
  $('winMax').addEventListener('click', () => window.launcher.window.toggleMaximize());
  $('winClose').addEventListener('click', () => window.launcher.window.close());
  window.launcher.window.onMaximizeChange((maxed) => {
    $('winMax').classList.toggle('maxed', maxed);
    $('winMax').title = maxed ? '还原' : '最大化';
  });
  // 双击标题栏 = 最大化/还原
  $('titlebar').addEventListener('dblclick', () => window.launcher.window.toggleMaximize());
}

/* ---------- 新手引导：四步状态高亮 ---------- */
function updateGuide() {
  const dirOk = !!$('gameDir').value.trim() && !$('version').disabled;
  const hasVer = !!$('version').value;
  const loginOk =
    authMode() === 'msa' ? !!msaAccount : /^[A-Za-z0-9_]{3,16}$/.test($('playerName').value.trim());
  const steps = [$('gs1'), $('gs2'), $('gs3'), $('gs4')];
  const state = [dirOk, hasVer, loginOk, false];
  // 第一个未完成的步骤为 active，已完成的为 done
  let activeSet = false;
  state.forEach((done, i) => {
    const el = steps[i];
    if (!el) return;
    el.classList.remove('active', 'done');
    if (done) {
      el.classList.add('done');
    } else if (!activeSet) {
      el.classList.add('active');
      activeSet = true;
    }
  });
  // 前三步就绪且游戏正在运行：第 4 步高亮
  if (!activeSet && running) steps[3].classList.add('active');
}

/* ---------- 目录与版本 ---------- */
async function loadVersions(keepSelection) {
  const gameDir = $('gameDir').value.trim();
  const res = await window.launcher.versions.list(gameDir);
  versions = res.versions || [];
  // 被某个已安装加载器版本继承的「父版本」（如 1.20.1 之于 fabric-loader-x-1.20.1）
  // 只是加载器的依赖，不是可直接启动的独立版本，从展示列表里隐藏，只显示加载器版本。
  const inheritedParents = new Set(versions.filter((v) => v.inheritsFrom).map((v) => v.inheritsFrom));
  const display = versions.filter((v) => !(!v.inheritsFrom && inheritedParents.has(v.id)));
  const sel = $('version');
  const prev = keepSelection ? sel.value : '';
  sel.innerHTML = '';
  display.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    // 加载器版本继承父版本的 jar，不要再标「缺 jar」误导；改成「加载器」更清楚
    const tag = v.inheritsFrom ? '（加载器）' : (v.hasJar ? '' : '（缺 jar）');
    opt.textContent = `${v.id}${tag}${v.type !== 'release' ? ' · ' + v.type : ''}`;
    sel.appendChild(opt);
  });
  const hint = $('dirHint');
  if (res.error) {
    hint.textContent = res.error;
    hint.className = 'hint warn';
    sel.disabled = true;
    $('versionMeta').textContent = '';
  } else {
    hint.textContent = `识别到 ${display.length} 个版本 · 目录：${gameDir}`;
    hint.className = 'hint';
    sel.disabled = false;
    if (prev && display.some((v) => v.id === prev)) sel.value = prev;
  }
  // 空状态：目录里没有版本时给出明确指引
  $('noVersionHint').hidden = display.length > 0;
  if (sel.value) await onVersionChanged();
  updateGuide();
}

async function onVersionChanged() {
  const version = versions.find((v) => v.id === $('version').value);
  const meta = $('versionMeta');
  if (!version) {
    meta.textContent = '';
    return;
  }
  const parts = [
    '类型：' + version.type,
    '资源索引：' + (version.assetIndex || '无'),
    version.hasJar ? '本体 jar：已就绪' : '本体 jar：缺失！',
  ];
  if (version.releaseTime) parts.push('发布：' + version.releaseTime.slice(0, 10));
  if (version.inheritsFrom) parts.push('继承自：' + version.inheritsFrom);
  if (version.mainClass) parts.push('主类：' + version.mainClass);
  meta.textContent = parts.join(' · ');
  $('checkResult').textContent = '';
  $('checkResult').className = 'result';
  await updateJavaHint();
  saveConfig();
  updateGuide();
}

async function runCheck() {
  const gameDir = $('gameDir').value.trim();
  const versionId = $('version').value;
  if (!versionId) return;
  const box = $('checkResult');
  const res = await window.launcher.versions.check(gameDir, versionId);
  if (!res.ok) {
    box.className = 'result bad';
    box.textContent = '检查失败：' + res.error;
    return false;
  }
  const r = res.report;
  const lines = [];
  const missingCount = r.missingLibs.length + r.missingNatives.length + (r.hasJar ? 0 : 1) + r.assetsMissing;
  if (missingCount === 0) {
    box.className = 'result';
    box.innerHTML = `文件完整 ✓ ${r.libraryTotal} 个依赖 + ${r.nativesTotal} 个本地库${
      r.assetsTotal ? ' + ' + r.assetsTotal + ' 个资源文件' : ''
    }，可以启动。`;
  } else {
    box.className = 'result bad';
    const html = [`<strong>缺少 ${missingCount} 项（当前版本不提供自动下载，请自行补齐或用官方启动器先启动一次）</strong>`, '<ul>'];
    if (!r.hasJar) html.push('<li>本体 jar：' + r.jarPath + '</li>');
    if (!r.hasIndex) html.push('<li>资源索引缺失：' + (r.indexJson || '（未知）') + '</li>');
    if (r.assetsMissing) html.push(`<li>资源文件缺失 ${r.assetsMissing} / ${r.assetsTotal} 个</li>`);
    for (const p of r.missingLibs.slice(0, 12)) html.push('<li>' + p + '</li>');
    if (r.missingLibs.length > 12) html.push(`<li>… 还有 ${r.missingLibs.length - 12} 个依赖</li>`);
    for (const p of r.missingNatives.slice(0, 4)) html.push('<li>本地库：' + p + '</li>');
    html.push('</ul>');
    box.innerHTML = html.join('');
  }
  return missingCount === 0;
}

/* ---------- Java ---------- */
async function detectJava() {
  const gameDir = $('gameDir').value.trim();
  logLine('[Java] 正在扫描本机 Java 运行时…');
  const list = await window.launcher.java.find(gameDir);
  const sel = $('javaPath');
  const prev = sel.value;
  sel.innerHTML = '';
  javaCandidates = list;
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '未检测到 Java，请手动浏览选择';
    sel.appendChild(opt);
  }
  for (const j of list) {
    const opt = document.createElement('option');
    opt.value = j.path;
    opt.textContent = `Java ${j.major || '?'} · ${j.path}`;
    opt.title = j.versionString + (j.is64 ? ' · 64位' : '');
    sel.appendChild(opt);
  }
  if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
  logLine('[Java] 共检测到 ' + list.length + ' 个运行时');
  await updateJavaHint();
  saveConfig();
}

async function updateJavaHint() {
  const versionId = $('version').value;
  const gameDir = $('gameDir').value.trim();
  const el = $('javaInfo');
  if (!versionId || !gameDir) {
    el.textContent = '';
    return;
  }
  const rec = await window.launcher.java.recommend(gameDir, versionId);
  const info = await window.launcher.java.info($('javaPath').value.trim());
  const bits = [];
  if (rec.ok) bits.push('该版本推荐 Java ' + rec.major);
  if (info.exists) bits.push(`当前：Java ${info.major || '?'}（${info.versionString}）`);
  el.textContent = bits.join(' · ');
  if (rec.ok && info.exists && info.major) {
    if (info.major < rec.major) {
      el.textContent += ' ⚠ 当前 Java 版本低于推荐版本，可能启动失败（旧版本尤其明显）';
    } else if (info.major > rec.major + 4) {
      el.textContent += ' ⚠ 当前 Java 明显高于推荐版本，老版本（如 1.12.2 及更早）可能不兼容';
    }
  }
  // 是否缺合适 Java：无候选，或没有任何一个 major 匹配推荐版本
  const needInstall = rec.ok && !javaCandidates.some((c) => c.major === rec.major);
  const btn = $('btnInstallJava');
  if (btn) {
    btn.hidden = !needInstall;
    if (needInstall) btn.dataset.major = rec.major;
  }
}

async function installJavaFlow() {
  const btn = $('btnInstallJava');
  const major = Number((btn && btn.dataset.major) || 17);
  if (!btn) return;
  btn.disabled = true;
  if ($('javaInstallStatus')) $('javaInstallStatus').textContent = '正在准备下载 Java ' + major + '…';
  javaTaskId = 'java' + Date.now() + Math.random().toString(16).slice(2);
  window.DLDock.add({
    taskId: javaTaskId,
    title: '安装 Java ' + major,
    cancel: function () { /* Java 下载不支持中途取消，忽略 */ },
  });
  try {
    const r = await window.launcher.java.autoFix({
      gameDir: $('gameDir').value.trim(),
      versionId: $('version').value,
    });
    if (r && r.ok && r.javaPath) {
      // 刷新列表并把新装的 Java 设为当前
      await detectJava();
      $('javaPath').value = r.javaPath;
      await updateJavaHint();
      if (window.DLDock.has(javaTaskId)) window.DLDock.done(javaTaskId, { ok: true, dest: r.javaPath });
      if ($('javaInstallStatus')) $('javaInstallStatus').textContent = '已安装并选用 Java ' + major;
      logLine('[Java] 自动安装完成：' + r.javaPath);
      saveConfig();
    } else if (r && r.already) {
      await detectJava();
      if (window.DLDock.has(javaTaskId)) window.DLDock.done(javaTaskId, { ok: true, dest: r.javaPath });
      if ($('javaInstallStatus')) $('javaInstallStatus').textContent = '已存在可用 Java';
    } else {
      if (window.DLDock.has(javaTaskId)) window.DLDock.done(javaTaskId, { ok: false, error: (r && r.error) || '安装失败' });
      if ($('javaInstallStatus')) $('javaInstallStatus').textContent = '安装失败：' + ((r && r.error) || '未知错误');
    }
  } catch (e) {
    if (window.DLDock.has(javaTaskId)) window.DLDock.done(javaTaskId, { ok: false, error: e.message });
    if ($('javaInstallStatus')) $('javaInstallStatus').textContent = '安装出错：' + e.message;
  } finally {
    btn.disabled = false;
    javaTaskId = null;
  }
}

/* ---------- 启动状态 ---------- */
function setRunning(v) {
  running = v;
  $('btnLaunch').disabled = v;
  $('btnStop').disabled = !v;
  $('status').textContent = v ? '游戏运行中…' : '';
  $('status').className = 'status' + (v ? ' ok' : '');
  updateGuide();
}

async function doLaunch(force) {
  if (running) return;
  const cfg = await collectConfig();
  if (!cfg.gameDir) return status2('请先选择游戏目录', true);
  if (!cfg.versionId) return status2('请先选择游戏版本', true);
  if (!cfg.javaPath) return status2('请选择 Java 路径', true);
  if (cfg.authMode !== 'msa' && !/^[A-Za-z0-9_]{3,16}$/.test(cfg.playerName)) {
    return status2('玩家名需为 3-16 位字母/数字/下划线', true);
  }
  if (cfg.authMode === 'msa' && !msaAccount) {
    return status2('请先完成微软正版登录', true);
  }
  $('checkResult').textContent = '';
  $('checkResult').className = 'result';

  let checkPassed = true;
  if (!force && $('autoCheck').checked) {
    checkPassed = await runCheck();
    if (!checkPassed) appendForceButton();
  }
  await window.launcher.config.set(cfg);
  logLine(
    cfg.authMode === 'msa'
      ? `[启动器] 准备启动 ${cfg.versionId}，正版账号 ${msaAccount ? msaAccount.name : ''}`
      : `[启动器] 准备启动 ${cfg.versionId}，玩家 ${cfg.playerName}`
  );
  const res = await window.launcher.launch.start(cfg);
  if (!res.ok) {
    status2(res.cancelled ? res.error : '启动失败：' + res.error, true);
    logLine(res.cancelled ? '[存档守卫] ' + res.error : '[错误] ' + res.error);
    return;
  }
  setRunning(true);
  status2(`运行中（PID ${res.pid}）`, false);
  logLine(`[启动器] 已启动 PID ${res.pid}，共 ${res.args.length} 个参数 / ${res.classpathCount} 个依赖`);
  if (res.missingNatives && res.missingNatives.length) {
    logLine('[警告] 以下本地库缺失，可能报错（如 lwjgl）：' + res.missingNatives.slice(0, 5).join(', '));
  }
}

/** 检查不通过时，给一个「忽略缺失继续」的入口 */
function appendForceButton() {
  const box = $('checkResult');
  if (box.querySelector('#btnForce')) return;
  const btn = document.createElement('button');
  btn.id = 'btnForce';
  btn.className = 'small';
  btn.textContent = '仍要启动（忽略缺失）';
  btn.style.marginTop = '8px';
  btn.addEventListener('click', () => doLaunch(true));
  box.appendChild(btn);
  status2('文件不完整，可点「仍要启动」继续', true);
}

function status2(text, isError) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (isError ? ' error' : '');
}

/* ---------- 微软正版登录 ---------- */
let msaAccount = null; // {name, uuid, ...}
let msaLogging = false;

function authMode() {
  return document.querySelector('input[name="authMode"]:checked').value;
}

function updateAuthBoxes() {
  const msa = authMode() === 'msa';
  $('offlineBox').hidden = msa;
  $('msaBox').hidden = !msa;
}

function renderMsaAccount() {
  const status = $('msaStatus');
  if (msaAccount) {
    status.innerHTML = `已登录：<b>${msaAccount.name}</b> · UUID ${msaAccount.uuid}`;
    $('btnMsaLogin').hidden = true;
    $('btnMsaCancel').hidden = true;
    $('btnMsaLogout').hidden = false;
    $('btnMsaRefresh').hidden = false;
  } else {
    status.textContent = '未登录';
    $('btnMsaLogin').hidden = false;
    $('btnMsaCancel').hidden = true;
    $('btnMsaLogout').hidden = true;
    $('btnMsaRefresh').hidden = true;
  }
  $('msaLiveBox').hidden = true;
}

async function msaStart() {
  msaLogging = true;
  $('btnMsaLogin').disabled = true;
  $('btnMsaCancel').disabled = false;
  $('msaStatus').textContent = '正在准备微软登录页…';
  $('msaLiveBox').hidden = true;
  const res = await window.launcher.auth.msaStart();
  if (!res.ok) {
    msaLogging = false;
    $('btnMsaLogin').disabled = false;
    $('btnMsaCancel').disabled = true;
    $('msaStatus').textContent = '失败：' + (res.error || '未知错误');
  }
}

async function msaSubmitCode() {
  const text = $('msaCodeInput').value.trim();
  if (!text) {
    $('msaStatus').textContent = '请先粘贴浏览器地址栏的完整网址';
    return;
  }
  $('msaStatus').textContent = '正在验证…';
  const res = await window.launcher.auth.msaSubmitCode(text);
  if (!res.ok) {
    $('msaStatus').textContent = '验证失败：' + (res.error || '未知错误');
  }
}

function copyToClipboard(text) {
  const t = String(text == null ? '' : text);
  // 优先走主进程剪贴板（最稳，绕过渲染层权限问题）
  try {
    if (window.launcher && window.launcher.app && window.launcher.app.copyText) {
      window.launcher.app.copyText(t);
      return true;
    }
  } catch (e) {}
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return true; }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    document.body.removeChild(ta);
    return true;
  } catch (e) {}
  return false;
}

function setupMsaEvents() {
  window.launcher.onMsaEvent((ev) => {
    if (ev.type === 'live-url') {
      $('msaLiveBox').hidden = false;
      const urlField = $('msaLoginUrl');
      if (urlField) urlField.value = ev.url;
      copyToClipboard(ev.url);
      $('msaStatus').innerHTML = '已将微软登录链接<b>显示出来并自动复制到剪贴板</b>。请复制下方链接到浏览器打开完成登录，再把回跳网址粘贴到「确认」。若自动复制没成功，请手动选中链接框按 Ctrl+C。';
    } else if (ev.type === 'progress') {
      $('msaStatus').textContent = ev.text || '';
    } else if (ev.type === 'error') {
      msaLogging = false;
      $('btnMsaLogin').disabled = false;
      $('btnMsaCancel').disabled = true;
      $('msaLiveBox').hidden = true;
      $('msaStatus').textContent = '登录失败：' + (ev.message || '未知错误');
      logLine('[正版登录] 失败：' + (ev.message || ''));
      if (ev.hint) {
        logLine('[正版登录] 解决办法：' + ev.hint);
        $('msaStatus').textContent += '（详细解决办法见日志区）';
      }
    } else if (ev.type === 'success') {
      msaLogging = false;
      msaAccount = ev.account;
      $('btnMsaLogin').disabled = false;
      $('btnMsaCancel').disabled = true;
      $('msaLiveBox').hidden = true;
      renderMsaAccount();
      updateGuide();
      logLine(`[正版登录] 成功：${ev.account.name}（${ev.account.uuid}）`);
    }
  });

  const copyUrlBtn = $('btnMsaCopyUrl');
  if (copyUrlBtn) copyUrlBtn.addEventListener('click', function () {
    const uf = $('msaLoginUrl');
    if (!uf) return;
    const ok = copyToClipboard(uf.value);
    uf.select();
    copyUrlBtn.textContent = ok ? '已复制 ✓' : '复制失败';
    setTimeout(function () { copyUrlBtn.textContent = '复制链接'; }, 1500);
  });

  $('btnMsaLogin').addEventListener('click', msaStart);
  $('btnMsaCancel').addEventListener('click', async () => {
    await window.launcher.auth.msaCancel();
    msaLogging = false;
    $('btnMsaLogin').disabled = false;
    $('btnMsaCancel').disabled = true;
    $('msaStatus').textContent = '已取消';
    $('msaLiveBox').hidden = true;
  });
  $('btnMsaLogout').addEventListener('click', async () => {
    await window.launcher.auth.msaLogout();
    msaAccount = null;
    renderMsaAccount();
    updateGuide();
    logLine('[正版登录] 已退出登录');
  });
  $('btnMsaRefresh').addEventListener('click', async () => {
    $('msaStatus').textContent = '正在刷新登录态…';
    const res = await window.launcher.auth.msaRefresh();
    if (res.ok) {
      msaAccount = res.account;
      renderMsaAccount();
      logLine('[正版登录] 登录态已刷新');
    } else {
      $('msaStatus').textContent = '刷新失败：' + res.error;
    }
  });
  $('btnMsaSubmitCode').addEventListener('click', msaSubmitCode);
  document.querySelectorAll('input[name="authMode"]').forEach((r) =>
    r.addEventListener('change', () => {
      updateAuthBoxes();
      updateGuide();
      saveConfig();
    })
  );
}

/* ---------- 事件绑定 ---------- */
async function init() {
  const cfg = await window.launcher.config.get();
  const info = await window.launcher.app.info();
  // 立即套用外观（主题 / 强调色 / 标题）与彩蛋引擎
  if (window.Settings) {
    window.Settings.applyAppearance(cfg);
    window.Settings.initEgg(cfg);
  }
  $('envInfo').textContent = `${info.platform === 'win32' ? 'Windows' : info.platform} · ${info.arch} · 内存 ${info.totalMemoryMB} MB · v${info.version}`;

  $('gameDir').value = cfg.gameDir || '';
  $('playerName').value = cfg.playerName || 'Player';
  $('minMemory').value = cfg.minMemory || 512;
  $('maxMemory').value = cfg.maxMemory || 2048;
  $('memoryMode').value = cfg.memoryMode || 'auto';
  updateMemMode();
  $('winWidth').value = cfg.width || 854;
  $('winHeight').value = cfg.height || 480;
  $('fullscreen').checked = !!cfg.fullscreen;
  $('extraJvm').value = cfg.extraJvmArgs || '';

  // 给下载页 / 版本页用的取值入口：在填充完输入框后立即暴露，
  // 避免「版本管理」页在 app 初始化（含 loadVersions/detectJava 等耗时步骤）尚未完成前
  // 取到 download.js 的占位桩（gameDir: () => ''），从而误报「请先选择游戏目录」。
  window.launcherUI = {
    gameDir: () => $('gameDir').value.trim(),
    javaPath: () => $('javaPath').value.trim(),
    refreshVersions: () => loadVersions(true),
    log: (t) => logLine(t),
  };

  // 账号登录态
  const auth = await window.launcher.auth.state();
  if (auth.mode === 'msa' && auth.msa) {
    msaAccount = auth.msa;
    document.querySelector('input[name="authMode"][value="msa"]').checked = true;
  }
  setupMsaEvents();
  updateAuthBoxes();
  renderMsaAccount();

  await loadVersions(false);
  if (cfg.versionId && versions.some((v) => v.id === cfg.versionId)) $('version').value = cfg.versionId;
  await onVersionChanged();
  await detectJava();
  if (cfg.javaPath) $('javaPath').value = cfg.javaPath;
  await updateJavaHint();

  $('btnPickDir').addEventListener('click', async () => {
    const res = await window.launcher.dir.pick($('gameDir').value.trim());
    if (!res) return;
    $('gameDir').value = res.path;
    if (!res.valid) logLine('[提示] 该目录下没有 versions 文件夹：' + res.path);
    await loadVersions(false);
    saveConfig();
  });
  $('btnUseDefault').addEventListener('click', async () => {
    $('gameDir').value = await window.launcher.dir.default();
    await loadVersions(false);
    saveConfig();
  });
  $('btnOpenDir').addEventListener('click', async () => {
    await window.launcher.dir.open($('gameDir').value.trim());
  });
  $('btnRefresh').addEventListener('click', () => loadVersions(true));
  $('version').addEventListener('change', onVersionChanged);
  // 导航：启动游戏按钮（此前漏绑，导致离开本页后点不回来）
  $('tabBtnLaunch').addEventListener('click', () => {
    if (window.launcherNav) window.launcherNav.show('launch');
  });
  $('btnCheck').addEventListener('click', () => runCheck());
  $('btnClearNatives').addEventListener('click', async () => {
    const id = $('version').value;
    if (!id) return;
    await window.launcher.versions.clearNatives($('gameDir').value.trim(), id);
    logLine('[natives] 已清除缓存，下次启动将重新解压');
  });

  let uuidTimer = null;
  $('playerName').addEventListener('input', () => {
    clearTimeout(uuidTimer);
    uuidTimer = setTimeout(async () => {
      const name = $('playerName').value.trim();
      const acc = await window.launcher.auth.offline(name);
      $('uuid').value = acc.ok ? acc.account.uuid : '无效的玩家名';
      saveConfig();
      updateGuide();
    }, 250);
  });
  await refreshUuid($('playerName').value.trim());

  $('btnDetectJava').addEventListener('click', detectJava);
  const btnInstall = $('btnInstallJava');
  if (btnInstall) btnInstall.addEventListener('click', installJavaFlow);
  // Java 下载进度（全局只注册一次）
  window.launcher.onJavaProgress(function (p) {
    if (javaTaskId && window.DLDock.has(javaTaskId)) window.DLDock.progress(javaTaskId, p);
  });
  window.launcher.onJavaLog(function (p) {
    if (javaTaskId && window.DLDock.has(javaTaskId)) window.DLDock.log(javaTaskId, p.text);
  });
  $('btnPickJava').addEventListener('click', async () => {
    const p = await window.launcher.java.pick();
    if (!p) return;
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = '自定义 · ' + p;
    $('javaPath').appendChild(opt);
    $('javaPath').value = p;
    await updateJavaHint();
    saveConfig();
  });
  $('javaPath').addEventListener('change', async () => {
    await updateJavaHint();
    saveConfig();
  });

  for (const id of ['minMemory', 'maxMemory', 'winWidth', 'winHeight', 'extraJvm']) {
    $(id).addEventListener('change', saveConfig);
  }
  $('memoryMode').addEventListener('change', () => {
    updateMemMode();
    saveConfig();
  });
  $('fullscreen').addEventListener('change', saveConfig);

  $('btnLaunch').addEventListener('click', () => doLaunch(false));
  $('btnLaunch').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    doLaunch(true);
  });
  $('btnStop').addEventListener('click', async () => {
    await window.launcher.launch.stop();
  });
  $('btnClearLog').addEventListener('click', () => {
    $('log').textContent = '';
  });
  const btnFeedback = $('btnFeedback');
  if (btnFeedback) btnFeedback.addEventListener('click', () => {
    if (window.Feedback) window.Feedback.open();
  });
  $('btnCopyLog').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('log').textContent);
    status2('日志已复制到剪贴板', false);
  });

  window.launcher.onLog((t) => log(t));
  window.launcher.onExit((code) => {
    setRunning(false);
    status2(`已退出（退出码 ${code}）`, code !== 0);
  });

  logLine(`[启动器] v${info.version} 已就绪。右键「启动游戏」= 忽略缺失强制启动。`);

  setupWindowControls();
  updateGuide();
  console.log('[初始化] 版本数=' + versions.length + ' Java候选=' + $('javaPath').options.length + ' 目录有效=' + !$('version').disabled);
}

async function refreshUuid(name) {
  const acc = await window.launcher.auth.offline(name);
  $('uuid').value = acc.ok ? acc.account.uuid : '';
}

// 延迟到 DOMContentLoaded，确保所有后置脚本（settings.js / tools.js / dl-dock.js）
// 均已解析、其 window.Settings / window.Tools / window.DLDock 全局已就绪。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch((e) => logLine('[错误] 初始化失败：' + e.message)));
} else {
  init().catch((e) => logLine('[错误] 初始化失败：' + e.message));
}
