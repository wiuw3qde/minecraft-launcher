'use strict';
/* 下载页逻辑（两步向导）：步骤1 选游戏版本 → 步骤2 选加载器并安装。
   关键保证：安装加载器前先确认父版本（原版）已就绪，缺失则自动先装好，
   最终生成的加载器版本（ID 自带加载器名，如 fabric-loader-x-y）处于可直接启动的可用状态。 */
(function () {
  const $ = (id) => document.getElementById(id);
  let allVersions = [];
  let installed = new Set();
  let loaderData = [];
  let busy = false;
  let selectedVanilla = '';

  /* 跨阶段进度聚合：一次"装原版 + 装加载器"其实是两次独立 installProfile，
   * 各自用全新的 done/total 计数器。直接显示会导致第二阶段 done 归零后数值被叠加，
   * 出现「完成数 > 总数」（如 2679/2638）。这里把各阶段拼接成一条连续进度。
   * resetDlProgress() 在每次安装操作开始时调用。 */
  let progAccDone = 0; // 已完成阶段累计文件数
  let progAccTotal = 0; // 已完成阶段累计总数
  let progCurTotal = 0; // 当前阶段运行中的总数（取见过的最大值，含版本内 libs→assets 增长）
  let progPrevDone = 0; // 上一个 done，用于检测"计数器归零 = 新阶段开始"
  function resetDlProgress() {
    progAccDone = 0;
    progAccTotal = 0;
    progCurTotal = 0;
    progPrevDone = 0;
  }

  function dlog(text) {
    const el = $('dlLog');
    el.textContent += text.endsWith('\n') ? text : text + '\n';
    if (el.textContent.length > 200000) el.textContent = el.textContent.slice(-200000);
    el.scrollTop = el.scrollHeight;
  }

  function setStatus(text, kind) {
    const el = $('dlStatus');
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setBusy(v) {
    busy = v;
    updateControls();
  }

  /* 按当前步骤与选择，刷新各按钮可用状态 */
  function updateControls() {
    const step1 = !$('dlStep1').hidden;
    $('btnInstallVersion').disabled = busy || !selectedVanilla;
    $('btnToStep2').disabled = busy || !selectedVanilla || !step1;
    $('btnLoadManifest').disabled = busy;
    const kind = $('ldrKind') ? $('ldrKind').value : 'none';
    if (step1) {
      $('btnInstallStack').disabled = true;
      $('btnLoadLoaders').disabled = true;
    } else {
      $('btnLoadLoaders').disabled = busy || kind === 'none';
      $('btnInstallStack').disabled = busy || (kind === 'none' ? false : !$('ldrVersion').value);
    }
    $('btnDlCancel').disabled = !busy;
  }

  function mirrorIds() {
    return [$('dlMirror').value || 'bmclapi'];
  }

  function combo() {
    const ui = window.launcherUI || { gameDir: () => '', javaPath: () => '' };
    return {
      gameDir: ui.gameDir(),
      mirrorIds: mirrorIds(),
      skipAssets: !$('dlAssets').checked,
      concurrency: Number($('dlConcurrency').value) || 32,
      includeUnlisted: $('fUnlisted').checked,
      javaPath: ui.javaPath(),
    };
  }

  /* ---------- 版本列表 ---------- */
  function typeChecked(type) {
    if (type === 'release') return $('fRelease').checked;
    if (type === 'snapshot') return $('fSnapshot').checked;
    return $('fOldBeta').checked; // old_beta / old_alpha
  }

  function renderList() {
    const kw = $('dlSearch').value.trim().toLowerCase();
    const list = allVersions.filter((v) => typeChecked(v.type) && (!kw || v.id.toLowerCase().includes(kw)));
    const sel = $('dlVersionList');
    const prev = sel.value;
    sel.innerHTML = '';
    const shown = list.slice(0, 400);
    for (const v of shown) {
      const opt = document.createElement('option');
      opt.value = v.id;
      const date = (v.releaseTime || '').slice(0, 10);
      const typeLabel = { release: '正式版', snapshot: '快照', old_beta: '远古', old_alpha: '远古' }[v.type] || v.type;
      opt.textContent = `${v.id}  ·  ${typeLabel}  ·  ${date}${installed.has(v.id) ? '  ·  已安装' : ''}${v.unlisted ? '  ·  未列出' : ''}`;
      sel.appendChild(opt);
    }
    if (prev && shown.some((v) => v.id === prev)) sel.value = prev;
    $('dlManifestInfo').textContent = `共 ${allVersions.length} 个版本，当前显示 ${shown.length} 个${list.length > shown.length ? '（更多请搜索）' : ''}`;
  }

  async function refreshInstalled() {
    try {
      const res = await window.launcher.versions.list(combo().gameDir);
      installed = new Set((res.versions || []).map((v) => v.id));
    } catch (e) {
      installed = new Set();
    }
  }

  async function loadManifest() {
    $('dlVersionList').innerHTML = '';
    $('dlManifestInfo').textContent = '正在拉取版本清单…';
    await refreshInstalled();
    const res = await window.launcher.download.manifest(mirrorIds(), $('fUnlisted').checked);
    if (!res.ok) {
      $('dlManifestInfo').textContent = '拉取失败：' + res.error;
      $('dlEmptyHint').hidden = false;
      return;
    }
    allVersions = res.versions;
    $('dlEmptyHint').hidden = true;
    dlog(`[清单] ${res.versions.length} 个版本，来源 ${res.source}\n`);
    renderList();
  }

  /* ---------- 步骤导航 ---------- */
  function gotoStep(n) {
    $('dlStep1').hidden = n !== 1;
    $('dlStep2').hidden = n !== 2;
    $('wzStep1').classList.toggle('active', n === 1);
    $('wzStep1').classList.toggle('done', n > 1);
    $('wzStep2').classList.toggle('active', n === 2);
    $('wzStep2').classList.toggle('done', n === 2 && false); // 完成时另由安装结果标记
    if (n === 2) {
      $('wzTargetVer').textContent = selectedVanilla || '—';
      // 加载器绑定到第一步选定的原版版本：锁定游戏版本下拉
      const sel = $('ldrMcVersion');
      sel.innerHTML = '';
      const o = document.createElement('option');
      o.value = selectedVanilla;
      o.textContent = selectedVanilla;
      sel.appendChild(o);
      sel.disabled = true;
      // 重置加载器选择
      $('ldrKind').value = 'none';
      onKindChange();
    }
    updateControls();
  }

  function onKindChange() {
    const kind = $('ldrKind').value;
    $('ldrPick').hidden = kind === 'none';
    $('ldrNoneHint').hidden = kind !== 'none';
    $('ldrComboRow').hidden = kind !== 'optifine';
    if (kind === 'none') $('ldrNamePreview').hidden = true;
    updateControls();
  }

  /* ---------- 加载器版本查询 ---------- */
  async function loadLoaders() {
    const kind = $('ldrKind').value;
    const mc = $('ldrMcVersion').value;
    if (!mc) {
      $('ldrInfo').textContent = '请先在第一步选择游戏版本';
      return;
    }
    $('ldrInfo').textContent = '查询中…';
    const res = await window.launcher.download.loaders(kind, mc, mirrorIds());
    $('ldrVersion').innerHTML = '';
    if (!res.ok) {
      $('ldrInfo').textContent = '查询失败：' + res.error;
      loaderData = [];
      return;
    }
    loaderData = res.versions;
    for (const v of loaderData.slice(0, 200)) {
      const opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = v.version + (v.stable === true ? '（稳定版）' : '') + (v.forge ? `（适配 ${v.forge}）` : '');
      $('ldrVersion').appendChild(opt);
    }
    $('ldrInfo').textContent = `${kind} 共 ${loaderData.length} 个版本，来源 ${res.source || '镜像'}`;
    updateControls();
  }

  /* 根据所选加载器，预览最终版本名（默认已带上加载器名称） */
  function updateNamePreview() {
    const kind = $('ldrKind').value;
    const mc = $('ldrMcVersion').value;
    const sel = $('ldrVersion');
    const idx = sel.selectedIndex;
    const meta = loaderData[idx] || {};
    const el = $('ldrNamePreview');
    if (kind === 'none' || !meta.version) {
      el.hidden = true;
      return;
    }
    let name = '';
    if (kind === 'fabric') name = `fabric-loader-${meta.version}-${mc}`;
    else if (kind === 'forge') name = `${mc}-forge-${meta.version}（具体构建号由安装器决定）`;
    else if (kind === 'neoforge') name = `${mc}-neoforge-${meta.version}`;
    else if (kind === 'optifine') {
      const ed = `${meta.type || 'HD_U'}_${meta.patch || '?'}`;
      name = $('ldrComboForge').checked ? `${mc}-Forge_…-OptiFine_${ed}（组合版）` : `${mc}-OptiFine_${ed}`;
    }
    el.hidden = false;
    el.textContent = `将生成版本：${name}（名称已自动带上加载器）`;
  }

  /* ---------- 安装：原版 ---------- */
  async function installVanilla(versionId) {
    if (!versionId) return { ok: false, error: '未选择版本' };
    setBusy(true);
    resetDlProgress();
    $('dlBar').style.width = '0%';
    setStatus(`正在安装 ${versionId}…`);
    dlog(`\n=== 开始安装原版 ${versionId} ===\n`);
    const res = await window.launcher.download.install(Object.assign(combo(), { versionId }));
    setBusy(false);
    await refreshInstalled();
    renderList();
    window.launcherUI.refreshVersions();
    if (res.ok) {
      setStatus(`${versionId} 安装完成：新下载 ${res.downloaded} 个，跳过 ${res.skipped} 个`, 'ok');
    } else {
      setStatus(`${versionId} 安装失败：${res.error || (res.failed && res.failed.length ? res.failed[0].error : '未知错误')}`, 'error');
    }
    return res;
  }

  /* 确保父版本（原版）已安装；缺失则自动先装好 */
  async function ensureVanilla(mc) {
    await refreshInstalled();
    if (installed.has(mc)) {
      dlog(`[前置] 原版 ${mc} 已存在，跳过\n`);
      return { ok: true, skipped: true };
    }
    dlog(`\n=== 前置：先安装原版 ${mc}（加载器需要它作为父版本）===\n`);
    setStatus(`正在安装原版 ${mc}（加载器需要它作为父版本）…`);
    const r = await window.launcher.download.install(Object.assign(combo(), { versionId: mc }));
    if (r.ok) {
      await refreshInstalled();
      renderList();
    }
    return r;
  }

  /* ---------- 安装：第二步「开始安装」 ---------- */
  async function installStack() {
    if (busy) return;
    const kind = $('ldrKind').value;
    const mc = selectedVanilla || $('ldrMcVersion').value;
    if (!mc) {
      setStatus('请先在第一步选择游戏版本', 'error');
      return;
    }
    setBusy(true);
    resetDlProgress();
    $('dlBar').style.width = '0%';

    // 1) 确保父版本就绪
    const pre = await ensureVanilla(mc);
    if (!pre.ok) {
      setBusy(false);
      setStatus(`原版 ${mc} 安装失败：${pre.error || ''}`, 'error');
      return;
    }

    // 2) 只装原版
    if (kind === 'none') {
      setStatus(`${mc} 原版安装完成，可直接启动`, 'ok');
      window.launcherUI.refreshVersions();
      setBusy(false);
      return;
    }

    // 3) 装加载器
    const sel = $('ldrVersion');
    const idx = sel.selectedIndex;
    const meta = loaderData[idx] || {};
    dlog(`\n=== 开始安装 ${kind} ${meta.version || ''}（基于 ${mc}）===\n`);
    setStatus(kind === 'forge' || kind === 'neoforge' ? '安装器运行中，可能需要几分钟…' : '安装加载器中…');
    const res = await window.launcher.download.installLoader(
      Object.assign(combo(), {
        kind,
        gameVersion: mc,
        loaderVersion: meta.version,
        version: meta.raw || meta.version,
        rawVersion: meta.raw || meta.version,
        installerPath: meta.installerPath,
        type: meta.type || (meta.version || '').split('_')[0],
        patch: meta.patch || (meta.version || '').split('_')[1],
        filename: meta.filename,
        forge: meta.forge,
        comboForge: kind === 'optifine' && $('ldrComboForge').checked,
      })
    );
    setBusy(false);
    await refreshInstalled();
    window.launcherUI.refreshVersions();
    if (res.ok) {
      const extra = res.combo ? '（Forge + OptiFine 组合版）' : '';
      setStatus(`安装完成，已就绪：${res.versionId || ''}${extra}（可直接启动）`, 'ok');
      dlog(`\n✅ 加载器已就绪：${res.versionId || ''}${extra}。到「启动游戏」页选择它即可游玩。\n`);
      $('wzStep2').classList.add('done');
    } else {
      setStatus('安装失败：' + (res.error || '未知错误'), 'error');
    }
  }

  /* ---------- 事件 ---------- */
  function init() {
    // 兜底 window.launcherUI（切勿整体覆盖，避免抹掉 app.js 提供的 gameDir 等真实实现）
    if (!window.launcherUI) window.launcherUI = {};
    const defaults = { gameDir: () => '', javaPath: () => '', refreshVersions: async () => {}, log: () => {} };
    for (const k of Object.keys(defaults)) {
      if (typeof window.launcherUI[k] !== 'function') window.launcherUI[k] = defaults[k];
    }

    (async () => {
      const mirrors = await window.launcher.download.mirrors();
      for (const m of mirrors) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        $('dlMirror').appendChild(opt);
      }
      $('dlMirror').value = 'bmclapi';
    })();

    $('tabBtnDownload').addEventListener('click', () => {
      if (window.launcherNav && window.launcherNav.show) window.launcherNav.show('download');
      else {
        $('tabLaunch').hidden = true;
        $('tabDownload').hidden = false;
        $('tabMods').hidden = true;
      }
      if (!allVersions.length) loadManifest();
    });
    $('btnLoadManifest').addEventListener('click', loadManifest);
    $('dlSearch').addEventListener('input', renderList);
    for (const id of ['fRelease', 'fSnapshot', 'fOldBeta']) $(id).addEventListener('change', renderList);
    $('fUnlisted').addEventListener('change', loadManifest);
    $('dlVersionList').addEventListener('change', () => {
      selectedVanilla = $('dlVersionList').value;
      updateControls();
    });
    $('btnInstallVersion').addEventListener('click', () => installVanilla(selectedVanilla));
    $('btnToStep2').addEventListener('click', () => {
      selectedVanilla = $('dlVersionList').value;
      if (!selectedVanilla) return;
      gotoStep(2);
    });
    $('btnBackStep1').addEventListener('click', () => gotoStep(1));

    $('ldrKind').addEventListener('change', () => {
      loaderData = [];
      $('ldrVersion').innerHTML = '';
      onKindChange();
    });
    $('btnLoadLoaders').addEventListener('click', loadLoaders);
    $('ldrVersion').addEventListener('change', () => {
      updateNamePreview();
      updateControls();
    });
    $('ldrComboForge').addEventListener('change', updateNamePreview);
    $('btnInstallStack').addEventListener('click', installStack);

    $('btnDlCancel').addEventListener('click', async () => {
      await window.launcher.download.cancel();
      dlog('[取消] 已请求停止，正在结束进行中的请求…\n');
      setStatus('正在取消…');
    });

    window.launcher.onDlLog((t) => dlog(t));
    window.launcher.onDlProgress((p) => {
      if (!p.total) return;
      // 检测"计数器归零"= 新一阶段（如从原版切到加载器）。版本内部 libs→assets 子阶段
      // done 单调递增（42→2638），不会触发；只有第二阶段 done 从 0 开始才会触发。
      if (p.done < progPrevDone - 1) {
        // 把上一阶段折叠进累计，并假定上一阶段已完整结束
        progAccTotal += progCurTotal;
        progAccDone += progCurTotal;
        progCurTotal = p.total;
      } else {
        // 同一条连续操作：运行总数取见过的最大值（吸收版本内 libs→assets 的增长）
        progCurTotal = Math.max(progCurTotal, p.total);
      }
      progPrevDone = p.done;
      const total = progAccTotal + progCurTotal;
      const done = progAccDone + p.done;
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      $('dlBar').style.width = pct + '%';
      setStatus(`进度 ${done}/${total}（${pct}%）· 已下载 ${Math.round(p.bytes / 1048576)} MB${p.failed ? ' · 失败 ' + p.failed : ''}`);
    });
    window.launcher.onDlDone((r) => {
      $('dlBar').style.width = r.ok ? '100%' : $('dlBar').style.width;
      if (r.ok && r.downloaded === 0 && r.skipped > 0) dlog('[完成] 文件均已存在，无需重复下载\n');
    });

    dlog('[下载] 两步向导就绪，默认使用 BMCLAPI 国内镜像\n');
    gotoStep(1);
  }

  // init() 本身是同步函数（内部异步工作自己起 async IIFE），不能直接 .catch
  try {
    init();
  } catch (e) {
    dlog('[错误] 初始化失败：' + e.message);
  }
})();
