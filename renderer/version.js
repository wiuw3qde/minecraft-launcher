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
          <button class="ghost small" data-act="refresh-mods">刷新</button>
        </div>
        <p class="hint">模组目录：${esc(p.modsDir)}</p>
        <div class="vm-modlist" id="vmModList"></div>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <h2 style="margin:0"><span class="h2num">3</span>世界管理 <span class="vm-count">${counts.worlds}</span></h2>
          <button class="ghost small" data-act="refresh-worlds">刷新</button>
        </div>
        <p class="hint">存档目录：${esc(p.savesDir)}</p>
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
    detail.querySelector('[data-act="refresh-worlds"]').addEventListener('click', () => loadWorlds(d));
    detail.querySelector('[data-act="refresh-rp"]').addEventListener('click', () => loadResourcepacks(d));
    detail.querySelector('[data-act="refresh-ss"]').addEventListener('click', () => loadScreenshots(d));

    detail.querySelector('[data-act="backup"]').addEventListener('click', () => doBackup(d));
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

  /* ---------------- 世界 ---------------- */
  async function loadWorlds(d) {
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
        '<div class="vm-world-main"><span class="vm-world-name">' + esc(w.name) + '</span>' +
        '<span class="vm-world-sub">' + (w.gameTypeName ? esc(w.gameTypeName) : '未知模式') + (w.hardcore ? ' · 极限' : '') + ' · ' + fmtSize(w.size) + ' · 最后游玩 ' + fmtDate(w.lastPlayed) + '</span></div>' +
        '<span class="vm-mod-acts">' +
        '<button class="small ghost" data-open>打开</button>' +
        '<button class="small ghost" data-bak>备份</button>' +
        '<button class="small danger" data-del>删除</button>' +
        '</span>';
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
