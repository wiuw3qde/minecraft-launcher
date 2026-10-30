'use strict';
/* 真实 Electron 冒烟探针（本轮改动）：
 * 1) 模组详情页：真实拉 MTR 详情，检查全量版本分组 + 前置模组渲染
 * 2) 右侧悬浮下载面板：新增任务后出现、可收起为胶囊、每个任务有独立取消按钮
 * 3) 下载中途取消：真实走 IPC，确认能停住（不是只设标志）
 * 4) PMC 分区 UA 已去掉 Electron 标识
 * 5) 全程收集 JS 报错
 */
require('../main.js');
const { app, BrowserWindow, session } = require('electron');

function log(...a) { console.log('[probe]', ...a); }

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const wins = BrowserWindow.getAllWindows();
  if (!wins.length) { log('NO WINDOW'); process.exit(1); }
  const win = wins[0];
  await new Promise((r) => setTimeout(r, 1500));

  const errors = [];
  win.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level >= 1) errors.push(msg + ' (' + src + ':' + line + ')');
  });

  const J = async (code) => JSON.parse(await win.webContents.executeJavaScript('JSON.stringify((function(){' + code + '})())'));

  /* ---- 1. PMC 分区 UA ---- */
  const ua = session.fromPartition('persist:pmc').getUserAgent();
  log('PMC UA:', ua);
  log('UA 不含 Electron:', ua.indexOf('Electron') < 0 ? 'PASS' : 'FAIL');

  /* ---- 2. DLDock 存在且初始隐藏 ---- */
  const dock0 = await J(`
    return {
      hasDock: typeof window.DLDock === 'object',
      dockEl: !!document.querySelector('.dl-dock'),
      dockHidden: document.querySelector('.dl-dock') ? document.querySelector('.dl-dock').hidden : null,
      pillHidden: document.querySelector('.dl-dock-pill') ? document.querySelector('.dl-dock-pill').hidden : null,
    };
  `);
  log('DLDock 初始:', JSON.stringify(dock0));

  /* ---- 3. 模组详情页（真实网络：MTR） ---- */
  const detail = await win.webContents.executeJavaScript(`
    new Promise(res => {
      window.launcherNav.show('mods');
      modOpenDetail('XKPAmI6u', 'Minecraft Transit Railway');
      var t0 = Date.now();
      var iv = setInterval(function () {
        var groups = document.querySelectorAll('.md-modal .md-vgroup').length;
        var rows = document.querySelectorAll('.md-modal .md-vrow').length;
        if (rows > 0 || Date.now() - t0 > 25000) {
          clearInterval(iv);
          var m = document.querySelector('.md-modal');
          res(JSON.stringify({
            modalVisible: !m.hidden,
            title: (m.querySelector('.md-title')||{}).textContent,
            sub: (m.querySelector('.md-sub')||{}).textContent,
            groups: groups,
            rows: rows,
            deps: document.querySelectorAll('.md-modal .md-dep').length,
            verCount: (m.querySelector('.md-ver-count')||{}).textContent,
            gvOptions: m.querySelector('.md-gv').options.length,
            firstGroup: (document.querySelector('.md-vgroup-gv')||{}).textContent,
            firstGroupLoaders: (document.querySelector('.md-vgroup-loaders')||{}).textContent,
          }));
        }
      }, 200);
    });
  `);
  log('详情页:', detail);

  /* ---- 4. 悬浮面板：加任务 -> 出现 + 有取消按钮；收起 -> 胶囊 ---- */
  const dock1 = await J(`
    window.DLDock.add({ taskId: 'probe1', title: 'probe-test.jar', cancel: function(){ window.__probeCancelled = true; } });
    var d = document.querySelector('.dl-dock');
    var task = document.querySelector('.dl-task');
    return {
      dockHidden: d.hidden,
      bodyHidden: d.querySelector('.dl-dock-body').hidden,
      taskCount: document.querySelectorAll('.dl-task').length,
      hasCancelBtn: !!task.querySelector('.dl-task-x'),
      name: task.querySelector('.dl-task-name').textContent,
    };
  `);
  log('加任务后:', JSON.stringify(dock1));

  const dock2 = await J(`
    window.DLDock.progress('probe1', { percent: 42, loaded: 4200, total: 10000 });
    var t = document.querySelector('.dl-task');
    var s1 = { pct: t.querySelector('.dl-task-pct').textContent, status: t.querySelector('.dl-task-status').textContent, barW: t.querySelector('.dl-task-bar').style.width };
    // 点收起
    document.querySelector('.dl-dock-min').click();
    var d = document.querySelector('.dl-dock');
    var p = document.querySelector('.dl-dock-pill');
    return { progress: s1, afterCollapse: { dockHidden: d.hidden, pillHidden: p.hidden, pillText: p.textContent } };
  `);
  log('进度 + 收起:', JSON.stringify(dock2));

  const dock3 = await J(`
    // 点胶囊展开
    document.querySelector('.dl-dock-pill').click();
    var d = document.querySelector('.dl-dock');
    // 点单个任务的取消按钮
    document.querySelector('.dl-task .dl-task-x').click();
    return { expanded: !d.hidden, cancelled: !!window.__probeCancelled };
  `);
  log('展开 + 取消按钮:', JSON.stringify(dock3));

  /* ---- 5. 完成态与取消态渲染 ---- */
  const dock4 = await J(`
    window.DLDock.done('probe1', { ok: false, cancelled: true });
    var t = document.querySelector('.dl-task');
    var cancelCls = t.className;
    window.DLDock.add({ taskId:'probe2', title:'ok.jar', cancel:function(){} });
    window.DLDock.done('probe2', { ok: true, dest: 'D:/mods/ok.jar' });
    return {
      cancelledTask: { cls: cancelCls, status: t.querySelector('.dl-task-status').textContent },
      okTaskCls: document.querySelectorAll('.dl-task')[0].className,
    };
  `);
  log('取消态/完成态:', JSON.stringify(dock4));

  /* ---- 6. 真实走一次 IPC 取消（确认后端真的会停） ---- */
  const realCancel = await win.webContents.executeJavaScript(`
    new Promise(res => {
      var gd = document.getElementById('gameDir').value;
      if (!gd) { res(JSON.stringify({ skipped: 'no gameDir' })); return; }
      var tid = 'probeCancel' + Date.now();
      window.DLDock.add({ taskId: tid, title: 'cancel-me.jar', cancel: function(){ window.launcher.mods.cancel(tid); } });
      var t0 = Date.now();
      window.launcher.mods.download({ taskId: tid, projectId: 'XKPAmI6u', versionId: null, destDir: gd + '\\\\mods' })
        .then(function (r) {
          res(JSON.stringify({ ok: r.ok, cancelled: !!r.cancelled, error: r.error || null, ms: Date.now() - t0 }));
        }).catch(function (e) { res('ERR ' + e.message); });
      setTimeout(function () { window.launcher.mods.cancel(tid); }, 300);
    });
  `);
  log('真实 IPC 取消:', realCancel);

  await new Promise((r) => setTimeout(r, 600));
  log('JS errors:', errors.length ? errors : 'NONE');
  process.exit(0);
});
app.on('window-all-closed', () => {});
