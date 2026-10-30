'use strict';
/* 地图页探针（本轮改动）：
 * 1) maps webview 元素 useragent 属性已设置，且 guest navigator.userAgent 无 Electron 段
 * 2) 挑战检测表达式：对"Cloudflare 验证页"返回 true，对正常页返回 false（用临时 webview 加载 data: 验证）
 * 3) 外部打开按钮接线（.map-open-pmc / .map-open-pmc-top 存在且绑定）
 * 4) 收集 JS 报错
 */
require('../main.js');
const { app, BrowserWindow } = require('electron');

function log(...a) { console.log('[probe-maps]', ...a); }

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

  // 让地图页可见并建立 webview
  await win.webContents.executeJavaScript("window.launcherNav.show('maps');");
  await new Promise((r) => setTimeout(r, 1500));

  // 读取 maps webview 的属性 + guest UA + 按钮接线
  const meta = await win.webContents.executeJavaScript(`
    (function(){
      var wv = document.querySelector('#tabMaps webview');
      var info = {
        hasWebview: !!wv,
        uaAttr: wv ? wv.getAttribute('useragent') : null,
        hasTopBtn: !!document.querySelector('#tabMaps .map-open-pmc-top'),
        hasBottomBtn: !!document.querySelector('#tabMaps .map-open-pmc'),
        hasBanner: !!document.querySelector('#tabMaps .pmc-banner'),
      };
      if (wv) {
        return wv.executeJavaScript('navigator.userAgent').then(function(guestUA){
          info.guestUA = guestUA;
          return JSON.stringify(info);
        }).catch(function(){ info.guestUA = '(guest 不可访问)'; return JSON.stringify(info); });
      }
      return JSON.stringify(info);
    })()
  `);
  log('maps webview 元数据:', meta);
  const m = JSON.parse(meta);
  log('UA 属性含 Electron?', m.uaAttr && m.uaAttr.indexOf('Electron') >= 0 ? 'FAIL' : 'PASS(无)');
  log('guest UA 含 Electron?', m.guestUA && m.guestUA.indexOf('Electron') >= 0 ? 'FAIL' : 'PASS(无)');

  // 挑战检测表达式（与 maps-browse.js 完全一致）
  const DETECT = "(function(){var t=(document.body&&document.body.innerText)||'';" +
    "return t.indexOf('安全验证')>=0||t.indexOf('verify you are human')>=0||" +
    "t.indexOf('Checking your browser')>=0||t.indexOf('Just a moment')>=0;})()";

  // 用临时 webview 加载两种 data: 页面，验证检测正确性
  const detectTest = await win.webContents.executeJavaScript(`
    new Promise(function(res){
      function mk(srcHtml, label){
        return new Promise(function(pres){
          var w = document.createElement('webview');
          w.setAttribute('partition','persist:pmc');
          w.style.position='fixed'; w.style.left='-9999px'; w.style.width='10px'; w.style.height='10px';
          w.addEventListener('did-stop-loading', function(){
            setTimeout(function(){
              w.executeJavaScript(${JSON.stringify(DETECT)}).then(function(v){ pres({label:label, detected:v}); w.remove(); })
                .catch(function(){ pres({label:label, detected:'(err)'}); w.remove(); });
            }, 300);
          });
          w.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(srcHtml);
          document.body.appendChild(w);
        });
      }
      var challenge = '<html><body><h1>正在进行安全验证</h1><p>verify you are human</p></body></html>';
      var normal = '<html><body><h1>Planet Minecraft</h1><p>Welcome to our community</p></body></html>';
      mk(challenge,'challenge').then(function(r1){
        mk(normal,'normal').then(function(r2){
          res(JSON.stringify({challenge:r1, normal:r2}));
        });
      });
    })
  `);
  log('挑战检测:', detectTest);

  await new Promise((r) => setTimeout(r, 400));
  log('JS errors:', errors.length ? errors : 'NONE');
  process.exit(0);
});
app.on('window-all-closed', () => {});
