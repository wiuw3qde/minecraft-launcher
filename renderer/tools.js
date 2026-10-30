'use strict';
/* 工具箱页（懒渲染）：#9 任意链接下载；#4/#5 整合包导入 / 导出。
 * 所有下载/解压进度统一走右下角悬浮面板 window.DLDock。 */
(function () {
  function $(id) { return document.getElementById(id); }
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

  // 全局监听（只注册一次）
  if (!window.__toolsWired) {
    window.__toolsWired = true;
    window.launcher.onToolsProgress(function (p) {
      if (window.DLDock && window.DLDock.has(p.taskId)) window.DLDock.progress(p.taskId, p);
    });
    window.launcher.onToolsDone(function (p) {
      if (window.DLDock && window.DLDock.has(p.taskId)) window.DLDock.done(p.taskId, p);
    });
    window.launcher.onToolsLog(function (p) {
      if (window.DLDock && window.DLDock.has(p.taskId)) window.DLDock.log(p.taskId, p.text);
    });
    if (window.launcher.onModpackProgress) window.launcher.onModpackProgress(function (p) {
      if (window.DLDock && window.DLDock.has(p.taskId)) window.DLDock.progress(p.taskId, p);
    });
    if (window.launcher.onModpackDone) window.launcher.onModpackDone(function (p) {
      if (window.DLDock && window.DLDock.has(p.taskId)) window.DLDock.done(p.taskId, p);
    });
    if (window.launcher.onModpackLog) window.launcher.onModpackLog(function (p) {
      if (window.DLDock && window.DLDock.has(p.taskId)) window.DLDock.log(p.taskId, p.text);
    });
  }

  var downloadsDir = '';
  var importZip = '';

  async function render() {
    var tab = $('tabTools');
    if (!tab) return;
    if (!downloadsDir) {
      try { downloadsDir = (await window.launcher.app.downloads()) || ''; } catch (e) { downloadsDir = ''; }
    }

    tab.innerHTML =
      // #9 任意链接下载
      '<section class="card tool-block"><h3>① 输入链接下载任意文件</h3>' +
      '<div class="row"><input type="text" id="toolUrl" class="grow" placeholder="https://example.com/file.zip（支持 http/https）" />' +
      '<input type="text" id="toolName" placeholder="文件名（可选）" style="width:160px" /></div>' +
      '<div class="row"><input type="text" id="toolDest" class="grow" readonly placeholder="保存目录" value="' + esc(downloadsDir) + '" />' +
      '<button class="ghost" id="toolPickDest">选择目录</button>' +
      '<button class="primary" id="toolDownload">下载</button></div>' +
      '<p class="hint">大文件也会显示在右下角悬浮面板，可单独取消。</p></section>' +

      // #4 整合包导入
      '<section class="card tool-block"><h3>② 导入整合包</h3>' +
      '<div class="drop-zone" id="mpDrop">把整合包（.zip / .mrpack）拖到这里，或点此选择文件</div>' +
      '<input type="file" id="mpFile" accept=".zip,.mrpack" hidden />' +
      '<div class="chosen-file" id="mpChosen">未选择文件</div>' +
      '<div class="row" style="margin-top:10px">' +
      '<label class="field small"><span>导入方式</span><select id="mpTarget">' +
      '<option value="overlay">覆盖到 .minecraft（合并）</option>' +
      '<option value="instance">新建隔离实例</option></select></label>' +
      '<label class="field small" id="mpNameWrap" hidden><span>实例名称</span><input type="text" id="mpName" placeholder="例如：我的整合包" /></label>' +
      '<button class="primary" id="mpImport" disabled>导入</button></div>' +
      '<p class="hint">支持：普通 zip（含 mods/config 等）、Modrinth .mrpack、HMCL 整合包（mcbbs）。CurseForge 仅解压本地覆盖文件，远程 mod 需自行补充。</p></section>' +

      // #5 整合包导出
      '<section class="card tool-block"><h3>③ 导出整合包</h3>' +
      '<div class="row">' +
      '<label class="field small"><span>导出来源</span><select id="mpSrc">' +
      '<option value="global">.minecraft（全局）</option>' +
      '<option value="instances">隔离实例（逐个选择）</option></select></label>' +
      '<label class="field small" id="mpInstWrap" hidden><span>实例</span><select id="mpInst"></select></label>' +
      '<button class="primary" id="mpExport">导出为 zip</button></div>' +
      '<p class="hint">导出为标准 zip（.minecraft 内容），可再次用「导入」恢复；保存到下载文件夹。</p></section>' +

      // #3 导入 PCL2 / HMCL 配置
      '<section class="card tool-block"><h3>④ 导入 PCL2 / HMCL 配置</h3>' +
      '<p class="hint">从 PCL2 或 HMCL 迁移离线玩家名、Java 路径、内存、游戏版本。正版（Microsoft）账号 token 无法迁移，请在本启动器重新登录。</p>' +
      '<div class="row"><button class="ghost" id="extScan">扫描本机常见位置</button>' +
      '<button class="ghost" id="extPick">手动选择文件</button>' +
      '<input type="file" id="extFilePick" accept=".cfg,.json,.ini,.txt" hidden /></div>' +
      '<select id="extFile" class="grow" size="4" hidden></select>' +
      '<div id="extPreview" class="diag-box" hidden></div>' +
      '<div class="row" id="extImportRow" hidden>' +
      '<label class="check"><input type="checkbox" id="extImpName" /> 玩家名</label>' +
      '<label class="check"><input type="checkbox" id="extImpJava" /> Java 路径</label>' +
      '<label class="check"><input type="checkbox" id="extImpMem" /> 内存</label>' +
      '<label class="check"><input type="checkbox" id="extImpVer" /> 游戏版本</label>' +
      '<button class="primary" id="extImport">执行导入</button></div>' +
      '<div id="extResult" class="hint"></div></section>' +

      // #6 日志诊断
      '<section class="card tool-block"><h3>⑤ 启动错误日志分析</h3>' +
      '<p class="hint">粘贴游戏日志（latest.log / crash-reports/*.txt），或读取本机最近日志自动分析常见错误。</p>' +
      '<div class="row"><button class="ghost" id="diagRecent">读取最近日志</button></div>' +
      '<textarea id="diagText" class="grow" rows="9" placeholder="在此粘贴日志内容…"></textarea>' +
      '<div class="row"><button class="primary" id="diagRun">分析日志</button></div>' +
      '<div id="diagResult" class="diag-box"></div></section>';

    wireDownload();
    wireImport(tab);
    wireExport(tab);
    wireImportExternal();
    wireDiagnose();
  }

  function wireDownload() {
    $('toolPickDest').addEventListener('click', async function () {
      var r = await window.launcher.dir.pick(downloadsDir);
      if (r && r.path) { downloadsDir = r.path; $('toolDest').value = r.path; }
    });
    $('toolDownload').addEventListener('click', function () {
      var url = $('toolUrl').value.trim();
      if (!url) { alert('请先填写下载链接'); return; }
      if (!/^https?:\/\//i.test(url)) { alert('链接需以 http:// 或 https:// 开头'); return; }
      var taskId = 'tool' + Date.now() + Math.random().toString(16).slice(2);
      window.DLDock.add({
        taskId: taskId,
        title: '下载：' + (url.length > 40 ? url.slice(0, 40) + '…' : url),
        cancel: function () { window.launcher.tools.cancel(taskId); },
      });
      window.launcher.tools.downloadUrl({
        url: url,
        filename: $('toolName').value.trim(),
        destDir: $('toolDest').value.trim() || downloadsDir,
        taskId: taskId,
      });
    });
  }

  function wireImport(tab) {
    var drop = $('mpDrop');
    var file = $('mpFile');
    var chosen = $('mpChosen');
    var btn = $('mpImport');
    drop.addEventListener('click', function () { file.click(); });
    ['dragover', 'dragenter'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        setFile(e.dataTransfer.files[0].path);
      }
    });
    file.addEventListener('change', function () {
      if (file.files && file.files[0]) setFile(file.files[0].path);
    });
    function setFile(p) {
      importZip = p;
      chosen.textContent = '已选择：' + p;
      btn.disabled = false;
    }
    $('mpTarget').addEventListener('change', function () {
      $('mpNameWrap').hidden = $('mpTarget').value !== 'instance';
    });
    btn.addEventListener('click', function () {
      if (!importZip) return;
      var target = $('mpTarget').value;
      var taskId = 'mp' + Date.now() + Math.random().toString(16).slice(2);
      window.DLDock.add({
        taskId: taskId,
        title: '导入整合包：' + (importZip.split(/[\\/]/).pop()),
        cancel: function () { if (window.launcher.modpack) window.launcher.modpack.cancel(taskId); },
      });
      btn.disabled = true;
      window.launcher.modpack.import({
        zipFilePath: importZip,
        gameDir: window.launcherUI ? window.launcherUI.gameDir() : '',
        target: target,
        instanceName: $('mpName').value.trim(),
        taskId: taskId,
      }).then(function (r) {
        if (r && r.ok) {
          alert('导入完成：' + (r.message || r.instanceId || ''));
          if (window.launcherUI) window.launcherUI.refreshVersions();
        } else if (r && !r.cancelled) {
          alert('导入失败：' + (r.error || '未知错误'));
        }
        btn.disabled = false;
      }).catch(function (e) { alert('导入出错：' + e.message); btn.disabled = false; });
    });
  }

  function wireExport(tab) {
    var srcSel = $('mpSrc');
    var instWrap = $('mpInstWrap');
    var instSel = $('mpInst');
    srcSel.addEventListener('change', async function () {
      if (srcSel.value === 'instances') {
        instWrap.hidden = false;
        try {
          var gd = window.launcherUI ? window.launcherUI.gameDir() : '';
          var list = await window.launcher.versions.list(gd);
          instSel.innerHTML = '';
          (list.versions || []).forEach(function (v) {
            var o = document.createElement('option');
            o.value = v.id; o.textContent = v.id; instSel.appendChild(o);
          });
        } catch (e) { /* ignore */ }
      } else {
        instWrap.hidden = true;
      }
    });
    $('mpExport').addEventListener('click', async function () {
      var taskId = 'mpe' + Date.now() + Math.random().toString(16).slice(2);
      window.DLDock.add({
        taskId: taskId,
        title: '导出整合包…',
        cancel: function () { if (window.launcher.modpack) window.launcher.modpack.cancel(taskId); },
      });
      var src = srcSel.value;
      var gd = window.launcherUI ? window.launcherUI.gameDir() : '';
      window.launcher.modpack.export({
        gameDir: gd,
        source: src === 'instances' ? instSel.value : 'global',
        taskId: taskId,
      }).then(function (r) {
        if (r && r.ok) {
          alert('已导出到：' + r.outPath);
          window.launcher.app.openPath(r.outDir || '');
        } else if (r && !r.cancelled) {
          alert('导出失败：' + (r.error || '未知错误'));
        }
      }).catch(function (e) { alert('导出出错：' + e.message); });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('tabBtnTools');
    if (btn) btn.addEventListener('click', function () {
      if (window.launcherNav && window.launcherNav.show) window.launcherNav.show('tools');
      render();
    });
  });

  function wireImportExternal() {
    var sel = $('extFile');
    var preview = $('extPreview');
    var impRow = $('extImportRow');
    var result = $('extResult');

    function showPreview(p) {
      if (!p || !p.ok) {
        preview.hidden = true; impRow.hidden = true;
        result.textContent = p && p.error ? '解析失败：' + p.error : '';
        return;
      }
      var f = p.fields || {};
      var html = '<div class="diag-title">解析结果（' + esc(p.type || 'unknown') + '）</div><ul class="kv">';
      if (f.playerName) html += '<li><b>玩家名</b>：' + esc(f.playerName) + '</li>';
      if (f.version) html += '<li><b>游戏版本</b>：' + esc(f.version) + '</li>';
      if (f.javaPath) html += '<li><b>Java 路径</b>：' + esc(f.javaPath) + '</li>';
      if (f.maxMemory) html += '<li><b>内存</b>：' + f.maxMemory + ' MB</li>';
      html += '</ul>';
      if (p.accounts && p.accounts.length) {
        html += '<div class="hint">检测到账号：' + p.accounts
          .map(function (a) { return esc(a.name) + '（' + (a.type === 'msa' ? '正版' : '离线') + '）'; })
          .join('、') + '</div>';
      }
      if (p.warnings && p.warnings.length) {
        html += '<div class="warn-line">' + p.warnings.map(esc).join('；') + '</div>';
      }
      preview.innerHTML = html;
      preview.hidden = false;
      $('extImpName').checked = !!f.playerName;
      $('extImpJava').checked = !!f.javaPath;
      $('extImpMem').checked = !!f.maxMemory;
      $('extImpVer').checked = !!f.version;
      impRow.hidden = false;
      result.textContent = '';
    }

    $('extScan').addEventListener('click', async function () {
      var r = await window.launcher.config.scanExternal();
      sel.innerHTML = '';
      if (r && r.ok && r.files && r.files.length) {
        r.files.forEach(function (fi) {
          var o = document.createElement('option');
          o.value = fi.path; o.textContent = fi.kind + ' — ' + fi.path; sel.appendChild(o);
        });
        sel.hidden = false;
      } else {
        sel.hidden = true;
        result.textContent = '未在本机常见位置发现 PCL2/HMCL 配置文件，请用「手动选择文件」。';
      }
    });

    $('extPick').addEventListener('click', function () { $('extFilePick').click(); });
    $('extFilePick').addEventListener('change', function () {
      var fp = $('extFilePick').files && $('extFilePick').files[0] && $('extFilePick').files[0].path;
      if (!fp) return;
      sel.innerHTML = '';
      var o = document.createElement('option'); o.value = fp; o.textContent = '手动选择 — ' + fp; sel.appendChild(o);
      sel.hidden = false; sel.value = fp;
      window.launcher.config.parseExternal(fp).then(showPreview);
    });

    sel.addEventListener('change', function () {
      if (sel.value) window.launcher.config.parseExternal(sel.value).then(showPreview);
    });

    $('extImport').addEventListener('click', async function () {
      if (!sel.value) { alert('请先扫描或选择配置文件'); return; }
      var p = await window.launcher.config.parseExternal(sel.value);
      var f = (p && p.fields) || {};
      var data = {};
      if ($('extImpName').checked && f.playerName) data.playerName = f.playerName;
      if ($('extImpJava').checked && f.javaPath) data.javaPath = f.javaPath;
      if ($('extImpMem').checked && f.maxMemory) data.maxMemory = f.maxMemory;
      if ($('extImpVer').checked && f.version) data.version = f.version;
      var r = await window.launcher.config.importExternal(data);
      if (r && r.ok) {
        var msg = '已导入：' + ((r.applied && r.applied.join('、')) || '（无）');
        if (r.warnings && r.warnings.length) msg += '\n注意：' + r.warnings.join('；');
        if (data.version) msg += '\n提示：若版本「' + data.version + '」尚未安装，请到「下载」页安装。';
        result.textContent = msg;
        alert(msg);
      } else {
        result.textContent = '导入失败：' + ((r && r.error) || '未知');
      }
    });
  }

  function wireDiagnose() {
    var ta = $('diagText');
    var result = $('diagResult');

    function handleFix(action, value) {
      switch (action) {
        case 'set-memory':
          window.launcher.config.set({ maxMemory: parseInt(value, 10) || 4096 }).then(function () {
            alert('已将最大内存设为 ' + (parseInt(value, 10) || 4096) + ' MB，请在「设置」页确认。');
          });
          break;
        case 'open-settings': if (window.launcherNav) window.launcherNav.show('settings'); break;
        case 'open-mods': if (window.launcherNav) window.launcherNav.show('mods'); break;
        case 'open-launch': if (window.launcherNav) window.launcherNav.show('launch'); break;
        case 'auto-java': alert('请在「启动」页选择版本后，于 Java 设置中点击「自动检测并安装所需 Java」。'); break;
        case 'reinstall': alert('请在「版本管理」中找到对应版本，删除后用「下载」页重新安装。'); break;
        case 'clear-natives': alert('请在「版本管理」对应版本中点击「清除 natives」后重装。'); break;
        case 'driver': alert('请前往显卡厂商官网（NVIDIA / AMD / Intel）更新最新驱动。'); break;
        case 'show-log': ta.scrollIntoView(); ta.focus(); break;
        default: break;
      }
    }

    function renderDiag(r) {
      if (!r || !r.ok) { result.innerHTML = '<div class="warn-line">分析失败：' + esc(r && r.error) + '</div>'; return; }
      if (!r.hits || !r.hits.length) { result.innerHTML = '<div class="hint">' + esc(r.message) + '</div>'; return; }
      var html = '';
      r.hits.forEach(function (h) {
        var lvlTxt = h.level === 'error' ? '错误' : h.level === 'warn' ? '警告' : '提示';
        html += '<div class="diag-item ' + h.level + '"><div class="diag-h"><span class="lvl">' + lvlTxt + '</span> ' + esc(h.title) + '</div>';
        html += '<div class="diag-d">' + esc(h.detail) + '</div>';
        if (h.fixes && h.fixes.length) {
          html += '<div class="diag-fixes">';
          h.fixes.forEach(function (fx) {
            html += '<button class="mini" data-action="' + esc(fx.action) + '" data-value="' + esc(fx.value || '') + '">' + esc(fx.label) + '</button>';
          });
          html += '</div>';
        }
        html += '</div>';
      });
      result.innerHTML = html;
      Array.prototype.forEach.call(result.querySelectorAll('.mini'), function (b) {
        b.addEventListener('click', function () { handleFix(b.getAttribute('data-action'), b.getAttribute('data-value')); });
      });
    }

    $('diagRecent').addEventListener('click', async function () {
      var gd = window.launcherUI ? window.launcherUI.gameDir() : '';
      var r = await window.launcher.logDiag.recent(gd);
      if (r && r.ok && r.logs && r.logs.length) {
        var content = (r.logs[0].content || '').slice(0, 400000);
        ta.value = content;
        alert('已读取最近日志：' + r.logs[0].path.split(/[\\/]/).pop());
        renderDiag(await window.launcher.logDiag.diagnose(content));
      } else {
        result.innerHTML = '<div class="hint">未找到本机日志文件（请先启动过一次游戏）。也可手动粘贴日志分析。</div>';
      }
    });

    $('diagRun').addEventListener('click', async function () {
      var text = ta.value.trim();
      if (!text) { alert('请先粘贴日志，或点「读取最近日志」。'); return; }
      renderDiag(await window.launcher.logDiag.diagnose(text));
    });
  }

  window.Tools = { render: render };
})();
