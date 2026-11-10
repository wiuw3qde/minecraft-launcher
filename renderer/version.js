'use strict';
/* 版本管理页：左侧版本列表 + 右侧详情面板（概览 / 设置 / 模组 / 世界 / 资源包 / 截图 / 危险操作）。
 * 自包含 IIFE，使用 window.launcher 与 window.launcherNav。
 */
(function () {
  const el = (id) => document.getElementById(id);
  let gameDir = '';
  let versions = [];
  let settingsMap = {};
  let currentId = null;
  let worldCardsToken = 0; // 防止世界卡片异步回填时列表已被重绘

  function gameDirNow() {
    // 优先走 app.js 暴露的桥接；若尚未就绪或返回空，则直接读输入框（输入框是游戏目录的真相源）。
    let v = '';
    try { v = (window.launcherUI && window.launcherUI.gameDir) ? window.launcherUI.gameDir() : ''; } catch (e) { v = ''; }
    if (v) return v;
    const inp = document.getElementById('gameDir');
    return inp ? (inp.value || '').trim() : '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB';
    if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
    if (bytes >= 1 << 10) return (bytes / (1 << 10)).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  function fmtDate(ms) {
    if (!ms) return '未知';
    try {
      return new Date(ms).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return '未知';
    }
  }

  /* ---- S1 / N12 存档卡片格式化（纯展示，所有外部字符串都要 esc） ---- */
  const WC_DIMS = {
    'minecraft:overworld': '主世界', overworld: '主世界', '0': '主世界',
    'minecraft:the_nether': '下界', the_nether: '下界', '-1': '下界',
    'minecraft:the_end': '末地', the_end: '末地', '1': '末地',
  };
  const WC_DIFFS = { 0: '和平', 1: '简单', 2: '普通', 3: '困难' };
  const WC_GAME_TYPES = { 0: '生存', 1: '创造', 2: '冒险', 3: '旁观' };

  function fmtDuration(sec) {
    if (sec == null) return '—';
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return h + ' 小时 ' + m + ' 分';
    if (m) return m + ' 分';
    return s + ' 秒';
  }
  function fmtCoord(pos) {
    if (!Array.isArray(pos) || pos.length < 3) return '—';
    const f = (v) => (typeof v === 'number' && isFinite(v))
      ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : '?';
    return f(pos[0]) + ', ' + f(pos[1]) + ', ' + f(pos[2]);
  }
  function wcItem(k, valueHtml, copyText) {
    return '<div class="vm-wc-item"><div class="vm-wc-k">' + esc(k) + '</div>' +
      '<div class="vm-wc-v">' + valueHtml +
      (copyText ? ' <button class="small ghost vm-wc-copy" type="button" data-copy="' + esc(copyText) + '">复制</button>' : '') +
      '</div></div>';
  }

  /* ---------------- 列表 ---------------- */
  async function onShow() {
    if (window.launcherNav && window.launcherNav.show) window.launcherNav.show('versions');
    await loadList();
  }

  async function loadList() {
    gameDir = gameDirNow();
    const list = el('vmList');
    if (!gameDir) {
      list.innerHTML = '<div class="vm-list-empty">请先在「启动游戏」页选择游戏目录</div>';
      return;
    }
    list.innerHTML = '<div class="vm-list-empty">加载中…</div>';
    try {
      const [verRes, setRes] = await Promise.all([
        window.launcher.versions.list(gameDir),
        window.launcher.version.settings(),
      ]);
      versions = verRes.versions || [];
      settingsMap = setRes || {};
    } catch (e) {
      versions = [];
      settingsMap = {};
    }
    renderList();
    if (currentId && versions.some((v) => v.id === currentId)) selectVersion(currentId);
    else showEmpty();
  }

  function renderList() {
    const list = el('vmList');
    list.innerHTML = '';
    if (!versions.length) {
      list.innerHTML = '<div class="vm-list-empty">该目录没有识别到版本</div>';
      return;
    }
    // 隐藏「被加载器版本继承的父版本」（如 1.20.1 之于 fabric-loader-x-1.20.1）：
    // 它们只是加载器的依赖，不是可单独管理的独立版本，只显示加载器版本。
    const inheritedParents = new Set(versions.filter((v) => v.inheritsFrom).map((v) => v.inheritsFrom));
    const shown = versions.filter((v) => !(!v.inheritsFrom && inheritedParents.has(v.id)));
    if (!shown.length) {
      list.innerHTML = '<div class="vm-list-empty">该目录没有可管理的版本</div>';
      return;
    }
    shown.forEach((v) => {
      const iso = !!(settingsMap[v.id] && settingsMap[v.id].isolated);
      // 加载器版本继承父版本本体 jar，不再标「缺 jar」误导，改成「加载器」
      const sub = v.inheritsFrom ? esc(v.type || '') + ' · 加载器' : esc(v.type || '') + (v.hasJar ? '' : ' · 缺 jar');
      const row = document.createElement('button');
      row.className = 'vm-item' + (v.id === currentId ? ' active' : '');
      row.innerHTML =
        '<span class="vm-item-main"><span class="vm-item-name">' + esc(v.id) + '</span>' +
        '<span class="vm-item-sub">' + sub + '</span></span>' +
        '<span class="vm-item-badges">' + (iso ? '<span class="vm-badge iso">隔离</span>' : '') + '</span>';
      row.addEventListener('click', () => selectVersion(v.id));
      list.appendChild(row);
    });
  }

  function showEmpty() {
    el('vmDetail').innerHTML =
      '<div class="empty"><div class="empty-ico"><svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4M3 17l9 4 9-4" /></svg></div>' +
      '<div class="empty-text"><b>选择一个版本</b><p>从左侧列表点选一个版本，即可管理它的实例隔离、模组、世界、资源包与截图。</p></div></div>';
  }

  /* ---------------- 详情 ---------------- */
  async function selectVersion(id) {
    currentId = id;
    renderList();
    const detail = el('vmDetail');
    detail.innerHTML = '<div class="vm-loading">加载中…</div>';
    let res;
    try {
      res = await window.launcher.version.detail(gameDir, id);
    } catch (e) {
      detail.innerHTML = '<div class="empty"><div class="empty-text"><b>加载失败</b><p>' + esc(e.message) + '</p></div></div>';
      return;
    }
    if (!res.ok) {
      detail.innerHTML = '<div class="empty"><div class="empty-text"><b>加载失败</b><p>' + esc(res.error) + '</p></div></div>';
      return;
    }
    renderDetail(res);
  }

  function renderDetail(d) {
    const vs = settingsMap[d.id] || {};
    const p = d.paths;
    const meta = d.meta || {};
    const counts = d.counts || {};

    const html = `
      <section class="card vm-overview">
        <div class="row" style="align-items:flex-start">
          <div class="grow">
            <h2 style="margin-bottom:6px">${esc(d.id)}</h2>
            <div class="vm-meta">
              <span>类型：${esc(meta.type || '未知')}</span>
              ${meta.releaseTime ? '<span>发布：' + esc(meta.releaseTime.slice(0, 10)) + '</span>' : ''}
              <span>本体 jar：${meta.inheritsFrom ? '继承自父版本' : (meta.hasJar ? '已就绪' : '<b style="color:#f85149">缺失</b>')}</span>
              <span class="${d.isolated ? 'vm-on' : 'vm-off'}">实例隔离：${d.isolated ? '已开启' : '关闭'}</span>
            </div>
            <p class="hint vm-path">${d.isolated ? esc(p.instanceDir) : '未隔离：存档/材质与全局共用'}</p>
          </div>
          <div class="row">
            <button class="ghost small" data-act="open-version">打开版本文件夹</button>
            ${d.isolated ? '<button class="ghost small" data-act="open-instance">打开实例文件夹</button>' : ''}
          </div>
        </div>
      </section>

      <section class="card">
        <h2><span class="h2num">1</span>设置（实例隔离 / 每版本参数）</h2>
        <label class="switch inline" style="margin-bottom:10px">
          <input type="checkbox" id="vmIso" ${d.isolated ? 'checked' : ''} />
          <span>启用实例隔离：该版本使用独立游戏目录（存档 / 材质 / 选项 / 截图 / 模组相互独立）</span>
        </label>
        <div class="vm-grid">
          <label class="field"><span>Java 路径（留空沿用全局）</span>
            <div class="row"><input type="text" id="vmJava" placeholder="留空 = 全局设置" value="${esc(vs.javaPath || '')}" /><button class="ghost small" data-act="pick-java">浏览</button></div>
          </label>
          <label class="field small"><span>最小内存 MB</span><input type="number" id="vmMin" placeholder="全局" value="${vs.minMemory || ''}" /></label>
          <label class="field small"><span>最大内存 MB</span><input type="number" id="vmMax" placeholder="全局" value="${vs.maxMemory || ''}" /></label>
          <label class="field small"><span>窗口宽</span><input type="number" id="vmW" placeholder="全局" value="${vs.width || ''}" /></label>
          <label class="field small"><span>窗口高</span><input type="number" id="vmH" placeholder="全局" value="${vs.height || ''}" /></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label class="switch inline"><input type="checkbox" id="vmFs" ${vs.fullscreen ? 'checked' : ''} /><span>全屏</span></label>
          <label class="field grow"><span>附加 JVM 参数（可选）</span><input type="text" id="vmJvm" placeholder="例如 -XX:+UseG1GC（留空沿用全局）" value="${esc(vs.extraJvmArgs || '')}" /></label>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="primary" data-act="save-settings">保存设置</button>
          <span class="hint" id="vmSetInfo"></span>
        </div>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <h2 style="margin:0"><span class="h2num">2</span>模组管理 <span class="vm-count">${counts.enabledMods}/${counts.mods}</span></h2>
          <div class="row" style="margin:0">
            <button class="ghost small" data-act="check-updates">检查更新</button>
            <button class="ghost small" data-act="refresh-mods">刷新</button>
          </div>
        </div>
        <p class="hint">模组目录：${esc(p.modsDir)}</p>
        <div class="vm-modlist" id="vmModList"></div>
        <div class="vm-modupdates" id="vmModUpdates" hidden></div>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <h2 style="margin:0"><span class="h2num">3</span>世界管理 <span class="vm-count">${counts.worlds}</span></h2>
          <button class="ghost small" data-act="refresh-worlds">刷新</button>
        </div>
        <p class="hint">存档目录：${esc(p.savesDir)}　·　存档卡片读自 level.dat，仅本地显示，不上传任何数据。</p>
        <div class="vm-worldlist" id="vmWorldList"></div>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <h2 style="margin:0"><span class="h2num">4</span>资源包 <span class="vm-count">${counts.enabledResourcepacks}/${counts.resourcepacks}</span></h2>
          <button class="ghost small" data-act="refresh-rp">刷新</button>
        </div>
        <p class="hint">资源包目录：${esc(p.resourcepacksDir)}</p>
        <div class="vm-rplist" id="vmRpList"></div>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <h2 style="margin:0"><span class="h2num">5</span>截图 <span class="vm-count">${counts.screenshots}</span></h2>
          <button class="ghost small" data-act="refresh-ss">刷新</button>
        </div>
        <p class="hint">截图目录：${esc(p.screenshotsDir)}</p>
        <div class="vm-ssgrid" id="vmSsGrid"></div>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <h2 style="margin:0"><span class="h2num">6</span>备份与恢复</h2>
          <button class="ghost small" data-act="refresh-bk">刷新</button>
        </div>
        <p class="hint">自动备份（设置页开启）的版本快照与单世界备份，可一键恢复到「覆盖原位置」或「新建副本」。</p>
        <div class="vm-bklist" id="vmBkList">加载中…</div>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <h2 style="margin:0"><span class="h2num">7</span>冒险日记 <span class="vm-count" id="vmDiaryCount">—</span></h2>
          <div class="row" style="margin:0">
            <button class="ghost small" data-act="copy-diary">复制摘要</button>
            <button class="ghost small" data-act="refresh-diary">刷新</button>
          </div>
        </div>
        <p class="hint">从 logs/latest.log 还原一次游玩的事件流；纯本地解析、不上传、不采集聊天内容。只展示能明确识别的事件，不猜测。</p>
        <div id="vmDiary">加载中…</div>
      </section>

      <section class="card vm-danger">
        <h2><span class="h2num">!</span>危险操作</h2>
        <div class="row">
          <button class="ghost" data-act="backup">备份导出（zip）</button>
          <button class="danger" data-act="delete-version">删除该版本</button>
          <span class="hint" id="vmDangerInfo"></span>
        </div>
      </section>
    `;
    el('vmDetail').innerHTML = html;
    bindDetail(d);
    // 加载列表型数据
    loadMods(d);
    loadWorlds(d);
    loadBackups(d);
    loadDiary(d);
    loadResourcepacks(d);
    loadScreenshots(d);
  }

  function bindDetail(d) {
    const detail = el('vmDetail');
    detail.querySelector('[data-act="open-version"]').addEventListener('click', () => openPath(d.paths.versionDir));
    const ob = detail.querySelector('[data-act="open-instance"]');
    if (ob) ob.addEventListener('click', () => openPath(d.paths.instanceDir));

    detail.querySelector('[data-act="save-settings"]').addEventListener('click', () => saveSettings(d));
    detail.querySelector('[data-act="pick-java"]').addEventListener('click', async () => {
      const p = await window.launcher.java.pick();
      if (p) detail.querySelector('#vmJava').value = p;
    });

    detail.querySelector('[data-act="refresh-mods"]').addEventListener('click', () => loadMods(d));
    const cu = detail.querySelector('[data-act="check-updates"]');
    if (cu) cu.addEventListener('click', () => checkModUpdates(d));
    detail.querySelector('[data-act="refresh-worlds"]').addEventListener('click', () => loadWorlds(d));
    detail.querySelector('[data-act="refresh-rp"]').addEventListener('click', () => loadResourcepacks(d));
    detail.querySelector('[data-act="refresh-ss"]').addEventListener('click', () => loadScreenshots(d));

    detail.querySelector('[data-act="backup"]').addEventListener('click', () => doBackup(d));
    const rb = detail.querySelector('[data-act="refresh-bk"]');
    if (rb) rb.addEventListener('click', () => loadBackups(d));
    const rd = detail.querySelector('[data-act="refresh-diary"]');
    if (rd) rd.addEventListener('click', () => loadDiary(d));
    const cd = detail.querySelector('[data-act="copy-diary"]');
    if (cd) cd.addEventListener('click', copyDiary);
    detail.querySelector('[data-act="delete-version"]').addEventListener('click', () => doDelete(d));
  }

  async function openPath(dir) {
    const r = await window.launcher.app.openPath(dir);
    if (r && !r.ok) alert('打开失败：' + (r.error || '未知错误'));
  }

  async function saveSettings(d) {
    const detail = el('vmDetail');
    const patch = {
      isolated: detail.querySelector('#vmIso').checked,
      javaPath: detail.querySelector('#vmJava').value.trim(),
      minMemory: numOrUndef(detail.querySelector('#vmMin').value),
      maxMemory: numOrUndef(detail.querySelector('#vmMax').value),
      width: numOrUndef(detail.querySelector('#vmW').value),
      height: numOrUndef(detail.querySelector('#vmH').value),
      fullscreen: detail.querySelector('#vmFs').checked,
      extraJvmArgs: detail.querySelector('#vmJvm').value.trim() || undefined,
    };
    const r = await window.launcher.version.setSettings(d.id, patch);
    const info = detail.querySelector('#vmSetInfo');
    if (r.ok) {
      info.textContent = '已保存';
      info.className = 'hint';
      settingsMap[d.id] = r.settings;
      renderList();
      // 隔离状态变化会改变有效目录，重新加载详情
      selectVersion(d.id);
    } else {
      info.textContent = '保存失败：' + r.error;
      info.className = 'hint warn';
    }
  }

  function numOrUndef(v) {
    const n = Number(v);
    return n > 0 ? n : undefined;
  }

  /* ---------------- 模组 ---------------- */
  async function loadMods(d) {
    const box = el('vmModList');
    box.innerHTML = '<div class="vm-mini-hint">加载中…</div>';
    const res = await window.launcher.version.mods(gameDir, d.id);
    if (!res.ok) { box.innerHTML = '<div class="vm-mini-hint">加载失败：' + esc(res.error) + '</div>'; return; }
    const mods = res.mods || [];
    if (!mods.length) { box.innerHTML = '<div class="vm-mini-hint">该版本没有模组（可在「模组下载」页安装到此版本）</div>'; return; }
    box.innerHTML = '';
    mods.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'vm-mod' + (m.enabled ? '' : ' disabled');
      row.innerHTML =
        '<span class="vm-mod-name">' + esc(m.display) + '</span>' +
        '<span class="vm-mod-size">' + fmtSize(m.size) + '</span>' +
        '<span class="vm-mod-acts">' +
        '<button class="small ' + (m.enabled ? 'ghost' : 'primary') + '" data-toggle>' + (m.enabled ? '禁用' : '启用') + '</button>' +
        '<button class="small ghost" data-del>删除</button>' +
        '</span>';
      row.querySelector('[data-toggle]').addEventListener('click', async () => {
        const r = await window.launcher.version.modToggle(gameDir, d.id, m.name);
        if (r.ok) loadMods(d);
        else alert('操作失败：' + r.error);
      });
      row.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm('确定删除模组 ' + m.display + '？')) return;
        const r = await window.launcher.version.modDelete(gameDir, d.id, m.name);
        if (r.ok) loadMods(d);
        else alert('删除失败：' + r.error);
      });
      box.appendChild(row);
    });
  }

  /* ---------------- Mod 更新检测（A 功能） ---------------- */
  let modUpdateListenersBound = false;
  function ensureModUpdateListeners() {
    if (modUpdateListenersBound) return;
    modUpdateListenersBound = true;
    if (typeof window.DLDock === 'undefined') return;
    if (typeof window.launcher.onModsProgress === 'function') {
      window.launcher.onModsProgress((p) => window.DLDock.progress(p.taskId, p));
      window.launcher.onModsDone((r) => window.DLDock.done(r.taskId, r));
      window.launcher.onModsLog((p) => window.DLDock.log(p.taskId, p.text));
    }
  }

  async function checkModUpdates(d) {
    ensureModUpdateListeners();
    const box = el('vmModUpdates');
    box.hidden = false;
    box.innerHTML = '<div class="vm-mini-hint">正在对比 Modrinth 上的最新版本…（首次会逐个查询，请稍候）</div>';
    const res = await window.launcher.modUpdates.check(gameDir, d.id);
    if (!res.ok) { box.innerHTML = '<div class="vm-mini-hint">检查失败：' + esc(res.error) + '</div>'; return; }
    renderModUpdates(d, res.results || []);
  }

  function renderModUpdates(d, rows) {
    const box = el('vmModUpdates');
    const updatable = rows.filter((r) => r.status === 'update');
    const latest = rows.filter((r) => r.status === 'latest');
    const unknown = rows.filter((r) => r.status === 'unknown');
    if (!rows.length) { box.innerHTML = '<div class="vm-mini-hint">该版本没有可用于更新检测的模组（仅 .jar 模组参与检测）。</div>'; return; }
    let html = '<div class="vm-upd-summary">更新检测：' +
      '<span class="vm-upd-badge up">可更新 ' + updatable.length + '</span>' +
      '<span class="vm-upd-badge ok">已最新 ' + latest.length + '</span>' +
      '<span class="vm-upd-badge un">无法检测 ' + unknown.length + '</span></div>';
    if (updatable.length) {
      html += '<div class="vm-upd-list">';
      updatable.forEach((r) => {
        html += '<div class="vm-upd-row" data-name="' + esc(r.name) + '" data-slug="' + esc(r.slug || '') + '" data-pid="' + esc(r.projectId || r.slug || '') + '" data-vid="' + esc(r.latestVersionId || '') + '">' +
          '<span class="vm-upd-name">' + esc(r.display) + '</span>' +
          '<span class="vm-upd-ver">' + esc(r.installedVersion) + ' → <b>' + esc(r.latestVersion || '') + '</b></span>' +
          (r.loaderMismatch ? '<span class="vm-upd-warn" title="该 mod 在此游戏版本下没有匹配当前加载器的构建，更新后可能无法加载">⚠ 加载器不符</span>' : '') +
          '<button class="small primary vm-upd-btn">更新</button>' +
          '</div>';
      });
      html += '</div>';
    }
    if (unknown.length) {
      html += '<details class="vm-upd-unknown"><summary>无法检测更新源的模组（' + unknown.length + '，点开）</summary><div class="vm-upd-unknown-list">';
      unknown.forEach((r) => {
        html += '<div class="vm-upd-row un">' +
          '<span class="vm-upd-name">' + esc(r.display) + '</span>' +
          '<span class="vm-upd-ver">已装 ' + esc(r.installedVersion) + '</span>' +
          '<span class="vm-upd-hint">未在 Modrinth 找到来源</span></div>';
      });
      html += '</div></details>';
    }
    box.innerHTML = html;
    box.querySelectorAll('.vm-upd-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.vm-upd-row');
        doUpdateMod(d, {
          name: row.getAttribute('data-name'),
          slug: row.getAttribute('data-slug'),
          projectId: row.getAttribute('data-pid'),
          mrVersionId: row.getAttribute('data-vid'),
        });
      });
    });
  }

  function doUpdateMod(d, info) {
    ensureModUpdateListeners();
    if (!window.DLDock) { alert('下载面板未就绪'); return; }
    const taskId = 'upd' + Date.now() + Math.random().toString(16).slice(2);
    window.DLDock.add({ taskId, title: '更新 ' + (info.slug || 'mod'), cancel: () => window.launcher.mods.cancel(taskId) });
    window.launcher.modUpdates
      .update({ taskId, gameDir, versionId: d.id, modName: info.name, projectId: info.projectId || info.slug, mrVersionId: info.mrVersionId })
      .then((r) => {
        if (r && r.ok) { loadMods(d); checkModUpdates(d); }
        else if (r && !r.ok && !r.cancelled) { alert('更新失败：' + (r.error || '未知错误')); }
      })
      .catch((e) => alert('更新出错：' + e.message));
  }

  /* ---------------- 世界（S1 / N12 存档卡片） ---------------- */
  async function loadWorlds(d) {
    worldCardsToken++; // 让任何在途的卡片回填失效
    const box = el('vmWorldList');
    box.innerHTML = '<div class="vm-mini-hint">加载中…</div>';
    const res = await window.launcher.version.worlds(gameDir, d.id);
    if (!res.ok) { box.innerHTML = '<div class="vm-mini-hint">加载失败：' + esc(res.error) + '</div>'; return; }
    const worlds = res.worlds || [];
    if (!worlds.length) { box.innerHTML = '<div class="vm-mini-hint">该版本没有存档</div>'; return; }
    box.innerHTML = '';
    worlds.forEach((w) => {
      const row = document.createElement('div');
      row.className = 'vm-world';
      row.innerHTML =
        '<div class="vm-world-head">' +
          '<div class="vm-world-main"><span class="vm-world-name">' + esc(w.name) + '</span>' +
          '<span class="vm-world-sub">' + (w.gameTypeName ? esc(w.gameTypeName) : '未知模式') + (w.hardcore ? ' · 极限' : '') + ' · ' + fmtSize(w.size) + ' · 最后游玩 ' + fmtDate(w.lastPlayed) + '</span></div>' +
          '<span class="vm-mod-acts">' +
          '<button class="small ghost" data-open>打开</button>' +
          '<button class="small ghost" data-bak>备份</button>' +
          '<button class="small danger" data-del>删除</button>' +
          '</span>' +
        '</div>' +
        '<div class="vm-world-card vm-wc-loading" data-folder="' + esc(w.folder) + '">读取存档卡片…</div>';
      row.querySelector('[data-open]').addEventListener('click', async () => {
        const r = await window.launcher.version.worldOpen(gameDir, d.id, w.folder);
        if (r && !r.ok) alert('打开失败：' + r.error);
      });
      row.querySelector('[data-bak]').addEventListener('click', async () => {
        const r = await window.launcher.version.worldBackup(gameDir, d.id, w.folder);
        if (r.ok) alert('已备份到：' + r.dest);
        else alert('备份失败：' + r.error);
      });
      row.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm('确定删除世界「' + w.name + '」？此操作不可恢复！')) return;
        const r = await window.launcher.version.worldDelete(gameDir, d.id, w.folder);
        if (r.ok) loadWorlds(d);
        else alert('删除失败：' + r.error);
      });
      box.appendChild(row);
    });
    loadWorldCards(d.id, worlds, box);
  }

  function worldCardHtml(it) {
    if (!it.ok || !it.summary) {
      return '<div class="vm-wc-note">无法读取存档卡片：' + esc(it.error || 'level.dat 解析失败') + '</div>';
    }
    const s = it.summary;
    const p = s.player || {};
    const days = s.gameTicks != null ? Math.floor(s.gameTicks / 24000) + 1 : null;
    const dur = (s.gameSeconds == null ? '—' : fmtDuration(s.gameSeconds)) +
      (days != null ? ' <span class="vm-wc-extra">· 约第 ' + days + ' 天</span>' : '');
    const mode = (WC_GAME_TYPES[s.gameType] || (s.gameType == null ? '—' : '模式 ' + s.gameType)) +
      (s.hardcore ? ' · 极限' : '');
    const diff = s.difficulty == null ? '—' : (WC_DIFFS[s.difficulty] || String(s.difficulty));
    const dimRaw = p.dimension;
    const dim = dimRaw == null ? '—' : (WC_DIMS[String(dimRaw)] || esc(String(dimRaw)));
    const ver = [s.versionName ? esc(s.versionName) : '', s.dataVersion != null ? '数据 #' + s.dataVersion : '']
      .filter(Boolean).join(' · ') || '—';
    const seed = s.seedText != null ? esc(s.seedText) : '—';
    const player = [p.xpLevel != null ? '等级 ' + p.xpLevel : '', p.health != null ? '生命 ' + Math.round(p.health * 10) / 10 : '']
      .filter(Boolean).join(' · ') || '—';
    const cheats = s.allowCommands == null ? '—' : (s.allowCommands ? '允许' : '关闭');
    return [
      wcItem('种子', seed, s.seedText != null ? s.seedText : null),
      wcItem('游戏时长', dur),
      wcItem('最后游玩', esc(fmtDate(s.lastPlayed))),
      wcItem('坐标', esc(fmtCoord(p.pos))),
      wcItem('维度', dim),
      wcItem('出生点', esc(fmtCoord(p.spawn))),
      wcItem('模式 / 难度', esc(mode) + ' · ' + esc(diff)),
      wcItem('玩家状态', esc(player)),
      wcItem('建档版本', ver),
      wcItem('作弊 / 图标', esc(cheats) + ' · ' + (it.hasIcon ? '有' : '无')),
    ].join('');
  }

  async function loadWorldCards(versionId, worlds, box) {
    const token = ++worldCardsToken;
    try {
      const res = await window.launcher.version.worldInfo(gameDir, versionId, worlds.map((w) => w.folder));
      if (token !== worldCardsToken || !box.isConnected) return;
      const map = {};
      ((res && res.items) || []).forEach((it) => { if (it && it.folder != null) map[it.folder] = it; });
      box.querySelectorAll('.vm-world-card').forEach((card) => {
        const it = map[card.getAttribute('data-folder')];
        card.classList.remove('vm-wc-loading');
        card.innerHTML = it ? worldCardHtml(it) : '<div class="vm-wc-note">存档信息读取失败</div>';
        const btn = card.querySelector('[data-copy]');
        if (btn) btn.addEventListener('click', () => {
          const text = btn.getAttribute('data-copy') || '';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
              btn.textContent = '已复制';
              setTimeout(() => { if (btn.isConnected) btn.textContent = '复制'; }, 1200);
            }).catch(() => alert('复制失败，种子：' + text));
          } else {
            alert('种子：' + text);
          }
        });
      });
    } catch (e) {
      if (token !== worldCardsToken || !box.isConnected) return;
      box.querySelectorAll('.vm-world-card').forEach((card) => {
        card.classList.remove('vm-wc-loading');
        card.innerHTML = '<div class="vm-wc-note">存档信息加载失败：' + esc(e && e.message ? e.message : '未知错误') + '</div>';
      });
    }
  }

  /* ---------------- 冒险日记（S2 / N1） ---------------- */
  let diaryData = null;

  function diaryChip(k, v) {
    return '<div class="vm-diary-stat"><span class="vm-diary-k">' + esc(k) + '</span>' +
      '<b>' + esc(String(v)) + '</b></div>';
  }
  function diaryEventRow(e) {
    const cls = ' vm-diary-' + String(e.type || 'other').replace(/[^a-z-]/g, '');
    return '<div class="vm-diary-row' + cls + '">' +
      '<span class="vm-diary-time">' + esc(e.time || '—') + '</span>' +
      '<span class="vm-diary-text">' + esc(e.text || '') + '</span></div>';
  }
  function diaryText(res) {
    const st = res.stats || {};
    const lines = ['【冒险日记】' + (res.source && res.source.path ? '来源：' + res.source.path : '')];
    lines.push('时长：' + (st.durationSeconds == null ? '未知' : fmtDuration(st.durationSeconds)));
    lines.push('事件：' + (res.events || []).length + ' 条　死亡 ' + (st.deaths || 0) +
      '　进度 ' + (st.advancements || 0) + '　崩溃 ' + (st.crashes || 0));
    lines.push('');
    (res.events || []).forEach((e) => lines.push('[' + (e.time || '--:--:--') + '] ' + (e.text || '')));
    return lines.join('\n');
  }
  function copyDiary() {
    if (!diaryData || !diaryData.ok || diaryData.empty) { alert('还没有可复制的冒险日记'); return; }
    const text = diaryText(diaryData);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => alert('已复制冒险日记摘要'))
        .catch(() => alert('复制失败，请手动选择文本'));
    } else {
      alert(text);
    }
  }

  async function loadDiary(d) {
    const box = el('vmDiary');
    const cnt = el('vmDiaryCount');
    if (!box) return;
    box.innerHTML = '<div class="vm-mini-hint">加载中…</div>';
    let res;
    try {
      res = await window.launcher.version.timeline(gameDir, d.id);
    } catch (e) {
      box.innerHTML = '<div class="vm-mini-hint">加载失败：' + esc(e && e.message ? e.message : '未知错误') + '</div>';
      return;
    }
    if (!box.isConnected) return;
    diaryData = res;
    if (!res.ok) { box.innerHTML = '<div class="vm-mini-hint">读取失败：' + esc(res.error || '未知错误') + '</div>'; return; }
    const st = res.stats || {};
    if (cnt) cnt.textContent = (st.matched || 0) + ' 条事件';
    if (res.empty) { box.innerHTML = '<div class="vm-mini-hint">' + esc(res.message || '没有可识别的事件') + '</div>'; return; }
    const chips = [
      diaryChip('总时长', st.durationSeconds == null ? '未知' : fmtDuration(st.durationSeconds)),
      diaryChip('进入世界', st.worldOpens || 0),
      diaryChip('死亡', st.deaths || 0),
      diaryChip('进度', st.advancements || 0),
      diaryChip('崩溃/OOM', st.crashes || 0),
      diaryChip('联机加入', st.joins || 0),
      diaryChip('维度', (st.dimensions || []).length),
      diaryChip('日志行数', st.lines || 0),
    ].join('');
    const ss = res.sessions || [];
    const last = ss.length ? ss[ss.length - 1] : null;
    const evs = (last ? last.events : (res.events || [])).slice(-300);
    const head = '<div class="vm-diary-title">' + esc(last
      ? ('最近一局 · ' + last.world + (last.startTime ? '（' + last.startTime + ' 开始）' : ''))
      : '事件流（未识别到进入/退出世界的分界）') + '</div>';
    const src = '<p class="hint">来源：' + esc(res.source ? res.source.path : '—') +
      (res.truncated ? '（日志较大，仅解析尾部）' : '') + '</p>';
    box.innerHTML = '<div class="vm-diary-stats">' + chips + '</div>' + head +
      '<div class="vm-diary-list">' + evs.map(diaryEventRow).join('') + '</div>' + src;
  }

  /* ---------------- 备份与恢复（#13） ---------------- */
  async function loadBackups(d) {
    const box = el('vmBkList');
    box.innerHTML = '<div class="vm-mini-hint">加载中…</div>';
    const res = await window.launcher.version.backupsList(gameDir, d.id);
    if (!res.ok) { box.innerHTML = '<div class="vm-mini-hint">加载失败：' + esc(res.error) + '</div>'; return; }
    const worlds = res.worlds || [];
    const versions = res.versions || [];
    if (!worlds.length && !versions.length) { box.innerHTML = '<div class="vm-mini-hint">还没有自动备份。可在设置页开启「自动备份世界」并勾选本版本。</div>'; return; }
    box.innerHTML = '';
    worlds.forEach((b) => box.appendChild(bkRow(d, b, 'world')));
    versions.forEach((b) => box.appendChild(bkRow(d, b, 'version')));
  }
  function bkRow(d, b, scope) {
    const row = document.createElement('div');
    row.className = 'vm-bk';
    const label = scope === 'version' ? '整版本快照' : ('世界「' + esc(b.folder) + '」');
    row.innerHTML =
      '<div class="vm-bk-main"><span class="vm-bk-name">' + label + '</span>' +
      '<span class="vm-bk-sub">' + (b.ts || '未知时间') + ' · ' + fmtSize(b.size) + '</span></div>' +
      '<span class="vm-mod-acts"><button class="small primary" data-restore>恢复</button></span>';
    row.querySelector('[data-restore]').addEventListener('click', () => doRestore(d, b, scope));
    return row;
  }
  async function doRestore(d, b, scope) {
    if (scope === 'version') {
      if (!confirm('即将用整版本快照覆盖恢复「' + d.id + '」，可能替换 mods/config/saves，不可撤销。继续？')) return;
      const r = await window.launcher.version.backupRestore(gameDir, d.id, { zipPath: b.path, mode: 'overwrite', scope, folder: b.folder });
      if (r.ok) alert('恢复完成：' + r.dest);
      else alert('恢复失败：' + r.error);
      return;
    }
    const copy = !confirm('恢复世界「' + b.folder + '」：\n确定＝覆盖原位置（替换现有）；取消＝恢复到新建副本（不影响现有）');
    if (!copy && !confirm('覆盖会直接用备份替换现有世界「' + b.folder + '」，不可撤销。仍要覆盖？')) return;
    const r = await window.launcher.version.backupRestore(gameDir, d.id, { zipPath: b.path, mode: copy ? 'copy' : 'overwrite', scope, folder: b.folder });
    if (r.ok) alert('恢复完成：' + r.dest);
    else alert('恢复失败：' + r.error);
  }

  /* ---------------- 资源包 ---------------- */
  async function loadResourcepacks(d) {
    const box = el('vmRpList');
    box.innerHTML = '<div class="vm-mini-hint">加载中…</div>';
    const res = await window.launcher.version.resourcepacks(gameDir, d.id);
    if (!res.ok) { box.innerHTML = '<div class="vm-mini-hint">加载失败：' + esc(res.error) + '</div>'; return; }
    const packs = res.packs || [];
    if (!packs.length) { box.innerHTML = '<div class="vm-mini-hint">该版本没有资源包</div>'; return; }
    box.innerHTML = '';
    packs.forEach((pk) => {
      const row = document.createElement('div');
      row.className = 'vm-rp' + (pk.enabled ? ' enabled' : '');
      row.innerHTML =
        '<span class="vm-mod-name">' + esc(pk.name) + (pk.enabled ? ' <span class="vm-on">已启用</span>' : ' <span class="vm-off">未启用</span>') + '</span>' +
        '<span class="vm-mod-size">' + fmtSize(pk.size) + '</span>' +
        '<span class="vm-mod-acts">' +
        '<button class="small ' + (pk.enabled ? 'ghost' : 'primary') + '" data-toggle>' + (pk.enabled ? '禁用' : '启用') + '</button>' +
        '<button class="small danger" data-del>删除</button>' +
        '</span>';
      row.querySelector('[data-toggle]').addEventListener('click', async () => {
        const r = await window.launcher.version.rpToggle(gameDir, d.id, pk.id, !pk.enabled);
        if (r.ok) loadResourcepacks(d);
        else alert('操作失败：' + r.error);
      });
      row.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm('确定删除资源包 ' + pk.name + '？')) return;
        const r = await window.launcher.version.rpDelete(gameDir, d.id, pk.name);
        if (r.ok) loadResourcepacks(d);
        else alert('删除失败：' + r.error);
      });
      box.appendChild(row);
    });
  }

  /* ---------------- 截图 ---------------- */
  async function loadScreenshots(d) {
    const box = el('vmSsGrid');
    box.innerHTML = '<div class="vm-mini-hint">加载中…</div>';
    const res = await window.launcher.version.screenshots(gameDir, d.id);
    if (!res.ok) { box.innerHTML = '<div class="vm-mini-hint">加载失败：' + esc(res.error) + '</div>'; return; }
    const shots = res.screenshots || [];
    if (!shots.length) { box.innerHTML = '<div class="vm-mini-hint">该版本没有截图</div>'; return; }
    box.innerHTML = '';
    shots.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'vm-ss';
      card.innerHTML =
        '<div class="vm-ss-img"><span class="vm-ss-loading">读取中…</span></div>' +
        '<div class="vm-ss-name">' + esc(s.name) + '</div>' +
        '<div class="vm-ss-sub">' + fmtDate(s.mtime) + '</div>' +
        '<div class="vm-mod-acts">' +
        '<button class="small ghost" data-open>打开</button>' +
        '<button class="small danger" data-del>删除</button>' +
        '</div>';
      const imgWrap = card.querySelector('.vm-ss-img');
      window.launcher.app.fileBase64(s.path).then((r) => {
        if (r && r.ok) {
          const img = document.createElement('img');
          img.src = 'data:' + r.mime + ';base64,' + r.data;
          img.alt = s.name;
          imgWrap.innerHTML = '';
          imgWrap.appendChild(img);
        } else {
          imgWrap.innerHTML = '<span class="vm-ss-loading">无法预览</span>';
        }
      });
      card.querySelector('[data-open]').addEventListener('click', async () => {
        const r = await window.launcher.version.ssOpen(gameDir, d.id, s.name);
        if (r && !r.ok) alert('打开失败：' + r.error);
      });
      card.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm('确定删除截图 ' + s.name + '？')) return;
        const r = await window.launcher.version.ssDelete(gameDir, d.id, s.name);
        if (r.ok) loadScreenshots(d);
        else alert('删除失败：' + r.error);
      });
      box.appendChild(card);
    });
  }

  /* ---------------- 危险操作 ---------------- */
  async function doBackup(d) {
    const info = el('vmDangerInfo');
    info.textContent = '备份中…';
    const r = await window.launcher.version.backup(gameDir, d.id);
    if (r.ok) {
      info.textContent = '已备份：' + r.dest;
      info.className = 'hint';
    } else {
      info.textContent = '备份失败：' + r.error;
      info.className = 'hint warn';
    }
  }

  async function doDelete(d) {
    if (!confirm('确定彻底删除版本「' + d.id + '」？\n将删除版本文件夹及其独立实例（存档/模组/截图），此操作不可恢复！')) return;
    if (!confirm('再次确认：永久删除「' + d.id + '」？')) return;
    const r = await window.launcher.version.delete(gameDir, d.id);
    if (r.ok) {
      currentId = null;
      if (window.launcherUI && window.launcherUI.refreshVersions) window.launcherUI.refreshVersions();
      await loadList();
    } else {
      alert('删除失败：' + r.error);
    }
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    const btn = el('tabBtnVersions');
    if (btn) btn.addEventListener('click', onShow);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
