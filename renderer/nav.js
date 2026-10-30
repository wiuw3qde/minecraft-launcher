'use strict';
/* 导航协调器：统一标签页的显隐与高亮（外部脚本，避免被 CSP 拦截内联脚本） */
window.launcherNav = {
  show: function (name) {
    var tabs = { launch: 'tabLaunch', download: 'tabDownload', mods: 'tabMods', versions: 'tabVersions', maps: 'tabMaps', shaders: 'tabShaders', resourcepacks: 'tabResourcepacks', tools: 'tabTools', multiplayer: 'tabMultiplayer', settings: 'tabSettings' };
    var btns = { launch: 'tabBtnLaunch', download: 'tabBtnDownload', mods: 'tabBtnMods', versions: 'tabBtnVersions', maps: 'tabBtnMaps', shaders: 'tabBtnShaders', resourcepacks: 'tabBtnResourcepacks', tools: 'tabBtnTools', multiplayer: 'tabBtnMultiplayer', settings: 'tabBtnSettings' };
    Object.keys(tabs).forEach(function (k) {
      var t = document.getElementById(tabs[k]);
      if (t) t.hidden = (k !== name);
      var b = document.getElementById(btns[k]);
      if (b) b.classList.toggle('active', k === name);
    });
  },
};
