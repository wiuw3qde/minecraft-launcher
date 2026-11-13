'use strict';
/* 联机页（独立导航页，懒渲染）：#12 陶瓦联机（Terracotta）。
 * 形态：启动器内部拉起 Terracotta 后台进程（官方 --hmcl 集成模式，随机端口），
 * 并通过 <webview> 把它的官方 Web 控制界面直接嵌进本页（不弹外部浏览器），
 * 同时用本地 REST API 轮询状态 / 房间码。类似 HMCL 的做法。
 * 下载 / 解压进度统一走右下角悬浮面板 window.DLDock。 */
(function () {
  function $(id) { return document.getElementById(id); }

  // 全局监听（只注册一次）
  if (!window.__mpWired) {
    window.__mpWired = true;
    if (window.launcher.terracotta) {
      window.launcher.terracotta.onProgress(function (p) {
        if (window.DLDock && window.DLDock.has(p.taskId)) window.DLDock.progress(p.taskId, p);
      });
      window.launcher.terracotta.onLog(function (p) {
        if (window.DLDock && window.DLDock.has(p.taskId)) window.DLDock.log(p.taskId, p.text);
      });
      window.launcher.terracotta.onDone(function (p) {
        if (window.DLDock && window.DLDock.has(p.taskId)) window.DLDock.done(p.taskId, p);
      });
    }
  }

  var tcExePath = '';
  var pollTimer = null;
  var webPortShown = null; // 已加载到 webview 的端口，避免重复 reload

  // 真实状态机（Terracotta 官方状态名）
  function stateText(s) {
    if (s === 'waiting') return '空闲';
    if (s === 'host-scanning') return '扫描本机 MC 服务器中…';
    if (s === 'host-starting') return '正在创建房间…';
    if (s === 'host-ok') return '房主托管中（已生成房间）';
    if (s === 'guest-connecting') return '正在连接房间…';
    if (s === 'guest-starting') return '正在加入房间…';
    if (s === 'guest-ok') return '已加入房间';
    if (s === 'exception') return '异常（请点「结束房间」重试）';
    return s || '未知';
  }
  function extractCode(body) {
    if (!body || typeof body !== 'object') return null;
    return body.room || body.code || body.room_code || body.roomCode || null;
  }

  async function render() {
    var tab = $('tabMultiplayer');
    if (!tab) return;

    tab.innerHTML =
      '<div class="page-head"><h2>联机 · 陶瓦联机（Terracotta）</h2>' +
      '<p class="hint">基于 <b>EasyTier</b> 的零配置联机：房主创建房间码，好友输入房间码即可如同同一局域网，无需公网 IP / 端口映射。本页在启动器内部直接驱动陶瓦联机（Web 界面已嵌入下方，不打开浏览器）。</p></div>' +

      '<section class="card tool-block"><h3>① 安装与启动</h3>' +
      '<div class="row"><span class="status-badge" id="tcSvcStatus">检测中…</span>' +
      '<button class="primary" id="tcInstall">安装 / 更新</button>' +
      '<button class="primary" id="tcLaunch" hidden>启动联机</button>' +
      '<button class="ghost" id="tcStop" hidden>停止联机</button></div>' +
      '<p class="hint" id="tcSvcTip"></p>' +
      '<div class="callout-info" id="tcMacBox" hidden>' +
      '<b>macOS 首次使用需安装系统组件</b>：陶瓦联机依赖后台守护进程创建虚拟网卡（TUN）。' +
      '请点下方按钮打开随包附带的 <code>.pkg</code>，按系统提示输入管理员密码完成安装，再回来点「启动联机」。' +
      '<div class="row" style="margin-top:8px"><button class="ghost small" id="tcOpenPkg">打开系统组件安装包</button>' +
      '<span class="hint" id="tcOpenPkgMsg"></span></div></div>' +
      '</section>' +

      '<section class="card tool-block"><h3>② 联机界面（已嵌入启动器）</h3>' +
      '<div class="tc-web-wrap" id="tcWebWrap">' +
      '<div class="tc-web-ph" id="tcWebPh">尚未启动。先在「① 安装与启动」点「启动联机」，官方联机界面会出现在这里（输入端口、创建 / 加入房间都在其中完成）。</div>' +
      '<webview id="tcWeb" partition="persist:terracotta" class="tc-web" style="display:none"></webview>' +
      '</div>' +
      '<p class="hint" id="tcWebFail" hidden>Web 界面加载失败（可能是网络隔离）。请用下方「③ 备用：手动创建 / 加入」。</p></section>' +

      '<section class="card tool-block"><h3>联机状态</h3>' +
      '<div class="row"><span class="status-badge" id="tcState">检测中…</span>' +
      '<button class="ghost" id="tcCopyCode" hidden>复制房间码</button></div>' +
      '<div class="tc-room"><span class="tc-room-label">房间码</span><code id="tcRoomCode">—</code></div>' +
      '<p class="hint" id="tcStateTip"></p></section>' +

      '<section class="card tool-block"><h3>③ 备用：手动创建 / 加入</h3>' +
      '<p class="hint">若上方 Web 界面不可用，可在此直接调用联机：先开好 MC 局域网 / 服务器（默认端口 <b>25565</b>），再点「创建房间」；好友粘贴房间码点「加入房间」。这些按钮在后台通过陶瓦联机本地接口完成，同样不打开浏览器。</p>' +
      '<div class="row"><label class="field small"><span>MC 服务器端口</span>' +
      '<input type="text" id="tcPort" value="25565" style="width:110px" /></label>' +
      '<button class="primary" id="tcCreate">创建房间</button>' +
      '<button class="ghost" id="tcEnd">结束房间</button></div>' +
      '<div class="row"><input type="text" id="tcRoomInput" class="grow" placeholder="例如 U/XXXX-XXXX-XXXX-XXXX 或房间码" />' +
      '<button class="primary" id="tcJoin">加入房间</button></div></section>' +

      '<section class="card tool-block"><h3>关于 / 版权</h3>' +
      '<p class="tc-credit">陶瓦联机 <b>Terracotta</b> 由 <b>burningtnt</b> 开发，基于 <b>EasyTier</b>，采用 <b>AGPL-3.0</b> 许可。本启动器按 AGPL 例外条款，以官方 <code>--hmcl</code> 集成模式驱动其未修改二进制，并将 Web 界面嵌入本页（显著标注版权）；源码见 ' +
      '<code>https://github.com/burningtnt/Terracotta</code>（仅作说明）。</p></section>';

    wire();
  }

  async function refreshSvc() {
    var badge = $('tcSvcStatus');
    var installBtn = $('tcInstall');
    var launchBtn = $('tcLaunch');
    var stopBtn = $('tcStop');
    var tip = $('tcSvcTip');
    if (!badge) return;
    var s = {};
    try { s = await window.launcher.terracotta.status(); } catch (e) { s = {}; }
    tcExePath = s.exePath || '';
    var webUrl = s.webUrl || null;
    var macBox = $('tcMacBox');
    if (macBox) macBox.hidden = !s.needsPrivilegedInstall;
    if (!s.installed) {
      badge.textContent = '未安装'; badge.className = 'status-badge bad';
      installBtn.hidden = false; launchBtn.hidden = true; stopBtn.hidden = true;
      if (tip) tip.textContent = '尚未安装陶瓦联机，点「安装 / 更新」一键获取官方程序（约 8 MB）。';
      hideWeb();
      stopPolling();
    } else if (s.running) {
      badge.textContent = '运行中'; badge.className = 'status-badge good';
      installBtn.hidden = true; launchBtn.hidden = true; stopBtn.hidden = false;
      if (tip) tip.textContent = '陶瓦联机已在后台运行，官方联机界面已嵌入本页。';
      showWeb(webUrl);
      startPolling();
    } else {
      badge.textContent = '已安装（未运行）'; badge.className = 'status-badge ok';
      installBtn.hidden = false; launchBtn.hidden = false; stopBtn.hidden = true;
      if (tip) tip.textContent = '点「启动联机」，在启动器内部拉起陶瓦联机后台进程并嵌入界面。';
      hideWeb();
      stopPolling();
    }
  }

  function showWeb(webUrl) {
    var ph = $('tcWebPh');
    var web = $('tcWeb');
    var fail = $('tcWebFail');
    if (!web) return;
    if (webUrl) {
      var port = webUrl.match(/:(\d+)\//);
      var p = port ? port[1] : null;
      if (p && p !== String(webPortShown)) {
        webPortShown = Number(p);
        web.src = webUrl;
        if (fail) fail.hidden = true;
      }
      if (ph) ph.style.display = 'none';
      web.style.display = 'block';
    } else {
      if (ph) { ph.style.display = 'block'; ph.textContent = '陶瓦联机已启动，但暂未拿到 Web 界面地址，请稍候或刷新本页；也可用下方「③ 备用」。'; }
      web.style.display = 'none';
    }
  }
  function hideWeb() {
    webPortShown = null;
    var ph = $('tcWebPh'); var web = $('tcWeb');
    if (ph) { ph.style.display = 'block'; ph.textContent = '尚未启动。先在「① 安装与启动」点「启动联机」，官方联机界面会出现在这里（输入端口、创建 / 加入房间都在其中完成）。'; }
    if (web) { web.style.display = 'none'; web.src = ''; }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollState, 1500);
    pollState();
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function pollState() {
    var badge = $('tcState');
    var codeEl = $('tcRoomCode');
    var tip = $('tcStateTip');
    var copyBtn = $('tcCopyCode');
    if (!badge) return;
    var r;
    try { r = await window.launcher.terracotta.api('state'); } catch (e) { r = null; }
    if (!r || !r.ok) {
      badge.textContent = '（联机未运行）'; badge.className = 'status-badge bad';
      if (codeEl) codeEl.textContent = '—';
      if (copyBtn) copyBtn.hidden = true;
      if (tip) tip.textContent = '陶瓦联机未运行，请先在「① 安装与启动」启动它。';
      return;
    }
    var body = r.body || {};
    var st = body.state || '';
    badge.textContent = stateText(st);
    badge.className = 'status-badge ' + (st === 'host-ok' || st === 'guest-ok' ? 'good' : (st === 'exception' ? 'bad' : (st === 'waiting' ? 'bad' : 'ok')));
    var code = extractCode(body);
    if (codeEl) codeEl.textContent = code ? code : (st === 'host-ok' ? '生成中…' : (st === 'guest-ok' ? '已连接' : '—'));
    if (copyBtn) copyBtn.hidden = !(code);
    if (tip) {
      if (st === 'host-ok') tip.textContent = '房间已创建！把上面的房间码发给好友，让他在「③ 加入房间」输入即可。';
      else if (st === 'guest-ok') tip.textContent = '已加入房间，打开 Minecraft → 多人游戏 → 双击「陶瓦联机大厅」即可进入对方世界。';
      else if (st === 'host-scanning' || st === 'host-starting') tip.textContent = '正在扫描本机 MC 服务器，请确认你的 MC 局域网 / 服务器已开启（默认端口 25565）。';
      else if (st === 'guest-connecting' || st === 'guest-starting') tip.textContent = '正在通过房间码建立连接，请稍候…';
      else if (st === 'exception') tip.textContent = '出现异常，请点「结束房间」后再试。';
      else tip.textContent = '空闲：可作为房主「创建房间」，或作为好友「加入房间」。';
    }
  }

  function wire() {
    var installBtn = $('tcInstall');
    var launchBtn = $('tcLaunch');
    var stopBtn = $('tcStop');
    var createBtn = $('tcCreate');
    var endBtn = $('tcEnd');
    var joinBtn = $('tcJoin');
    var copyBtn = $('tcCopyCode');
    var web = $('tcWeb');
    var fail = $('tcWebFail');
    var openPkgBtn = $('tcOpenPkg');

    if (openPkgBtn) {
      openPkgBtn.addEventListener('click', function () {
        var msg = $('tcOpenPkgMsg');
        window.launcher.terracotta.openPkg().then(function (r) {
          if (msg) msg.textContent = r.ok
            ? '已打开安装器，完成后回来点「启动联机」。'
            : ('打开失败：' + (r.error || '未知错误'));
        }).catch(function (e) {
          if (msg) msg.textContent = '打开失败：' + e.message;
        });
      });
    }

    // webview 加载失败兜底
    if (web && fail) {
      web.addEventListener('did-fail-load', function () { fail.hidden = false; });
      web.addEventListener('did-get-redirect-request', function () {});
    }

    refreshSvc();

    installBtn.addEventListener('click', function () {
      var taskId = 'tc' + Date.now() + Math.random().toString(16).slice(2);
      window.DLDock.add({
        taskId: taskId,
        title: '安装陶瓦联机（Terracotta）',
        cancel: function () { alert('安装进行中，暂不支持取消，请等待完成'); },
      });
      installBtn.disabled = true;
      window.launcher.terracotta.install({ taskId: taskId }).then(function (r) {
        installBtn.disabled = false;
        if (r && r.ok) {
          setTimeout(function () { alert('陶瓦联机安装完成！现在点「启动联机」拉起它，界面会嵌入本页。'); }, 300);
        } else if (r && r.error) {
          alert('安装失败：' + r.error);
        }
        refreshSvc();
      }).catch(function (e) { installBtn.disabled = false; alert('安装出错：' + e.message); refreshSvc(); });
    });

    launchBtn.addEventListener('click', function () {
      launchBtn.disabled = true;
      window.launcher.terracotta.launch().then(function (r) {
        launchBtn.disabled = false;
        if (r && !r.ok && r.error) alert('启动失败：' + r.error);
        refreshSvc();
      }).catch(function (e) { launchBtn.disabled = false; alert('启动出错：' + e.message); });
    });

    stopBtn.addEventListener('click', function () {
      window.launcher.terracotta.stop().then(function () { stopPolling(); refreshSvc(); })
        .catch(function (e) { alert('停止出错：' + e.message); });
    });

    createBtn.addEventListener('click', async function () {
      var port = ($('tcPort').value || '25565').trim();
      var probe;
      try { probe = await window.launcher.terracotta.api('state'); } catch (e) { probe = null; }
      if (!probe || !probe.ok) { alert('请先在「① 安装与启动」点「启动联机」，再创建房间。'); return; }
      createBtn.disabled = true;
      var r;
      try { r = await window.launcher.terracotta.api('state/scanning?port=' + encodeURIComponent(port)); } catch (e) { r = null; }
      createBtn.disabled = false;
      if (!r || !r.ok) { alert('创建房间失败：' + ((r && r.error) || '未知错误') + '（请确认陶瓦联机已启动且 MC 局域网/服务器已开）'); return; }
      startPolling();
    });

    endBtn.addEventListener('click', async function () {
      var r;
      try { r = await window.launcher.terracotta.api('state/ide'); } catch (e) { r = null; }
      if (!r || !r.ok) { alert('结束房间失败：' + ((r && r.error) || '未知错误')); return; }
      pollState();
    });

    joinBtn.addEventListener('click', async function () {
      var code = ($('tcRoomInput').value || '').trim();
      if (!code) { alert('请先粘贴房主给的房间码'); return; }
      var probe;
      try { probe = await window.launcher.terracotta.api('state'); } catch (e) { probe = null; }
      if (!probe || !probe.ok) { alert('请先在「① 安装与启动」点「启动联机」，再加入房间。'); return; }
      joinBtn.disabled = true;
      var r;
      try { r = await window.launcher.terracotta.api('state/guesting?room=' + encodeURIComponent(code)); } catch (e) { r = null; }
      joinBtn.disabled = false;
      if (!r || !r.ok) { alert('加入失败：' + ((r && r.error) || '无效房间码或网络异常')); return; }
      startPolling();
    });

    copyBtn.addEventListener('click', function () {
      var code = $('tcRoomCode').textContent;
      if (!code || code === '—' || code === '生成中…') return;
      if (window.launcher.app && window.launcher.app.copyText) {
        window.launcher.app.copyText(code);
        copyBtn.textContent = '已复制 ✓';
        setTimeout(function () { copyBtn.textContent = '复制房间码'; }, 1500);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('tabBtnMultiplayer');
    if (btn) btn.addEventListener('click', function () {
      if (window.launcherNav && window.launcherNav.show) window.launcherNav.show('multiplayer');
      render();
    });
  });

  window.Multiplayer = { render: render };
})();
