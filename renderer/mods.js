'use strict';
/* 模组下载页（Modrinth）。数据来源 Modrinth API，无需 Key。
 * 注意：app.js 已用 const $ 占用全局词法名，这里用 el() 别名避免重复声明冲突。
 * 下载进度统一交给右侧悬浮面板 DLDock（dl-dock.js），不再放在页面底部。
 * 点卡片进入「详情」弹窗：展示全量版本（按游戏版本分组 + 加载器）与前置模组，
 * 由用户自己指定版本下载，不再用搜索页的筛选项去猜版本。
 */
const el = (id) => document.getElementById(id);

let modBusy = 0;

/* ---------- 切换到模组页（自包含，不依赖其它脚本的 $ / showTab） ---------- */
function switchToMods() {
  if (window.launcherNav && window.launcherNav.show) {
    window.launcherNav.show('mods');
    return;
  }
  el('tabLaunch').hidden = true;
  el('tabDownload').hidden = true;
  el('tabMods').hidden = false;
  el('tabBtnLaunch').classList.toggle('active', false);
  el('tabBtnDownload').classList.toggle('active', false);
  el('tabBtnMods').classList.toggle('active', true);
}

/* ---------- 初始化：注册导航与进度事件 ---------- */
function modInit() {
  el('tabBtnMods').addEventListener('click', async () => {
    switchToMods();
    await modLoadFilters();
    await modLoadTargets();
  });

  el('btnModSearch').addEventListener('click', modSearch);
  el('modSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modSearch();
  });

  // 进度事件（preload 提供；缺失时降级，不阻断页面切换）
  if (typeof window.launcher.onModsProgress === 'function') {
    window.launcher.onModsProgress((p) => window.DLDock.progress(p.taskId, p));
    window.launcher.onModsDone((r) => {
      modBusy = Math.max(0, modBusy - 1);
      window.DLDock.done(r.taskId, r);
    });
    window.launcher.onModsLog((p) => window.DLDock.log(p.taskId, p.text));
  } else {
    console.warn('[mods] 未找到进度事件接口，下载进度可能不更新');
  }
}

/* ---------- 拉取筛选项 ---------- */
async function modLoadFilters() {
  const sel = el('modGameVersion');
  const loader = el('modLoader');
  const cat = el('modCategory');
  if (sel.dataset.loaded) return; // 已填充则跳过
  try {
    const res = await window.launcher.mods.filters();
    if (!res.ok) {
      el('modSearchInfo').textContent = '筛选项加载失败：' + res.error;
      return;
    }
    sel.innerHTML = '<option value="">全部版本</option>';
    (res.gameVersions || []).forEach((v) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    loader.innerHTML = '<option value="">全部加载器</option>';
    (res.loaders || []).forEach((l) => {
      const o = document.createElement('option');
      o.value = l;
      o.textContent = l.charAt(0).toUpperCase() + l.slice(1);
      loader.appendChild(o);
    });
    cat.innerHTML = '<option value="">全部分类</option>';
    (res.categories || []).forEach((c) => {
      const o = document.createElement('option');
      o.value = c.slug;
      o.textContent = c.name;
      cat.appendChild(o);
    });
    sel.dataset.loaded = '1';
  } catch (e) {
    el('modSearchInfo').textContent = '筛选项加载失败：' + e.message;
  }
}

/* ---------- 拉取安装位置（全局 mods + 各版本有效模组目录） ---------- */
async function modLoadTargets() {
  const sel = el('modTarget');
  try {
    const cfg = await window.launcher.config.get();
    const gameDir = (cfg.gameDir || '').replace(/[\\/]+$/, '');
    sel.innerHTML = '';
    const g = document.createElement('option');
    // 沿用后端 path.join 的分隔符风格，避免生成 "D:\.minecraft/mods" 这种混用路径
    const sep = gameDir.indexOf('\\') >= 0 ? '\\' : '/';
    const globalMods = gameDir + sep + 'mods';
    g.value = globalMods;
    g.textContent = '全局 mods（' + globalMods + '）';
    sel.appendChild(g);
    // 各版本的有效模组目录：隔离版本指向 instances/<id>/mods，否则指向 versions/<id>/mods
    const targets = await window.launcher.version.targets(gameDir);
    targets.forEach((t) => {
      const o = document.createElement('option');
      o.value = t.modsDir;
      o.textContent = (t.isolated ? '隔离实例：' : '版本隔离：') + t.id;
      sel.appendChild(o);
    });
    modSyncDetailTarget();
  } catch (e) {
    sel.innerHTML = '<option value="">（无法读取游戏目录，请先在「启动游戏」页设置）</option>';
  }
}

/* ---------- 搜索 ---------- */
async function modSearch() {
  const info = el('modSearchInfo');
  const q = el('modSearch').value.trim();
  const gv = el('modGameVersion').value;
  const loader = el('modLoader').value;
  const category = el('modCategory').value;
  const sort = el('modSort').value;
  info.textContent = '搜索中…';
  el('modEmpty').hidden = true;
  const grid = el('modResults');
  grid.innerHTML = '';
  try {
    const res = await window.launcher.mods.search({
      query: q,
      gameVersion: gv,
      loader,
      category,
      sort,
      offset: 0,
      limit: 40,
    });
    if (!res.ok) {
      info.textContent = '搜索失败：' + res.error;
      el('modEmpty').hidden = false;
      return;
    }
    info.textContent = '共找到 ' + res.total + ' 个结果，显示前 ' + res.hits.length + ' 个（点卡片查看详情与全部版本）';
    if (!res.hits.length) {
      el('modEmpty').hidden = false;
      return;
    }
    res.hits.forEach((h) => grid.appendChild(modCard(h)));
  } catch (e) {
    info.textContent = '搜索失败：' + e.message;
    el('modEmpty').hidden = false;
  }
}

/* ---------- 渲染单个模组卡片 ---------- */
function modCard(h) {
  const card = document.createElement('div');
  card.className = 'mod-card';

  const icon = document.createElement('img');
  icon.className = 'mod-icon';
  icon.alt = '';
  icon.loading = 'lazy';
  if (h.iconUrl) icon.src = h.iconUrl;
  else icon.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Crect width="24" height="24" fill="%23131b26"/%3E%3C/svg%3E';
  icon.onerror = () => { icon.style.visibility = 'hidden'; };
  card.appendChild(icon);

  const body = document.createElement('div');
  body.className = 'mod-body';

  const title = document.createElement('div');
  title.className = 'mod-title';
  title.textContent = h.title;
  body.appendChild(title);

  const author = document.createElement('div');
  author.className = 'mod-author';
  author.textContent = 'by ' + (h.author || '未知作者');
  body.appendChild(author);

  const desc = document.createElement('div');
  desc.className = 'mod-desc';
  desc.textContent = h.description || '';
  body.appendChild(desc);

  const tags = document.createElement('div');
  tags.className = 'mod-tags';
  const loaders = h.categories.filter((c) => ['fabric', 'forge', 'neoforge', 'quilt'].includes(c));
  loaders.concat(h.gameVersions.slice(0, 3)).forEach((t) => {
    const s = document.createElement('span');
    s.className = 'mod-tag';
    s.textContent = t;
    tags.appendChild(s);
  });
  const dl = document.createElement('span');
  dl.className = 'mod-downloads';
  dl.textContent = modFmtNum(h.downloads) + ' 下载';
  tags.appendChild(dl);
  body.appendChild(tags);

  const btn = document.createElement('button');
  btn.className = 'mod-dl-btn primary';
  btn.textContent = '查看详情 / 选版本';
  btn.addEventListener('click', () => modOpenDetail(h.id, h.title));
  body.appendChild(btn);

  card.appendChild(body);
  // 整卡可点（点按钮以外的区域同样进详情）
  card.addEventListener('click', (e) => {
    if (e.target === btn) return;
    modOpenDetail(h.id, h.title);
  });
  card.style.cursor = 'pointer';
  return card;
}

function modFmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function modFmtSize(b) {
  b = Number(b) || 0;
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}

function modFmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* 判断是否为合法的 mods 目标目录（分隔符无关）。
 * 坑点：后端用 path.join 生成目录，Windows 上是反斜杠（D:\.minecraft\instances\25.1\mods）；
 * 若这里按单一分隔符做 indexOf('/mods') 校验，会把「版本 / 隔离实例」这类合法目标全部误判为无效，
 * 导致明明选了安装位置却一直弹「请先选择有效目标」。故先统一分隔符再判断末段是否为 mods。 */
function modIsModsDir(p) {
  if (!p) return false;
  const norm = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return /(^|\/)mods$/i.test(norm);
}

/* ============ 模组详情弹窗 ============ */
let detailState = null; // { projectId, versions, deps, project }
let detailModal = null;

function ensureDetailModal() {
  if (detailModal) return detailModal;
  detailModal = document.createElement('div');
  detailModal.className = 'md-modal';
  detailModal.hidden = true;
  detailModal.innerHTML =
    '<div class="md-backdrop" data-act="close"></div>' +
    '<div class="md-panel">' +
    '<div class="md-head">' +
    '<img class="md-icon" alt="" />' +
    '<div class="md-headtext">' +
    '<div class="md-title"></div>' +
    '<div class="md-sub"></div>' +
    '</div>' +
    '<button class="md-close" data-act="close" title="关闭">✕</button>' +
    '</div>' +
    '<div class="md-scroll">' +
    '<div class="md-desc"></div>' +
    '<section class="md-sec">' +
    '<h3>前置 / 依赖模组 <span class="md-badge md-deps-count"></span></h3>' +
    '<div class="md-deps"></div>' +
    '</section>' +
    '<section class="md-sec">' +
    '<h3>全部版本 <span class="md-badge md-ver-count"></span></h3>' +
    '<div class="md-verbar">' +
    '<select class="md-gv"></select>' +
    '<select class="md-loader"></select>' +
    '<select class="md-target"></select>' +
    '<button class="md-toggle ghost">全部收起</button>' +
    '</div>' +
    '<div class="md-versions"></div>' +
    '</section>' +
    '</div>' +
    '</div>';
  document.body.appendChild(detailModal);

  detailModal.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-act') === 'close') {
      detailModal.hidden = true;
      return;
    }
    // 依赖卡片：点进去看它的详情
    const dep = t && t.closest ? t.closest('.md-dep') : null;
    if (dep) {
      const pid = dep.getAttribute('data-id');
      const title = dep.getAttribute('data-title') || pid;
      if (pid) modOpenDetail(pid, title);
      return;
    }
    // 版本行下载
    const dlbtn = t && t.closest ? t.closest('.md-vdl') : null;
    if (dlbtn) {
      const vid = dlbtn.getAttribute('data-vid');
      const row = dlbtn.closest('.md-vrow');
      const nm = row ? row.getAttribute('data-name') : '';
      modDownloadVersion(vid, nm);
      return;
    }
    // 分组折叠
    const gh = t && t.closest ? t.closest('.md-vgroup-head') : null;
    if (gh) {
      const g = gh.parentNode;
      g.classList.toggle('collapsed');
      return;
    }
  });

  detailModal.querySelector('.md-toggle').addEventListener('click', (e) => {
    const btn = e.target;
    const wrap = detailModal.querySelector('.md-versions');
    const collapsing = btn.textContent.indexOf('收起') >= 0;
    wrap.querySelectorAll('.md-vgroup').forEach((g) => g.classList.toggle('collapsed', collapsing));
    btn.textContent = collapsing ? '全部展开' : '全部收起';
  });
  detailModal.querySelector('.md-gv').addEventListener('change', () => renderDetailVersions());
  detailModal.querySelector('.md-loader').addEventListener('change', () => renderDetailVersions());

  return detailModal;
}

/** 同步详情页的安装位置下拉（与主页面保持一致） */
function modSyncDetailTarget() {
  if (!detailModal) return;
  const src = el('modTarget');
  const dst = detailModal.querySelector('.md-target');
  if (!src || !dst) return;
  const keep = dst.value || src.value;
  dst.innerHTML = src.innerHTML;
  if (keep && Array.from(dst.options).some((o) => o.value === keep)) dst.value = keep;
}

async function modOpenDetail(projectId, title) {
  const m = ensureDetailModal();
  m.hidden = false;
  m.querySelector('.md-title').textContent = title || '加载中…';
  m.querySelector('.md-sub').textContent = '正在读取版本与依赖…';
  m.querySelector('.md-desc').textContent = '';
  m.querySelector('.md-deps').innerHTML = '<div class="hint">加载中…</div>';
  m.querySelector('.md-versions').innerHTML = '<div class="hint">加载中…</div>';
  m.querySelector('.md-icon').style.visibility = 'hidden';
  detailState = null;

  try {
    const r = await window.launcher.mods.detail(projectId);
    if (!r.ok) {
      m.querySelector('.md-sub').innerHTML = '<span style="color:var(--danger)">详情加载失败：' + esc(r.error) + '</span>';
      m.querySelector('.md-versions').innerHTML = '';
      m.querySelector('.md-deps').innerHTML = '';
      return;
    }
    detailState = { projectId, versions: r.versions || [], deps: r.deps || {}, project: r.project };
    renderDetail();
  } catch (e) {
    m.querySelector('.md-sub').innerHTML = '<span style="color:var(--danger)">详情加载失败：' + esc(e.message) + '</span>';
  }
}

function renderDetail() {
  if (!detailState) return;
  const m = detailModal;
  const p = detailState.project;

  const icon = m.querySelector('.md-icon');
  if (p.iconUrl) {
    icon.src = p.iconUrl;
    icon.style.visibility = 'visible';
    icon.onerror = () => { icon.style.visibility = 'hidden'; };
  }
  m.querySelector('.md-title').textContent = p.title;
  const bits = [];
  if (p.author) bits.push('by ' + p.author);
  bits.push(modFmtNum(p.downloads) + ' 下载');
  if (p.follows) bits.push(modFmtNum(p.follows) + ' 关注');
  if (p.license) bits.push(p.license);
  if (p.updated) bits.push('更新于 ' + modFmtDate(p.updated));
  m.querySelector('.md-sub').textContent = bits.join(' · ');
  m.querySelector('.md-desc').textContent = p.description || '';

  // 前置 / 依赖：取所有版本依赖的并集，按项目去重
  const depMap = {};
  detailState.versions.forEach((v) => {
    (v.dependencies || []).forEach((d) => {
      if (d.type === 'incompatible' || !d.projectId) return;
      if (!depMap[d.projectId]) depMap[d.projectId] = { types: {}, versions: 0 };
      depMap[d.projectId].types[d.type] = true;
      depMap[d.projectId].versions++;
    });
  });
  const depIds = Object.keys(depMap);
  const depsBox = m.querySelector('.md-deps');
  if (!depIds.length) {
    depsBox.innerHTML = '<div class="hint">该模组没有声明前置依赖。</div>';
    m.querySelector('.md-deps-count').textContent = '0';
  } else {
    m.querySelector('.md-deps-count').textContent = depIds.length;
    depsBox.innerHTML = depIds
      .map((id) => {
        const info = detailState.deps[id] || {};
        const nm = info.title || id;
        const types = Object.keys(depMap[id].types);
        const label = types.map((t) => (t === 'required' ? '必需' : t === 'optional' ? '可选' : t === 'embedded' ? '内置' : t)).join('/');
        const ic = info.iconUrl
          ? '<img class="md-dep-icon" src="' + esc(info.iconUrl) + '" alt="" onerror="this.style.visibility=\'hidden\'" />'
          : '<span class="md-dep-icon md-dep-ph"></span>';
        return (
          '<div class="md-dep" data-id="' + esc(id) + '" data-title="' + esc(nm) + '" title="点击查看该依赖的详情">' +
          ic + '<span class="md-dep-name">' + esc(nm) + '</span>' +
          '<span class="md-tag md-tag-' + esc(types[0] || 'required') + '">' + esc(label) + '</span>' +
          '<span class="md-dep-go">查看 ›</span>' +
          '</div>'
        );
      })
      .join('');
  }

  // 版本筛选下拉
  const gvSel = m.querySelector('.md-gv');
  const ldSel = m.querySelector('.md-loader');
  const allGv = [];
  const allLd = [];
  detailState.versions.forEach((v) => {
    (v.gameVersions || []).forEach((g) => { if (allGv.indexOf(g) < 0) allGv.push(g); });
    (v.loaders || []).forEach((l) => { if (allLd.indexOf(l) < 0) allLd.push(l); });
  });
  gvSel.innerHTML = '<option value="">全部游戏版本</option>' + allGv.map((g) => '<option value="' + esc(g) + '">' + esc(g) + '</option>').join('');
  ldSel.innerHTML = '<option value="">全部加载器</option>' + allLd.map((l) => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join('');
  // 默认按主页面筛选值预选，方便直接定位
  const mainGv = el('modGameVersion') ? el('modGameVersion').value : '';
  const mainLd = el('modLoader') ? el('modLoader').value : '';
  if (mainGv && allGv.indexOf(mainGv) >= 0) gvSel.value = mainGv;
  if (mainLd && allLd.indexOf(mainLd) >= 0) ldSel.value = mainLd;

  modSyncDetailTarget();
  // 让「全部收起/展开」按钮文案复位
  m.querySelector('.md-toggle').textContent = '全部收起';
  renderDetailVersions();
}

/** 按游戏版本分组渲染全部版本 */
function renderDetailVersions() {
  if (!detailState) return;
  const m = detailModal;
  const gvFilter = m.querySelector('.md-gv').value;
  const ldFilter = m.querySelector('.md-loader').value;

  const filtered = detailState.versions.filter((v) => {
    if (gvFilter && (v.gameVersions || []).indexOf(gvFilter) < 0) return false;
    if (ldFilter && (v.loaders || []).indexOf(ldFilter) < 0) return false;
    return true;
  });

  m.querySelector('.md-ver-count').textContent = filtered.length + ' / ' + detailState.versions.length;

  if (!filtered.length) {
    m.querySelector('.md-versions').innerHTML = '<div class="empty"><div class="empty-text"><b>没有符合条件的版本</b><p>试试放宽游戏版本或加载器筛选。</p></div></div>';
    return;
  }

  // 分组：游戏版本 -> 版本列表（同一版本会同时出现在它支持的每个游戏版本下）
  const map = {};
  const groups = [];
  filtered.forEach((v) => {
    const gvs = gvFilter ? [gvFilter] : (v.gameVersions || []).length ? v.gameVersions : ['（未标注）'];
    gvs.forEach((g) => {
      if (!map[g]) {
        map[g] = { gv: g, versions: [], latest: 0, loaders: [] };
        groups.push(map[g]);
      }
      if (map[g].versions.indexOf(v) < 0) map[g].versions.push(v);
      (v.loaders || []).forEach((l) => { if (map[g].loaders.indexOf(l) < 0) map[g].loaders.push(l); });
      const ts = new Date(v.datePublished).getTime() || 0;
      if (ts > map[g].latest) map[g].latest = ts;
    });
  });
  groups.sort((a, b) => b.latest - a.latest);

  m.querySelector('.md-versions').innerHTML = groups
    .map((g) => {
      const lds = g.loaders.map((l) => '<span class="md-tag md-tag-loader">' + esc(l) + '</span>').join('');
      const rows = g.versions
        .map((v) => {
          const vl = (v.loaders || []).map((l) => '<span class="md-tag md-tag-loader">' + esc(l) + '</span>').join('');
          const sz = v.file && v.file.size ? modFmtSize(v.file.size) : '—';
          const vt = v.versionType && v.versionType !== 'release'
            ? '<span class="md-tag md-tag-' + esc(v.versionType) + '">' + esc(v.versionType) + '</span>'
            : '';
          const fn = v.file ? v.file.filename : '';
          return (
            '<div class="md-vrow" data-name="' + esc(fn || v.name) + '">' +
            '<div class="md-vrow-main">' +
            '<div class="md-vrow-title">' + esc(v.name) + vt + '</div>' +
            '<div class="md-vrow-meta">' + esc(modFmtDate(v.datePublished)) + ' · ' + sz +
            ' · ⬇ ' + modFmtNum(v.downloads) + (fn ? ' · ' + esc(fn) : '') + '</div>' +
            '</div>' +
            '<div class="md-vrow-side">' + vl +
            '<button class="md-vdl primary" data-vid="' + esc(v.id) + '">下载</button>' +
            '</div>' +
            '</div>'
          );
        })
        .join('');
      return (
        '<div class="md-vgroup">' +
        '<div class="md-vgroup-head"><span class="md-vgroup-caret">▾</span>' +
        '<span class="md-vgroup-gv">' + esc(g.gv) + '</span>' +
        '<span class="md-vgroup-count">' + g.versions.length + ' 个版本</span>' +
        '<span class="md-vgroup-loaders">' + lds + '</span></div>' +
        '<div class="md-vgroup-body">' + rows + '</div>' +
        '</div>'
      );
    })
    .join('');
}

/* ---------- 下载指定版本 ---------- */
function modDownloadVersion(versionId, displayName) {
  const m = detailModal;
  const destDir = m ? m.querySelector('.md-target').value : el('modTarget').value;
  if (!modIsModsDir(destDir)) {
    alert('请先在详情页右上角「安装位置」选择一个有效的目标（全局 mods 或某个版本的 mods 目录）。');
    return;
  }
  const taskId = 't' + Date.now() + Math.random().toString(16).slice(2);
  modBusy++;
  window.DLDock.add({
    taskId,
    title: displayName || '模组',
    cancel: () => window.launcher.mods.cancel(taskId),
  });
  window.launcher.mods
    .download({ taskId, projectId: detailState.projectId, versionId, destDir })
    .catch((e) => {
      modBusy = Math.max(0, modBusy - 1);
      window.DLDock.done(taskId, { ok: false, error: e.message });
    });
}

modInit();
