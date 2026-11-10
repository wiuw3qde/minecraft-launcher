'use strict';
/* 设置页：#7 主题 + 标题文字；#11 玩笑彩蛋开关与效果引擎。
 * 由 app.js 在拿到配置后调用 applyAppearance(cfg) 立即生效；
 * 点击「设置」导航时懒渲染页面内容。 */
(function () {
  var THEMES = [
    { id: 'dark', name: '祖母绿（默认）', color: '#3ddc84' },
    { id: 'light', name: '浅色', color: '#23b26b' },
    { id: 'blue', name: '深海蓝', color: '#4aa3ff' },
    { id: 'purple', name: '暮光紫', color: '#a77bff' },
    { id: 'pink', name: '樱粉', color: '#ff7eb6' },
    { id: 'red', name: '赤焰红', color: '#ff6b6b' },
    { id: 'orange', name: '琥珀橙', color: '#ffa94d' },
  ];

  function $(id) { return document.getElementById(id); }

  function hexToRgb(hex) {
    var m = String(hex || '').replace('#', '');
    if (m.length === 3) m = m.split('').map(function (c) { return c + c; }).join('');
    if (m.length !== 6) return null;
    return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16) };
  }
  function darken(hex, f) {
    var c = hexToRgb(hex); if (!c) return hex;
    return 'rgb(' + Math.round(c.r * f) + ',' + Math.round(c.g * f) + ',' + Math.round(c.b * f) + ')';
  }
  function hexA(hex, a) {
    var c = hexToRgb(hex); if (!c) return 'rgba(0,0,0,' + a + ')';
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  /** 立即套用外观（主题 / 自定义强调色 / 标题）。cfg 可为 null（用默认值） */
  function applyAppearance(cfg) {
    cfg = cfg || {};
    var de = document.documentElement;
    var theme = cfg.theme || 'dark';
    var accent = cfg.accent || '';
    // 重置
    if (theme === 'dark') de.removeAttribute('data-theme');
    else de.setAttribute('data-theme', theme);
    ['--accent', '--accent-deep', '--accent-glow', '--accent-soft'].forEach(function (v) {
      de.style.removeProperty(v);
    });
    if (accent && /^#?[0-9a-fA-F]{6}$/.test(accent)) {
      if (accent[0] !== '#') accent = '#' + accent;
      de.style.setProperty('--accent', accent);
      de.style.setProperty('--accent-deep', darken(accent, 0.78));
      de.style.setProperty('--accent-glow', hexA(accent, 0.35));
      de.style.setProperty('--accent-soft', hexA(accent, 0.12));
    }
    var title = cfg.launcherTitle && cfg.launcherTitle.trim() ? cfg.launcherTitle.trim() : 'MC 启动器';
    document.title = title;
    var tb = $('tbTitle');
    if (tb) tb.textContent = title;
    var brand = $('brandTitle');
    if (brand) brand.textContent = title;
  }

  function save(patch) {
    return window.launcher.config.set(patch).then(function () {
      return window.launcher.config.get();
    });
  }

  /* ---------------- 彩蛋引擎（#11） ---------------- */
  var eggRunning = false;
  var eggTimer = null;
  var eggNodes = [];

  function clearEggNodes() {
    eggNodes.forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
    eggNodes = [];
  }
  function stopEgg() {
    eggRunning = false;
    if (eggTimer) { clearTimeout(eggTimer); eggTimer = null; }
    clearEggNodes();
    document.body.classList.remove('egg-wobble');
  }
  function banner(text) {
    var b = document.createElement('div');
    b.className = 'egg-banner';
    b.textContent = text;
    document.body.appendChild(b);
    eggNodes.push(b);
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); eggNodes = eggNodes.filter(function (x) { return x !== b; }); }, 3200);
  }
  function confetti() {
    var c = document.createElement('div');
    c.className = 'egg-confetti';
    var colors = ['#3ddc84', '#ff6b6b', '#4aa3ff', '#ffa94d', '#a77bff'];
    for (var i = 0; i < 40; i++) {
      var s = document.createElement('i');
      s.style.left = Math.random() * 100 + 'vw';
      s.style.background = colors[i % colors.length];
      s.style.animationDuration = (1.5 + Math.random() * 2) + 's';
      s.style.animationDelay = (Math.random() * 0.8) + 's';
      c.appendChild(s);
    }
    document.body.appendChild(c);
    eggNodes.push(c);
    setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); eggNodes = eggNodes.filter(function (x) { return x !== c; }); }, 4500);
  }
  function wobble() {
    document.body.classList.add('egg-wobble');
    setTimeout(function () { document.body.classList.remove('egg-wobble'); }, 1400);
  }
  function fakeDelete() {
    // 假进度条：绝不碰任何文件，2.5 秒后自己取消并提示玩笑
    var b = document.createElement('div');
    b.className = 'egg-banner';
    b.style.background = 'rgba(248,81,73,.95)';
    b.textContent = '正在删除全部存档… 99%';
    document.body.appendChild(b);
    eggNodes.push(b);
    var pct = 0;
    var t = setInterval(function () {
      pct += 7;
      if (pct >= 99) {
        clearInterval(t);
        b.style.background = 'rgba(227,179,65,.95)';
        b.textContent = '开玩笑的 😄 一个文件都没动，放心。';
        setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); eggNodes = eggNodes.filter(function (x) { return x !== b; }); }, 2200);
      } else {
        b.textContent = '正在删除全部存档… ' + pct + '%';
      }
    }, 180);
  }
  var EFFECTS = [function () { banner('🎉 彩蛋模式已开启，这只是玩笑，不影响任何文件'); }, confetti, wobble, fakeDelete];
  function tickEgg() {
    if (!eggRunning) return;
    var f = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
    try { f(); } catch (e) { /* 任何异常都不应影响使用 */ }
    eggTimer = setTimeout(tickEgg, 9000 + Math.random() * 9000);
  }
  function initEgg(cfg) {
    stopEgg();
    if (cfg && cfg.easterEgg) {
      eggRunning = true;
      tickEgg();
    }
  }
  // 留出紧急关闭入口（设置页按钮 + 全局快捷键 Ctrl+Alt+E）
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.altKey && (e.key === 'e' || e.key === 'E')) {
      stopEgg();
      window.launcher.config.set({ easterEgg: false }).catch(function () {});
      banner('彩蛋模式已紧急关闭 ✅');
    }
  });

  /* ---------------- 设置页渲染 ---------------- */
  var rendered = false;
  function renderSettings(cfg) {
    var tab = $('tabSettings');
    if (!tab) return;
    cfg = cfg || {};
    var theme = cfg.theme || 'dark';
    var accent = cfg.accent || '#3ddc84';
    var title = cfg.launcherTitle || 'MC 启动器';
    var egg = !!cfg.easterEgg;
    var bk = cfg.backup || { enabled: false, intervalDays: 7, keep: 5, scope: 'world', targets: [] };
    var bkTargets = bk.targets || [];

    var chips = THEMES.map(function (t) {
      return '<button class="theme-chip' + (t.id === theme ? ' active' : '') + '" data-theme="' + t.id + '">' +
        '<span class="swatch" style="background:' + t.color + '"></span>' + t.name + '</button>';
    }).join('');

    tab.innerHTML =
      '<section class="card"><h2><span class="h2num">1</span>界面主题</h2>' +
      '<p class="hint">选一套预设主题，或用右侧取色器自定义强调色。</p>' +
      '<div class="theme-chips">' + chips +
      '<label class="theme-chip custom" title="自定义强调色"><span class="swatch"></span>' +
      '<input type="color" class="accent-input" id="accentPicker" value="' + esc(accent) + '" /></label></div>' +
      '</section>' +
      '<section class="card"><h2><span class="h2num">2</span>启动器标题文字</h2>' +
      '<div class="field-row"><input type="text" class="title-input" id="titleInput" maxlength="24" value="' + esc(title) + '" placeholder="MC 启动器" />' +
      '<button class="ghost" id="resetTitle">恢复默认</button></div>' +
      '<p class="hint">改完立即生效（任务栏窗口标题也会同步）。</p></section>' +
      '<section class="card"><h2><span class="h2num">3</span>玩笑彩蛋（千万别点）</h2>' +
      '<div class="callout-warn">开启后会在界面上随机播放<b>无害的视觉玩笑</b>（假进度条、彩带、抖动等），<b>绝不触碰你的任何文件、存档或账号</b>，可随时一键关闭。默认关闭。</div>' +
      '<div class="field-row" style="margin-top:12px">' +
      '<label class="switch inline"><input type="checkbox" id="eggToggle"' + (egg ? ' checked' : '') + ' /><span>开启彩蛋模式</span></label>' +
      '<button class="danger" id="eggStop">立即关闭彩蛋</button></div>' +
      '<p class="hint">紧急关闭快捷键：Ctrl + Alt + E</p></section>' +
      '<section class="card"><h2><span class="h2num">4</span>自动更新</h2>' +
      '<p class="hint">填 GitHub 仓库地址即可（如 https://github.com/wiuw3qde/minecraft-launcher），启动器会用 GitHub Releases 自动检查并下载更新。也可用任意静态网址（需含 latest.yml 和安装包）。</p>' +
      '<div class="field-row"><input type="url" class="grow" id="updaterUrl" placeholder="https://github.com/你的名/仓库 或 https://你的域名/MC启动器/" />' +
      '<button class="ghost" id="saveUpdaterUrl">保存</button></div>' +
      '<div class="row" style="margin-top:10px"><span class="hint">当前版本：<b id="curVersion">—</b></span>' +
      '<span class="hint" id="updStatus">未检查</span></div>' +
      '<div class="row" style="margin-top:10px"><button class="primary" id="btnCheckUpdate">立即检查更新</button>' +
      '<button class="primary" id="btnDoUpdate" hidden>下载并安装更新</button></div>' +
      '<p class="hint">发布方法：跑 <code>npm run ship</code>（打包并自动上传到 GitHub Release + 写入更新日志）。Release 页面即更新日志。</p></section>' +
      '<section class="card"><h2><span class="h2num">5</span>自动备份世界</h2>' +
      '<div class="callout-info">启动器启动时按间隔自动备份选定版本的世界（或整版本快照），防止丢档。默认关闭，与手动「备份导出」相互独立。</div>' +
      '<div class="field-row" style="margin-top:10px"><label class="switch inline"><input type="checkbox" id="bkEnable"' + (bk.enabled ? ' checked' : '') + ' /><span>启用自动备份</span></label></div>' +
      '<div class="field-row"><label class="lbl">间隔（天）</label><input type="number" id="bkInterval" min="1" max="365" value="' + (bk.intervalDays || 7) + '" class="num small" /></div>' +
      '<div class="field-row"><label class="lbl">保留份数</label><input type="number" id="bkKeep" min="1" max="99" value="' + (bk.keep || 5) + '" class="num small" /></div>' +
      '<div class="field-row"><label class="lbl">备份范围</label>' +
      '<label class="radio"><input type="radio" name="bkScope" value="world"' + (bk.scope !== 'version' ? ' checked' : '') + '/>仅世界</label>' +
      '<label class="radio"><input type="radio" name="bkScope" value="version"' + (bk.scope === 'version' ? ' checked' : '') + '/>整个版本</label></div>' +
      '<div class="field-row col"><label class="lbl">纳入自动备份的版本</label><div id="bkTargets" class="bk-targets"><span class="hint">加载中…</span></div></div>' +
      '<div class="row" style="margin-top:10px"><button class="primary" id="bkRunNow">立即备份一次</button><span class="hint" id="bkRunMsg"></span></div>' +
      '</section>' +
      '<section class="card"><h2><span class="h2num">6</span>存档安全</h2>' +
      '<div class="callout-info">启动前检查世界「上次成功打开的版本」是否变化。跨版本开档是丢档头号原因，检出风险时会先询问是否做快照或复制一份副本，再启动游戏。</div>' +
      '<div class="field-row" style="margin-top:10px"><label class="switch inline"><input type="checkbox" id="guardEnable"' + (cfg.worldGuard !== false ? ' checked' : '') + ' /><span>启用跨版本开档提醒</span></label></div>' +
      '<p class="hint">判据只依据本机记录（版本 id 与 DataVersion 的相对变化），不联网、不猜测 MC 版本对应关系；首次记录的世界只做中性提示。关闭后仍会记录状态，方便日后重新开启。所有数据仅本地保存。</p>' +
      '</section>';

    // 主题切换
    tab.querySelectorAll('.theme-chip[data-theme]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = btn.getAttribute('data-theme');
        tab.querySelectorAll('.theme-chip[data-theme]').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        save({ theme: t }).then(function (c) { applyAppearance(c); });
      });
    });
    // 自定义强调色
    var picker = $('accentPicker');
    if (picker) picker.addEventListener('input', function () {
      save({ accent: picker.value }).then(function (c) { applyAppearance(c); });
    });
    // 标题
    var ti = $('titleInput');
    if (ti) ti.addEventListener('input', function () {
      save({ launcherTitle: ti.value }).then(function (c) { applyAppearance(c); });
    });
    var rt = $('resetTitle');
    if (rt) rt.addEventListener('click', function () {
      ti.value = 'MC 启动器';
      save({ launcherTitle: 'MC 启动器' }).then(function (c) { applyAppearance(c); });
    });
    // 彩蛋开关
    var tog = $('eggToggle');
    if (tog) tog.addEventListener('change', function () {
      if (tog.checked) {
        if (!confirm('确定开启「千万别点」玩笑彩蛋吗？\n\n只是无害的视觉玩笑，不会删除或修改任何文件；可随时用「立即关闭彩蛋」按钮或快捷键 Ctrl+Alt+E 关闭。')) {
          tog.checked = false; return;
        }
      }
      save({ easterEgg: tog.checked }).then(function (c) { initEgg(c); });
    });
    var stop = $('eggStop');
    if (stop) stop.addEventListener('click', function () {
      stopEgg();
      save({ easterEgg: false }).then(function () {
        var t2 = $('eggToggle'); if (t2) t2.checked = false;
        banner('彩蛋模式已关闭 ✅');
      });
    });

    // 自动更新区块
    var updInput = $('updaterUrl');
    if (updInput) updInput.value = (cfg.updaterUrl || 'https://github.com/wiuw3qde/minecraft-launcher').trim();
    var saveU = $('saveUpdaterUrl');
    if (saveU) saveU.addEventListener('click', function () {
      var v = updInput.value.trim();
      save({ updaterUrl: v }).then(function () {
        if (v) { pushUpdMsg('已保存，正在检查更新…', 'ok'); doCheckUpdate(); }
        else { pushUpdMsg('已清除更新地址，将不再检查更新', 'ok'); }
      });
    });
    var checkBtn = $('btnCheckUpdate');
    if (checkBtn) checkBtn.addEventListener('click', doCheckUpdate);
    var doBtn = $('btnDoUpdate');
    if (doBtn) doBtn.addEventListener('click', function () {
      if (/重启/.test(doBtn.textContent)) { window.launcher.updater.quitInstall(); }
      else { doBtn.disabled = true; doBtn.textContent = '下载中…'; window.launcher.updater.download(); }
    });
    // 拉取当前版本信息
    window.launcher.updater.info().then(function (i) {
      var cv = $('curVersion');
      if (cv) cv.textContent = i.current + (i.packaged ? '' : '（开发模式不自动检查）');
    }).catch(function () {});
    // 打开设置页即主动检查一次
    doCheckUpdate();

    // 自动备份（#13）配置区块
    (function bindBackupSettings() {
      function persist(patch) { bk = Object.assign({}, bk, patch); save({ backup: bk }); }
      var en = $('bkEnable');
      if (en) en.addEventListener('change', function () { persist({ enabled: en.checked }); });
      var iv = $('bkInterval');
      if (iv) iv.addEventListener('change', function () { var v = parseInt(iv.value, 10); if (v > 0) persist({ intervalDays: v }); });
      var kp = $('bkKeep');
      if (kp) kp.addEventListener('change', function () { var v = parseInt(kp.value, 10); if (v > 0) persist({ keep: v }); });
      tab.querySelectorAll('input[name="bkScope"]').forEach(function (r) {
        r.addEventListener('change', function () { if (r.checked) persist({ scope: r.value }); });
      });
      var box = $('bkTargets');
      if (box) {
        // 游戏目录真相源：launcherUI 实时值 → 配置(cfg.gameDir) → 输入框（与版本管理页一致）
        var gd = '';
        try { gd = (window.launcherUI && window.launcherUI.gameDir) ? window.launcherUI.gameDir() : ''; } catch (e) { gd = ''; }
        if (!gd && cfg.gameDir) gd = cfg.gameDir;
        if (!gd) { var gi = document.getElementById('gameDir'); if (gi) gd = (gi.value || '').trim(); }
        if (!gd) {
          box.innerHTML = '<span class="hint">请先在「启动游戏」页选择游戏目录</span>';
        } else {
          // 注意：versions.list 返回的是 { versions: [...] } 对象，不是数组
          window.launcher.versions.list(gd).then(function (res) {
            if (!box || !box.parentNode) return;
            var list = (res && res.versions) || [];
            if (!list.length) { box.innerHTML = '<span class="hint">没有可用版本</span>'; return; }
            box.innerHTML = '';
            list.forEach(function (v) {
            var id = v && v.id ? v.id : v;
            var cb = document.createElement('label');
            cb.className = 'checkbox';
            cb.innerHTML = '<input type="checkbox" value="' + esc(id) + '"' + (bkTargets.indexOf(id) >= 0 ? ' checked' : '') + '/><span>' + esc(id) + '</span>';
            cb.querySelector('input').addEventListener('change', function (e) {
              var arr = bkTargets.slice();
              if (e.target.checked) { if (arr.indexOf(id) < 0) arr.push(id); }
              else arr = arr.filter(function (x) { return x !== id; });
              bkTargets = arr; persist({ targets: arr });
            });
            box.appendChild(cb);
          });
          }).catch(function () { if (box) box.innerHTML = '<span class="hint">版本列表加载失败</span>'; });
        }
      }
      var run = $('bkRunNow');
      if (run) run.addEventListener('click', function () {
        var msg = $('bkRunMsg');
        if (!bk.enabled && !confirm('自动备份尚未启用，确定立即手动备份一次？')) return;
        run.disabled = true; run.textContent = '备份中…'; if (msg) msg.textContent = '';
        window.launcher.version.backupRunNow().then(function (r) {
          run.disabled = false; run.textContent = '立即备份一次';
          if (!msg) return;
          if (r && r.ok && r.versionCount) msg.textContent = '已备份 ' + r.versionCount + ' 个版本' + (r.errors && r.errors.length ? ('，' + r.errors.length + ' 个出错') : '');
          else if (r && r.skipped === 'disabled') msg.textContent = '未启用自动备份';
          else if (r && r.skipped === 'not-due') msg.textContent = '尚未到间隔，已跳过';
          else if (r && !r.ok) msg.textContent = '失败：' + (r.error || '');
          else msg.textContent = '无需备份';
        }).catch(function (e) { run.disabled = false; run.textContent = '立即备份一次'; if (msg) msg.textContent = '异常：' + (e && e.message || ''); });
      });
    })();

    // S2 / N3 跨版本开档提醒开关（默认开启；关闭后仍记录状态，只是不弹窗）
    (function bindWorldGuard() {
      var ge = $('guardEnable');
      if (ge) ge.addEventListener('change', function () { save({ worldGuard: ge.checked }); });
    })();

    rendered = true;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 自动更新 UI ---------------- */
  var updSubscribed = false;
  function pushUpdMsg(msg, kind) {
    var st = $('updStatus'); if (!st) return;
    st.textContent = msg;
    st.style.color = kind === 'warn' ? '#e3b341' : (kind === 'ok' ? 'var(--accent)' : '');
  }
  function updateUI(p) {
    var st = $('updStatus'); if (!st) return; // 设置页未打开时忽略
    var btn = $('btnDoUpdate');
    if (p.type === 'available') {
      st.textContent = '发现新版本 ' + p.version + '（当前 ' + p.current + '）';
      st.style.color = 'var(--accent)';
      if (btn) { btn.hidden = false; btn.disabled = false; btn.textContent = '下载并安装 ' + p.version; }
    } else if (p.type === 'not-available') {
      st.textContent = '已是最新（' + p.current + '）';
      st.style.color = '';
      if (btn) btn.hidden = true;
    } else if (p.type === 'progress') {
      st.textContent = '下载中 ' + Math.round(p.percent) + '%';
      if (btn) { btn.hidden = false; btn.disabled = true; btn.textContent = '下载中…'; }
    } else if (p.type === 'downloaded') {
      st.textContent = '更新已下载，重启即可完成安装';
      if (btn) { btn.hidden = false; btn.disabled = false; btn.textContent = '重启并安装更新'; }
    } else if (p.type === 'error') {
      st.textContent = '更新检查失败：' + String(p.message || '').slice(0, 80);
      st.style.color = '#f85149';
      if (btn) btn.hidden = true;
    }
  }
  function doCheckUpdate() {
    if (!window.launcher || !window.launcher.updater) return;
    window.launcher.updater.check().then(function (r) {
      if (r && r.dev) pushUpdMsg('开发模式不自动检查', 'warn');
      else if (r && r.noUrl) pushUpdMsg('未配置更新地址', 'warn');
      else if (r && !r.ok) pushUpdMsg('检查失败：' + String(r.error || '').slice(0, 60), 'warn');
      // 成功时由 onStatus 推送 available / not-available 更新 UI
    }).catch(function (e) { pushUpdMsg('检查异常：' + String((e && e.message) || '').slice(0, 60), 'warn'); });
  }

  // 点击「设置」导航时懒渲染
  document.addEventListener('DOMContentLoaded', function () {
    if (!updSubscribed) {
      try { window.launcher.updater.onStatus(updateUI); updSubscribed = true; }
      catch (e) { /* ignore */ }
    }
    var btn = $('tabBtnSettings');
    if (btn) btn.addEventListener('click', function () {
      if (window.launcherNav && window.launcherNav.show) window.launcherNav.show('settings');
      window.launcher.config.get().then(function (cfg) { renderSettings(cfg); });
    });
  });

  window.Settings = {
    applyAppearance: applyAppearance,
    renderSettings: renderSettings,
    initEgg: initEgg,
  };
})();
