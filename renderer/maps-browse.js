'use strict';
/* 地图下载页：Planet Minecraft 因有反爬保护，无法在后端直接爬取，
 * 故用启动器内嵌的真实浏览器（webview）浏览；但该站 Cloudflare 托管挑战在 webview 里经常过不去，
 * 因此「在浏览器打开 PMC」是更可靠的下载路径（真实浏览器能顺畅过验证）。
 * 用户在站内点下载后文件落到下载文件夹，再用「安装本地地图 zip」一键解压到 saves/。无需任何 API Key。
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function copyText(t) {
    // 优先用主进程剪贴板（最稳，绕过渲染层剪贴板权限问题）
    try {
      if (window.launcher && window.launcher.app && window.launcher.app.copyText) {
        window.launcher.app.copyText(t);
        return;
      }
    } catch (e) {}
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return; }
    } catch (e) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e2) {}
      document.body.removeChild(ta);
    } catch (e) {}
  }
  function gameDirNow() {
    if (window.launcherUI && window.launcherUI.gameDir) {
      var g = window.launcherUI.gameDir();
      if (g) return g;
    }
    var e = $('gameDir');
    return e ? e.value.trim() : '';
  }
  function resolveSavesRoot(val, gd) {
    if (!val || val === 'global') return gd;
    if (val.indexOf('ver:') === 0) return gd + (gd.indexOf('\\') >= 0 ? '\\instances\\' : '/instances/') + val.slice(4);
    return gd;
  }
  function savesSubDir(gd) {
    return gd.indexOf('\\') >= 0 ? '\\saves' : '/saves';
  }

  var PMC_URL = 'https://www.planetminecraft.com/projects/?section=worlds';

  function init() {
    var c = $('tabMaps');
    if (!c) return;

    c.innerHTML =
      '<section class="card">' +
      '<h2><span class="h2num">★</span>下载地图（Planet Minecraft）</h2>' +
      '<p class="hint">地图来源 Planet Minecraft（全球最大 MC 地图社区）。该站有 Cloudflare 反爬保护，' +
      '启动器提供两种方式：① 下方内嵌浏览器直接浏览（偶尔会被验证拦截）；② <b>「在浏览器打开 PMC」</b>用你自己的浏览器下载（最稳，推荐）。' +
      '在站内点地图的 <b>Download</b> 后，文件会保存到下载文件夹，再用「安装本地地图 zip」一键装到 <code>saves/</code>。</p>' +
      '</section>' +
      '<section class="card"><h2><span class="h2num">1</span>浏览与下载地图</h2>' +
      '<div class="row" style="margin-bottom:8px">' +
      '<button class="ghost map-reload">重新加载</button>' +
      '<button class="ghost map-back">后退</button>' +
      '<button class="primary map-open-pmc-top">在浏览器打开 PMC（推荐）</button>' +
      '</div>' +
      '<div class="pmc-banner" hidden></div>' +
      '<div class="pmc-webview-host" style="width:100%;height:420px;border:1px solid #222;border-radius:8px;background:#0a0e14;overflow:hidden;"></div>' +
      '<p class="hint">内嵌浏览器里若停在「验证您是真人」的复选框，请<b>直接点那个方框</b>完成验证即可进入；若多次失败，点上方「在浏览器打开 PMC」用真实浏览器下载最稳妥。</p>' +
      '</section>' +
      '<section class="card"><h2><span class="h2num">2</span>安装到游戏</h2>' +
      '<div class="row">' +
      '<select class="grow map-target"></select>' +
      '<button class="primary map-install-btn">安装本地地图 zip</button>' +
      '<button class="ghost map-open-saves">打开 saves 文件夹</button>' +
      '<button class="ghost map-open-pmc">在浏览器打开 PMC</button>' +
      '</div>' +
      '<p class="map-status hint"></p>' +
      '<input type="file" id="mapZipInput" accept=".zip" style="display:none" />' +
      '</section>';

    // 编程创建 webview（比 innerHTML 注入更可靠）
    var host = c.querySelector('.pmc-webview-host');
    var banner = c.querySelector('.pmc-banner');
    var wv = null;
    try {
      wv = document.createElement('webview');
      wv.setAttribute('src', PMC_URL);
      wv.setAttribute('partition', 'persist:pmc');
      // UA 由 main.js 在 persist:pmc 会话上统一设置（真实 Chromium 版本、去掉 Electron 段），
      // 这里不重复设 useragent 属性，避免渲染端取不到真实版本号反而覆盖成假版本。
      wv.setAttribute('allowpopups', '');
      wv.style.width = '100%';
      wv.style.height = '100%';
      wv.style.border = '0';
      host.appendChild(wv);

      // 挑战检测：加载完成后看页面是否仍是 Cloudflare 验证页，是则弹出指引横幅
      wv.addEventListener('did-stop-loading', function () {
        setTimeout(function () {
          try {
            wv.executeJavaScript(
              "(function(){var t=(document.body&&document.body.innerText)||'';" +
              "return t.indexOf('安全验证')>=0||t.indexOf('verify you are human')>=0||" +
              "t.indexOf('Checking your browser')>=0||t.indexOf('Just a moment')>=0;})()"
            ).then(function (isChallenge) {
              if (isChallenge) showBanner(); else hideBanner();
            }).catch(function () { hideBanner(); });
          } catch (e) { hideBanner(); }
        }, 1200);
      });
    } catch (e) {
      wv = null;
      host.innerHTML = '<div class="empty"><div class="empty-text"><b>内置浏览器不可用</b><p>请用「在浏览器打开 PMC」按钮，在外部浏览器下载地图后用「安装本地地图 zip」导入。</p></div></div>';
    }

    function showBanner() {
      if (!banner) return;
      banner.hidden = false;
      banner.innerHTML =
        '⚠️ 内嵌浏览器被 Cloudflare 验证拦住了。请<b>直接点击页面里的复选框</b>完成「验证您是真人」即可进入；' +
        '若试了几次仍过不去，点 <button class="primary map-open-pmc-banner" style="margin:0 6px">在浏览器打开 PMC（推荐）</button> 用你自己的浏览器下载最稳。';
      var b = banner.querySelector('.map-open-pmc-banner');
      if (b) b.addEventListener('click', openPmc);
    }
    function hideBanner() { if (banner) banner.hidden = true; }

    var reloadBtn = c.querySelector('.map-reload');
    var backBtn = c.querySelector('.map-back');
    if (reloadBtn) reloadBtn.addEventListener('click', function () { if (wv) { try { wv.reload(); hideBanner(); } catch (e) {} } });
    if (backBtn) backBtn.addEventListener('click', function () { if (wv) { try { if (wv.canGoBack()) wv.goBack(); } catch (e) {} } });

    var targetSel = c.querySelector('.map-target');
    var fileInput = c.querySelector('#mapZipInput');
    var status = c.querySelector('.map-status');

    function loadTargets() {
      var gd = gameDirNow();
      if (!gd) { targetSel.innerHTML = '<option value="">请先在「启动游戏」页选择游戏目录</option>'; return; }
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
    loadTargets();

    c.querySelector('.map-install-btn').addEventListener('click', function () { fileInput.value = ''; fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      var gd = gameDirNow();
      if (!gd) { alert('请先在「启动游戏」页选择游戏目录'); return; }
      var targetVal = targetSel.value;
      if (!targetVal) { alert('请先选择安装位置'); return; }
      var root = resolveSavesRoot(targetVal, gd) + savesSubDir(gd);
      status.textContent = '正在解压安装「' + (f.name || '地图') + '」…';
      window.launcher.maps.installZip({ zipFilePath: f.path, gameDir: gd, target: targetVal }).then(function (r) {
        if (!r.ok) { status.innerHTML = '<span style="color:var(--danger)">安装失败：' + esc(r.error) + '</span>'; return; }
        status.textContent = '✓ 已安装世界「' + r.installed + '」到 ' + r.dest;
      }).catch(function (e) { status.innerHTML = '<span style="color:var(--danger)">安装失败：' + esc(e.message) + '</span>'; });
    });

    c.querySelector('.map-open-saves').addEventListener('click', function () {
      var gd = gameDirNow();
      if (!gd) { alert('请先在「启动游戏」页选择游戏目录'); return; }
      var savesDir = resolveSavesRoot(targetSel.value, gd) + savesSubDir(gd);
      window.launcher.app.openPath(savesDir);
    });

    // 在浏览器打开 PMC：把链接显示出来 + 自动复制到剪贴板 + 允许手动复制（不再依赖自动跳转浏览器）
    function openPmc() {
      var box = $('pmcUrlBox');
      if (!box) {
        box = document.createElement('div');
        box.id = 'pmcUrlBox';
        box.className = 'url-box';
        box.innerHTML =
          '<div class="row" style="margin:8px 0">' +
          '<input type="text" class="grow pmc-url" readonly />' +
          '<button class="ghost pmc-copy">复制链接</button>' +
          '</div>';
        if (status && status.parentNode) status.parentNode.insertBefore(box, status);
        var copyBtn = box.querySelector('.pmc-copy');
        copyBtn.addEventListener('click', function () {
          copyText(PMC_URL);
          var inp = box.querySelector('.pmc-url');
          if (inp) inp.select();
          copyBtn.textContent = '已复制 ✓';
          setTimeout(function () { copyBtn.textContent = '复制链接'; }, 1500);
        });
      }
      var inp = box.querySelector('.pmc-url');
      if (inp) inp.value = PMC_URL;
      // 自动复制（主进程剪贴板最稳；失败也不阻断）
      copyText(PMC_URL);
      if (inp) inp.select();
      if (status) {
        status.innerHTML = '已为你<b>显示 Planet Minecraft 链接并自动复制到剪贴板</b>。若没复制成功，请手动选中下方链接框按 Ctrl+C，再粘贴到浏览器打开。' +
          '在站内点地图的 <b>Download</b> 后文件会进下载文件夹，再用「安装本地地图 zip」导入即可。';
      }
    }
    var topBtn = c.querySelector('.map-open-pmc-top');
    if (topBtn) topBtn.addEventListener('click', openPmc);
    c.querySelector('.map-open-pmc').addEventListener('click', openPmc);

    if (typeof window.launcher.onMapsDownloadDone === 'function') {
      window.launcher.onMapsDownloadDone(function (p) {
        if (p.ok) status.textContent = '已下载「' + p.name + '」到下载文件夹，点「安装本地地图 zip」选择它即可自动装到 saves/。';
        else status.textContent = '下载未完成（可能被取消）。';
      });
    }

    var b = $('tabBtnMaps');
    if (b) b.addEventListener('click', function () {
      if (window.launcherNav && window.launcherNav.show) window.launcherNav.show('maps');
      loadTargets();
    });

    c.__refresh = loadTargets;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
