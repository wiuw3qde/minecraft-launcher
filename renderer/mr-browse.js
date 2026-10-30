'use strict';
/* Modrinth 浏览/下载前端：资源包 / 光影 两个标签页共用（按 data-mr-type 区分）。
 * 数据来自 Modrinth API，无需 API Key。安装位置、下载进度、队列与「模组下载」保持一致的视觉与交互。
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  function gameDirNow() {
    if (window.launcherUI && window.launcherUI.gameDir) {
      var g = window.launcherUI.gameDir();
      if (g) return g;
    }
    var e = $('gameDir');
    return e ? e.value.trim() : '';
  }
  function resolveDestRoot(val, gd) {
    if (!val || val === 'global') return gd;
    if (val.indexOf('ver:') === 0) return gd + (gd.indexOf('\\') >= 0 ? '\\instances\\' : '/instances/') + val.slice(4);
    return gd;
  }

  var SORT_OPTS = [
    { v: 'relevance', t: '相关度' },
    { v: 'downloads', t: '下载量' },
    { v: 'follows', t: '关注数' },
    { v: 'newest', t: '最新发布' },
    { v: 'updated', t: '最近更新' },
  ];

  /* ---------- 全局进度事件（只注册一次）：统一交给右侧悬浮面板 DLDock ---------- */
  if (!window.__mrGlobalWired) {
    window.__mrGlobalWired = true;
    window.launcher.onMrProgress(function (p) { window.DLDock.progress(p.taskId, p); });
    window.launcher.onMrDone(function (p) { window.DLDock.done(p.taskId, p); });
    window.launcher.onMrLog(function (p) { window.DLDock.log(p.taskId, p.text); });
  }

  /* ---------- 每个容器的 UI 生成与交互 ---------- */
  function buildUI(container) {
    var type = container.getAttribute('data-mr-type') || 'resourcepack';
    var title = container.getAttribute('data-mr-title') || '资源';
    var subDir = container.getAttribute('data-mr-install') || 'resourcepacks';
    var PAGE = 24;

    container.innerHTML =
      '<section class="card guide">' +
      '<div class="guide-steps">' +
      '<div class="gstep active"><span class="gnum">1</span><div class="gtext"><b>筛选 / 搜索</b><p>按版本、分类、关键词找' + esc(title) + '</p></div></div>' +
      '<div class="gstep"><span class="gnum">2</span><div class="gtext"><b>选择安装位置</b><p>全局或版本隔离</p></div></div>' +
      '<div class="gstep"><span class="gnum">3</span><div class="gtext"><b>下载安装</b><p>带进度可视化，自动放到 ' + esc(subDir) + '/</p></div></div>' +
      '</div></section>' +
      '<section class="card"><h2><span class="h2num">1</span>筛选与搜索</h2>' +
      '<div class="row">' +
      '<input type="text" class="grow mr-search" placeholder="搜索' + esc(title) + '，如 realistic / fantasy / 16x" />' +
      '<select class="mr-version mod-filter"></select>' +
      '<select class="mr-category mod-filter"><option value="">全部分类</option></select>' +
      '<select class="mr-sort mod-filter">' + SORT_OPTS.map(function (o) { return '<option value="' + o.v + '">' + o.t + '</option>'; }).join('') + '</select>' +
      '<button class="primary mr-search-btn">搜索</button>' +
      '</div><p class="hint mr-info">数据来自 Modrinth（无需 API Key，国内可直连）。' + esc(title) + '无需加载器，按游戏版本与分类筛选即可。</p></section>' +
      '<section class="card"><h2><span class="h2num">2</span>安装位置</h2>' +
      '<div class="row"><select class="grow mr-target"></select>' +
      '<span class="hint">' + esc(title) + '会直接下载到所选位置的 ' + esc(subDir) + '/ 文件夹。</span></div></section>' +
      '<section class="card"><h2><span class="h2num">3</span>搜索结果</h2>' +
      '<div class="mr-results mod-grid"></div>' +
      '<div class="empty mr-empty"><div class="empty-ico"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"/></svg></div>' +
      '<div class="empty-text"><b>先设置筛选条件，点「搜索」</b><p>数据来自 Modrinth（无需 Key，覆盖绝大多数主流' + esc(title) + '）。</p></div></div></section>' +
      '<section class="card"><h2><span class="h2num">4</span>下载与进度</h2>' +
      '<p class="hint">点卡片上的「下载」即开始。进度会<strong>悬浮在窗口右侧</strong>显示，每个任务都能单独取消；点面板标题可收起为右下角小胶囊。</p></section>';

    var searchInput = container.querySelector('.mr-search');
    var versionSel = container.querySelector('.mr-version');
    var categorySel = container.querySelector('.mr-category');
    var sortSel = container.querySelector('.mr-sort');
    var info = container.querySelector('.mr-info');
    var resultsEl = container.querySelector('.mr-results');
    var emptyEl = container.querySelector('.mr-empty');
    var targetSel = container.querySelector('.mr-target');
    var page = 0;

    function loadFilters() {
      window.launcher.mr.filters(type).then(function (r) {
        if (!r.ok) { info.textContent = '筛选项加载失败：' + r.error; return; }
        versionSel.innerHTML = '<option value="">全部版本</option>' + (r.gameVersions || []).map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
        categorySel.innerHTML = '<option value="">全部分类</option>' + (r.categories || []).map(function (c) { return '<option value="' + esc(c.slug) + '">' + esc(c.name) + '</option>'; }).join('');
      }).catch(function (e) { info.textContent = '筛选项加载失败：' + e.message; });
    }

    function loadTargets() {
      var gd = gameDirNow();
      if (!gd) {
        targetSel.innerHTML = '<option value="">请先在「启动游戏」页选择游戏目录</option>';
        return;
      }
      var opts = [{ v: 'global', t: '全局（' + gd + '）' }];
      var settings = {};
      window.launcher.version.settings().then(function (s) { settings = s || {}; }).catch(function () {});
      window.launcher.versions.list(gd).then(function (r) {
        (r.versions || []).forEach(function (v) {
          var iso = settings[v.id] && settings[v.id].isolated;
          if (iso) opts.push({ v: 'ver:' + v.id, t: '版本隔离：' + v.id });
        });
        targetSel.innerHTML = opts.map(function (o) { return '<option value="' + o.v + '">' + esc(o.t) + '</option>'; }).join('');
      }).catch(function () { targetSel.innerHTML = opts.map(function (o) { return '<option value="' + o.v + '">' + esc(o.t) + '</option>'; }).join(''); });
    }

    function renderResults(hits) {
      if (!hits.length) { emptyEl.style.display = 'block'; resultsEl.innerHTML = ''; return; }
      emptyEl.style.display = 'none';
      resultsEl.innerHTML = hits.map(function (h) {
        var cats = (h.categories || []).slice(0, 4).map(function (c) { return '<span class="mod-tag">' + esc(c) + '</span>'; }).join('');
        var gv = (h.gameVersions || []).slice(0, 3).join(', ');
        return (
          '<div class="mod-card" data-id="' + h.id + '" data-slug="' + esc(h.slug) + '" data-title="' + esc(h.title) + '">' +
          '<img class="mod-icon" src="' + esc(h.iconUrl) + '" alt="" loading="lazy" />' +
          '<div class="mod-body">' +
          '<div class="mod-title">' + esc(h.title) + '</div>' +
          '<div class="mod-author">' + esc(h.author) + ' · ⬇ ' + fmtNum(h.downloads) + (gv ? ' · ' + esc(gv) : '') + '</div>' +
          '<div class="mod-desc">' + esc(h.description) + '</div>' +
          (cats ? '<div class="mod-tags">' + cats + '</div>' : '') +
          '<button class="primary mod-dl-btn mr-dl">下载</button>' +
          '</div></div>'
        );
      }).join('');
      var imgs = resultsEl.querySelectorAll('img.mod-icon');
      for (var i = 0; i < imgs.length; i++) {
        imgs[i].onerror = function () { this.style.visibility = 'hidden'; };
      }
    }

    function doSearch(reset) {
      if (reset) page = 0;
      info.textContent = '搜索中…';
      emptyEl.style.display = 'none';
      window.launcher.mr.search({
        projectType: type,
        query: searchInput.value.trim(),
        gameVersion: versionSel.value,
        category: categorySel.value,
        sort: sortSel.value,
        offset: page * PAGE,
        limit: PAGE,
      }).then(function (r) {
        if (!r.ok) {
          info.innerHTML = '<span style="color:var(--danger)">搜索失败：' + esc(r.error) + '</span>';
          emptyEl.style.display = 'block';
          resultsEl.innerHTML = '';
          return;
        }
        var from = r.hits.length ? page * PAGE + 1 : 0;
        var to = Math.min((page + 1) * PAGE, r.total);
        info.textContent = '共 ' + r.total + ' 个结果' + (from ? '（第 ' + from + '-' + to + '）' : '') +
          '  ·  <a href="#" class="mr-prev"' + (page > 0 ? '' : ' style="opacity:.35;pointer-events:none"') + '>上一页</a>  <a href="#" class="mr-next"' + (to < r.total ? '' : ' style="opacity:.35;pointer-events:none"') + '>下一页</a>';
        renderResults(r.hits);
      }).catch(function (e) {
        info.innerHTML = '<span style="color:var(--danger)">搜索异常：' + esc(e.message) + '</span>';
      });
    }

    function startInstall(projectId, projectTitle, btn) {
      var gd = gameDirNow();
      if (!gd) { alert('请先在「启动游戏」页选择游戏目录'); return; }
      var targetVal = targetSel.value;
      if (!targetVal) { alert('请先选择安装位置'); return; }
      var root = resolveDestRoot(targetVal, gd);
      var sep = root.indexOf('\\') >= 0 ? '\\' : '/';
      var destDir = root + sep + subDir;
      var taskId = 'mr' + Date.now() + Math.random().toString(16).slice(2);
      // 进度统一走右侧悬浮面板；取消由面板上的 ✕ 触发
      window.DLDock.add({
        taskId: taskId,
        title: projectTitle,
        cancel: function () { window.launcher.mr.cancel(taskId); },
      });
      window.launcher.mr.download({
        projectId: projectId,
        destDir: destDir,
        gameVersion: versionSel.value,
        taskId: taskId,
      }).catch(function (e) {
        window.DLDock.done(taskId, { ok: false, error: e.message });
      });
      if (btn) { btn.disabled = true; btn.textContent = '已加入队列'; }
    }

    container.querySelector('.mr-search-btn').addEventListener('click', function () { doSearch(true); });
    searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(true); });
    info.addEventListener('click', function (e) {
      if (e.target && e.target.classList.contains('mr-prev')) { e.preventDefault(); if (page > 0) { page--; doSearch(false); } }
      if (e.target && e.target.classList.contains('mr-next')) { e.preventDefault(); page++; doSearch(false); }
    });
    resultsEl.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.mod-card') : null;
      if (card && e.target.classList.contains('mr-dl')) {
        startInstall(card.getAttribute('data-id'), card.getAttribute('data-title'), e.target);
      }
    });
    loadFilters(); loadTargets();

    container.__refresh = function () { loadFilters(); loadTargets(); };
  }

  /* ---------- 启动：生成所有容器 + 绑定导航 ---------- */
  function init() {
    var containers = document.querySelectorAll('[data-mr-browse]');
    for (var i = 0; i < containers.length; i++) buildUI(containers[i]);

    ['Shaders', 'Resourcepacks'].forEach(function (name) {
      var b = $('tabBtn' + name);
      if (b) b.addEventListener('click', function () {
        if (window.launcherNav && window.launcherNav.show) window.launcherNav.show(name.toLowerCase());
        var c = $('tab' + name);
        if (c && c.__refresh) c.__refresh();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
