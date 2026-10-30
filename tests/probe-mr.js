'use strict';
/* 真实 Electron 冒烟探针：加载真实 main.js，验证 Modrinth 三页（资源包/光影/地图）UI、真实搜索、标签隔离、无 JS 报错。 */
require('../main.js');
const { app, BrowserWindow } = require('electron');

function log(...a) { console.log('[probe]', ...a); }

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2000));
  const wins = BrowserWindow.getAllWindows();
  if (!wins.length) { log('NO WINDOW'); process.exit(1); }
  const win = wins[0];
  await new Promise((r) => setTimeout(r, 2000));

  const errors = [];
  win.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level >= 1) errors.push(msg + ' (' + src + ':' + line + ')');
  });
  win.webContents.on('did-fail-load', (e, code, desc) => log('did-fail-load', code, desc));

  // 资源包 / 光影 页 tab 存在
  const tabs = await win.webContents.executeJavaScript(`
    JSON.stringify({
      shaders: !!document.querySelector('[data-mr-browse][data-mr-type="shader"]'),
      rp: !!document.querySelector('[data-mr-browse][data-mr-type="resourcepack"]'),
      mapsHost: !!document.querySelector('#tabMaps .pmc-webview-host'),
    });
  `).then(JSON.parse);
  log('tabs:', JSON.stringify(tabs));

  // 真实搜索：shader
  const sh = await win.webContents.executeJavaScript(`
    new Promise(res => {
      window.launcherNav.show('shaders');
      window.launcher.mr.search({ projectType:'shader', query:'realistic', limit:3 })
        .then(r => res(JSON.stringify({ ok:r.ok, total:r.total, hits:(r.hits||[]).length, err:r.error||null })))
        .catch(e => res('ERR '+e.message));
    });
  `);
  log('MR shader search:', sh);

  // 真实搜索：resourcepack
  const rp = await win.webContents.executeJavaScript(`
    new Promise(res => {
      window.launcherNav.show('resourcepacks');
      window.launcher.mr.search({ projectType:'resourcepack', query:'sword', limit:3 })
        .then(r => res(JSON.stringify({ ok:r.ok, total:r.total, hits:(r.hits||[]).length, err:r.error||null })))
        .catch(e => res('ERR '+e.message));
    });
  `);
  log('MR resourcepack search:', rp);

  // 地图页 + webview 元素
  const mp = await win.webContents.executeJavaScript(`
    window.launcherNav.show('maps');
    JSON.stringify({
      host: !!document.querySelector('#tabMaps .pmc-webview-host'),
      wv: !!document.querySelector('#tabMaps webview'),
    });
  `).then(JSON.parse);
  log('maps tab:', JSON.stringify(mp));

  // 标签隔离：当前应只有 maps 可见
  const vis = await win.webContents.executeJavaScript(`
    ['launch','download','mods','versions','maps','shaders','resourcepacks']
      .filter(n => !document.getElementById('tab'+n.charAt(0).toUpperCase()+n.slice(1)).hidden).join(',');
  `);
  log('visible tabs (expect only maps):', vis);

  // maps:install-zip 错误处理（不存在的 zip 应优雅返回，而非崩）
  const gd = await win.webContents.executeJavaScript("document.getElementById('gameDir').value || ''");
  const zipErr = await win.webContents.executeJavaScript(`
    new Promise(res => {
      window.launcher.maps.installZip({ zipFilePath:'C:/__nonexistent_map__.zip', gameDir: document.getElementById('gameDir').value, target:'global' })
        .then(r => res(JSON.stringify(r))).catch(e => res('ERR '+e.message));
    });
  `);
  log('maps:install-zip (bad file) gameDir=' + JSON.stringify(gd) + ' ->', zipErr);

  await new Promise((r) => setTimeout(r, 800));
  log('JS errors:', errors.length ? errors : 'NONE');
  process.exit(0);
});
app.on('window-all-closed', () => {});
