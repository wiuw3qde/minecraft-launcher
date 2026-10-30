'use strict';
/* 统一悬浮下载面板（右侧）。
 * 位置固定在右下角，不占据页面流、不用滑到页面底部才能看到进度。
 * 「模组下载」「光影」「资源包」等所有下载共用；每个进行中的任务都有独立的取消按钮。
 * 可折叠成右侧小胶囊，点击胶囊再展开。
 */
(function () {
  var tasks = new Map(); // taskId -> { el, bar, pct, status, name, done, cancel }

  var dock = null;
  var pill = null;
  var listEl = null;
  var countEl = null;
  var bodyEl = null;
  var collapsed = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtSize(b) {
    b = Number(b) || 0;
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
    return b + ' B';
  }

  function activeCount() {
    var n = 0;
    tasks.forEach(function (t) {
      if (!t.done) n++;
    });
    return n;
  }

  /** 统一显隐：
   *  - 没有任何任务：面板与胶囊都隐藏（不占地方）
   *  - 有任务且展开：显示完整面板
   *  - 有任务且收起：只显示右下角小胶囊（最不挡界面）
   */
  function applyVisibility() {
    if (!dock) return;
    var n = activeCount();
    var total = tasks.size;
    var has = !!(n || total);
    if (countEl) countEl.textContent = n ? n + ' 进行中' : total + ' 项';
    if (pill) {
      pill.textContent = '⬇ 下载 ' + (n || total);
      pill.hidden = !has || !collapsed;
    }
    dock.hidden = !has || collapsed;
    if (bodyEl) bodyEl.hidden = collapsed;
  }

  function updateCount() {
    applyVisibility();
  }

  function build() {
    if (dock) return;
    dock = document.createElement('div');
    dock.className = 'dl-dock';
    dock.innerHTML =
      '<div class="dl-dock-head">' +
      '<span class="dl-dock-title">下载队列</span>' +
      '<span class="dl-dock-count"></span>' +
      '<button class="dl-dock-min" title="收起">▾</button>' +
      '</div>' +
      '<div class="dl-dock-body">' +
      '<div class="dl-dock-list"></div>' +
      '<div class="dl-dock-actions">' +
      '<button class="dl-dock-btn dl-dock-cancelall">取消全部</button>' +
      '<button class="dl-dock-btn dl-dock-cleardone">清除已完成</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(dock);

    pill = document.createElement('div');
    pill.className = 'dl-dock-pill';
    pill.hidden = true;
    pill.textContent = '⬇ 下载';
    document.body.appendChild(pill);

    // 初始没有任何任务，两者都不显示
    dock.hidden = true;

    listEl = dock.querySelector('.dl-dock-list');
    countEl = dock.querySelector('.dl-dock-count');
    bodyEl = dock.querySelector('.dl-dock-body');

    dock.querySelector('.dl-dock-min').addEventListener('click', function () {
      setCollapsed(true);
    });
    dock.querySelector('.dl-dock-head').addEventListener('click', function (e) {
      if (e.target && e.target.classList.contains('dl-dock-min')) return;
      if (collapsed) setCollapsed(false);
    });
    pill.addEventListener('click', function () {
      setCollapsed(false);
    });
    dock.querySelector('.dl-dock-cancelall').addEventListener('click', function () {
      tasks.forEach(function (t) {
        if (!t.done && typeof t.cancel === 'function') t.cancel();
      });
    });
    dock.querySelector('.dl-dock-cleardone').addEventListener('click', function () {
      tasks.forEach(function (t, id) {
        if (t.done) {
          if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
          tasks.delete(id);
        }
      });
      updateCount();
    });
  }

  function setCollapsed(v) {
    collapsed = !!v;
    if (!dock) return;
    applyVisibility();
    var min = dock.querySelector('.dl-dock-min');
    if (min) min.textContent = '▾';
  }

  var DLDock = {
    /** 新增任务。opt: { taskId, title, cancel } —— cancel 由调用方注入（不同来源走不同 IPC） */
    add: function (opt) {
      build();
      var taskId = opt.taskId;
      var wrap = document.createElement('div');
      wrap.className = 'dl-task';
      wrap.innerHTML =
        '<div class="dl-task-head">' +
        '<span class="dl-task-name">' + esc(opt.title || opt.name || '下载任务') + '</span>' +
        '<span class="dl-task-pct">0%</span>' +
        '<button class="dl-task-x" title="取消">✕</button>' +
        '</div>' +
        '<div class="progress"><div class="dl-task-bar" style="width:0%"></div></div>' +
        '<div class="dl-task-status">准备下载…</div>';
      var t = {
        el: wrap,
        name: opt.title || '',
        bar: wrap.querySelector('.dl-task-bar'),
        pct: wrap.querySelector('.dl-task-pct'),
        status: wrap.querySelector('.dl-task-status'),
        cancel: opt.cancel,
        done: false,
      };
      wrap.querySelector('.dl-task-x').addEventListener('click', function () {
        if (t.done) {
          // 已完成的任务：直接移除条目
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          tasks.delete(taskId);
          updateCount();
          return;
        }
        if (typeof t.cancel === 'function') t.cancel();
        t.status.textContent = '正在取消…';
      });
      listEl.insertBefore(wrap, listEl.firstChild);
      tasks.set(taskId, t);
      updateCount();
      if (collapsed) setCollapsed(false);
      return t;
    },

    progress: function (taskId, p) {
      var t = tasks.get(taskId);
      if (!t || t.done) return;
      if (p.name && p.name !== t.name && p.name.indexOf('jar') > 0) {
        t.name = p.name;
        t.el.querySelector('.dl-task-name').textContent = p.name;
      }
      var pct = typeof p.percent === 'number' ? p.percent : 0;
      t.bar.style.width = pct + '%';
      t.pct.textContent = pct + '%';
      if (p.loaded && p.total) {
        t.status.textContent = '下载中 ' + fmtSize(p.loaded) + ' / ' + fmtSize(p.total);
      }
    },

    log: function (taskId, text) {
      var t = tasks.get(taskId);
      if (t && !t.done && text) t.status.textContent = text;
    },

    done: function (taskId, r) {
      var t = tasks.get(taskId);
      if (!t) return;
      t.done = true;
      var x = t.el.querySelector('.dl-task-x');
      if (r && r.cancelled) {
        t.el.classList.add('done-cancel');
        t.pct.textContent = '—';
        t.status.textContent = '已取消';
        t.bar.style.width = '0%';
      } else if (r && r.ok) {
        t.el.classList.add(r.skipped ? 'done-skip' : 'done-ok');
        t.bar.style.width = '100%';
        t.pct.textContent = '100%';
        t.status.textContent = r.skipped ? '已存在，跳过' : '下载完成 · ' + (r.dest || '');
      } else {
        t.el.classList.add('done-fail');
        t.pct.textContent = '✗';
        t.status.textContent = '失败：' + ((r && r.error) || '未知错误');
      }
      if (x) x.title = '移除';
      updateCount();
    },

    has: function (taskId) {
      return tasks.has(taskId);
    },

    /** 取消所有进行中的任务 */
    cancelAll: function () {
      tasks.forEach(function (t) {
        if (!t.done && typeof t.cancel === 'function') t.cancel();
      });
    },

    clearDone: function () {
      tasks.forEach(function (t, id) {
        if (t.done) {
          if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
          tasks.delete(id);
        }
      });
      updateCount();
    },
  };

  window.DLDock = DLDock;
})();
