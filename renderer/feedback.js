'use strict';
/* 反馈 / 上报（H 功能）：主页面「上报问题」按钮 + 崩溃横幅 + 弹窗。
 * 弹窗自动收集启动器信息、游戏日志、崩溃报告，用内置 token 一键创建 GitHub issue。
 */
(function () {
  let modal = null;
  let lastCollected = null;
  let lastCrashes = [];

  function gameDirNow() {
    try { return (window.launcherUI && window.launcherUI.gameDir) ? window.launcherUI.gameDir() : ''; } catch (e) { return ''; }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'md-modal';
    modal.hidden = true;
    modal.id = 'fbModal';
    modal.innerHTML =
      '<div class="md-backdrop" data-act="close"></div>' +
      '<div class="md-panel fb-panel">' +
      '<div class="md-head">' +
      '<div class="md-headtext"><div class="md-title">上报问题 / 崩溃</div>' +
      '<div class="md-sub">自动收集启动器信息与日志，一键发到 GitHub issue</div></div>' +
      '<button class="md-close" data-act="close" title="关闭">✕</button>' +
      '</div>' +
      '<div class="md-scroll">' +
      '<p class="hint fb-priv">以下信息会被附带：启动器版本 / 系统 / 游戏目录路径 / 最近游戏日志与崩溃报告。<b>请不要在描述里填写密码、账号令牌等敏感信息。</b></p>' +
      '<label class="field fb-desc-field"><span>问题描述（必填，帮助我们定位）</span>' +
      '<textarea id="fbDesc" class="fb-desc" placeholder="例如：启动 1.20.1 + Fabric 时点「启动游戏」报错 Exit Code 1，日志显示 NoClassDefFound…"></textarea></label>' +
      '<div id="fbSummary" class="fb-summary">收集信息中…</div>' +
      '<div id="fbResult" class="fb-result" hidden></div>' +
      '</div>' +
      '<div class="md-foot">' +
      '<button id="fbSubmit" class="primary">提交到 GitHub</button>' +
      '<button id="fbCopy" class="ghost">复制内容</button>' +
      '<button id="fbClose" class="ghost" data-act="close">关闭</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-act') === 'close') modal.hidden = true;
    });
    modal.querySelector('#fbSubmit').addEventListener('click', submitFeedback);
    modal.querySelector('#fbCopy').addEventListener('click', copyFeedback);
    modal.querySelector('#fbClose').addEventListener('click', () => (modal.hidden = true));
    return modal;
  }

  async function openFeedbackModal(crashes) {
    const m = ensureModal();
    m.hidden = false;
    const desc = m.querySelector('#fbDesc');
    const summary = m.querySelector('#fbSummary');
    const result = m.querySelector('#fbResult');
    result.hidden = true;
    summary.textContent = '正在收集本地日志与崩溃记录…';
    desc.value = '';
    try {
      const gd = gameDirNow();
      const res = await window.launcher.feedback.collect(gd);
      lastCollected = res;
      lastCrashes = (res && res.launcherCrashes) || [];
      const app = (res && res.app) || {};
      const logs = (res && res.logs) || [];
      const logInfo = logs
        .map((l) => '<li>' + esc(l.name) + '：' + (l.size || 0) + ' 字节' + (l.content ? '' : '（读取为空）') + '</li>')
        .join('');
      summary.innerHTML =
        '<div class="fb-summ-grid">' +
        '<div><b>启动器</b> v' + esc(app.version || '?') + ' · ' + esc(app.platform || '?') + ' ' + esc(app.arch || '?') + '</div>' +
        '<div><b>系统</b> ' + esc(app.osRelease || '?') + ' · 内存 ' + esc(app.totalMemoryMB || '?') + ' MB</div>' +
        '<div><b>游戏目录</b> ' + esc((res && res.gameDir) || '（未提供）') + '</div>' +
        '</div>' +
        '<div class="fb-summ-logs"><b>将随 issue 附带：</b><ul>' + (logInfo || '<li>无可用日志</li>') + '</ul></div>' +
        (lastCrashes.length ? '<div class="fb-crash-note">检测到 ' + lastCrashes.length + ' 条启动器崩溃记录，将一并上报。</div>' : '');
    } catch (e) {
      summary.textContent = '收集失败：' + e.message;
      lastCollected = null;
    }
  }

  function buildBody(description) {
    const c = lastCollected || {};
    const app = c.app || {};
    const lines = [];
    lines.push('## 描述');
    lines.push(description || '(未填写)');
    lines.push('');
    lines.push('## 环境');
    lines.push('- 启动器版本：' + (app.version || '?') + '（' + (app.platform || '?') + ' ' + (app.arch || '?') + '）');
    lines.push('- 游戏目录：' + (c.gameDir || '（未提供）'));
    lines.push('');
    const logs = c.logs || [];
    if (logs.length) {
      lines.push('## 日志');
      logs.forEach((l) => {
        lines.push('### ' + l.name + '（' + (l.size || 0) + ' 字节）');
        lines.push('```');
        lines.push((l.content || '').slice(0, 6000));
        lines.push('```');
      });
    }
    const lcs = c.launcherCrashes || [];
    if (lcs.length) {
      lines.push('## 启动器崩溃记录');
      lcs.slice(0, 3).forEach((cr) => {
        lines.push('### ' + (cr.file || '') + ' · ' + (cr.time || ''));
        if (cr.message) lines.push('- ' + cr.message);
        lines.push('```');
        lines.push((cr.stack || '').slice(0, 4000));
        lines.push('```');
      });
    }
    return lines.join('\n');
  }

  async function submitFeedback() {
    const m = ensureModal();
    const desc = m.querySelector('#fbDesc').value.trim();
    const submitBtn = m.querySelector('#fbSubmit');
    const result = m.querySelector('#fbResult');
    if (!desc) { alert('请先填写问题描述'); return; }
    if (!lastCollected) { alert('信息尚未收集完成，请稍候或重新打开弹窗'); return; }
    submitBtn.disabled = true;
    submitBtn.textContent = '提交中…';
    try {
      const r = await window.launcher.feedback.submitIssue({ description: desc, collected: lastCollected });
      result.hidden = false;
      if (r.ok) {
        result.className = 'fb-result ok';
        result.innerHTML = '✅ 已创建 issue：<a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.url) + '</a>' +
          '<div class="fb-result-actions"><button id="fbOpenIssue" class="ghost small">在浏览器打开</button>' +
          (lastCrashes.length ? '<button id="fbAckCrash" class="ghost small">清除本地崩溃记录</button>' : '') + '</div>';
        const openBtn = result.querySelector('#fbOpenIssue');
        if (openBtn) openBtn.addEventListener('click', () => window.launcher.app.openExternal(r.url));
        const ackBtn = result.querySelector('#fbAckCrash');
        if (ackBtn) ackBtn.addEventListener('click', async () => {
          await window.launcher.feedback.ackCrash(lastCrashes.map((c) => c.file));
          ackBtn.textContent = '已清除';
          ackBtn.disabled = true;
        });
      } else {
        result.className = 'fb-result bad';
        result.textContent = '❌ 提交失败：' + (r.error || '未知错误');
      }
    } catch (e) {
      result.hidden = false;
      result.className = 'fb-result bad';
      result.textContent = '❌ 提交出错：' + e.message;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '提交到 GitHub';
    }
  }

  async function copyFeedback() {
    const m = ensureModal();
    const desc = m.querySelector('#fbDesc').value.trim();
    const body = buildBody(desc);
    let ok = false;
    try { if (window.launcher && window.launcher.app && window.launcher.app.copyText) ok = (await window.launcher.app.copyText(body)).ok; } catch (e) {}
    if (!ok) {
      try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(body); ok = true; } } catch (e) {}
    }
    alert(ok ? '已复制 issue 内容到剪贴板，可手动到 GitHub 粘贴。' : '复制失败，请手动选择文本复制。');
  }

  function showCrashBanner(dumps) {
    if (!dumps || !dumps.length) return;
    let banner = document.getElementById('crashBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'crashBanner';
      banner.className = 'crash-banner';
      const launchTab = document.getElementById('tabLaunch');
      if (launchTab) launchTab.insertBefore(banner, launchTab.firstChild);
    }
    banner.hidden = false;
    banner.innerHTML =
      '<span class="crash-ico">⚠</span>' +
      '<span class="crash-text">启动器上次运行发生了崩溃（' + dumps.length + ' 条记录），建议上报以帮助修复。</span>' +
      '<button id="crashReportBtn" class="small primary">一键上报崩溃日志</button>' +
      '<button id="crashDismissBtn" class="small ghost">忽略</button>';
    banner.querySelector('#crashReportBtn').addEventListener('click', () => openFeedbackModal(dumps));
    banner.querySelector('#crashDismissBtn').addEventListener('click', () => { banner.hidden = true; });
  }

  // 注册全局崩溃检测事件（下次启动若遗留 dump 则弹横幅）
  if (typeof window.launcher && typeof window.launcher.onCrashDetected === 'function') {
    window.launcher.onCrashDetected((dumps) => {
      if (dumps && dumps.length) showCrashBanner(dumps);
    });
  }

  window.Feedback = { open: openFeedbackModal, showCrashBanner };
})();
