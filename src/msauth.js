'use strict';
/**
 * 微软正版登录（Minecraft Java 版官方鉴权链）
 *
 * 流程：device code 拿微软 token → Xbox Live (XBL) → XSTS →
 *       Minecraft Services 登录 → 校验是否拥有游戏 → 取角色档案
 *
 * 零依赖，原生 https 实现。客户端 ID 需要用户自行在 Azure 门户注册
 * （免费，约 5 分钟），见界面里的说明。
 */
const https = require('https');
const { URL } = require('url');
const platform = require('./platform');
const { EventEmitter } = require('events');

const MS_DEVICE_CODE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const MS_TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBL_AUTH = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_ENTITLEMENTS = 'https://api.minecraftservices.com/entitlements/mcgame';
const MC_PROFILE = 'https://api.minecraftservices.com/minecraft/profile';

// 微软账号（live.com）授权码流程：使用 Minecraft 官方内置 client ID。
// 这是第一方应用，已在 Mojang 白名单内，无需注册 Azure 应用、无需 client secret。
// 注意：该 client ID 不是 Azure AD v2 应用，不能用 device code 流程，必须走 login.live.com。
const MC_CLIENT_ID = '00000000402b5328';
const MS_LIVE_AUTH = 'https://login.live.com/oauth20_authorize.srf';
const MS_LIVE_TOKEN = 'https://login.live.com/oauth20_token.srf';
const LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const LIVE_REDIRECT = 'https://login.live.com/oauth20_desktop.srf';

const SCOPE = 'XboxLive.signin offline_access';
const REQUEST_TIMEOUT = 30000;

/** 通用 https 请求，返回 {status, headers, body}，body 已按 JSON 解析（失败则给原文） */
function request(urlString, { method = 'GET', form, json, headers = {}, timeout = REQUEST_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(new Error('无效的 URL：' + urlString));
      return;
    }
    let payload = null;
    const sendHeaders = Object.assign({}, headers);
    if (form) {
      payload = new URLSearchParams(form).toString();
      sendHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      sendHeaders['Content-Length'] = Buffer.byteLength(payload);
    } else if (json !== undefined) {
      payload = JSON.stringify(json);
      sendHeaders['Content-Type'] = 'application/json';
      sendHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    if (sendHeaders.Accept === undefined) sendHeaders.Accept = 'application/json';
    // Minecraft 服务（api.minecraftservices.com）前面是 Akamai 类 WAF，
    // 不带 User-Agent 或 Node 默认 UA 经常直接 403。带一个正常 UA 才能通过。
    if (sendHeaders['User-Agent'] === undefined)
      // 按真实平台生成；Windows 下与原来的 Chrome/120 UA 完全一致
      sendHeaders['User-Agent'] = platform.userAgent(undefined, undefined, '120.0.0.0');

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: sendHeaders,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (e) {
            parsed = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed || { raw } });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 提取可读错误信息：兼容微软 AAD（error_description）与 Mojang（errorMessage）两种结构 */
function msError(res) {
  const b = res.body && typeof res.body === 'object' ? res.body : {};
  const desc = b.error_description || b.errorMessage || b.error || ('HTTP ' + res.status);
  return String(desc).replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * 针对常见 AADSTS 错误给出可操作的中文修复提示
 * @returns {{message: string, hint: string|null}}
 */
function friendlyMsError(res, stage) {
  const message = msError(res);
  const m = String((res.body && res.body.error_description) || '').match(/AADSTS(\d+)/);
  const hints = {
    // 应用没被标记为公共客户端：设备代码流的硬性要求
    70002:
      'Azure 应用未标记为公共客户端。修复：Azure 门户 → 应用注册 → 你的应用 → 「身份验证」→「添加平台」选「移动和桌面应用程序」→ 勾选 https://login.microsoftonline.com/common/oauth2/nativeclient → 保存；再把「允许公共客户端流」设为「是」→ 保存。',
    // 应用没有申请该权限 / 账户类型不支持
    65001: '应用注册的账户类型可能选错了。请确认「受支持的账户类型」选的是「个人 Microsoft 账户」。',
    9001443: '请求的资源不存在，请确认 scope 参数正确（应为 XboxLive.signin offline_access）。',
  };
  return { message, hint: m ? hints[m[1]] || null : null };
}

/**
 * 微软登录管理器。
 * 事件：
 *   code    {userCode, verificationUri, message, expiresIn, interval}
 *   progress {text}
 *   error   {message, stage}
 *   success {account}
 */
class MsaAuth extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle'; // idle | code | polling | done | error | cancelled
    this.timer = null;
    this.cancelled = false;
  }

  /**
   * 新版登录入口：用 Minecraft 官方内置 client ID 走 login.live.com 授权码流程。
   * 用户在浏览器完成登录后，会把带 code 的回跳网址发回来（submitLiveCode）。
   * 不需要用户自己注册任何 Azure 应用。
   */
  startLiveLogin() {
    this.cancelled = false;
    this.state = 'awaiting-code';
    const authUrl =
      MS_LIVE_AUTH +
      '?client_id=' +
      MC_CLIENT_ID +
      '&response_type=code&scope=' +
      encodeURIComponent(LIVE_SCOPE) +
      '&redirect_uri=' +
      encodeURIComponent(LIVE_REDIRECT);
    this.emit('live-url', { url: authUrl });
    return { ok: true };
  }

  /** 用户把回跳网址（或其中的 code）发回来后，换取微软令牌并继续走 XBL/XSTS/Minecraft */
  async submitLiveCode(input) {
    if (this.state !== 'awaiting-code' && this.state !== 'idle') {
      // 允许在 awaiting-code 状态下提交
    }
    let raw = String(input || '').trim();
    // 从完整网址里提取 code：支持 ?code= &code= #code=（部分浏览器把 code 放在 fragment 里）
    let code = null;
    const m = raw.match(/[?#&]code=([^&#]+)/);
    if (m) {
      let v = m[1];
      try { v = decodeURIComponent(v); } catch (e) { /* 保留原值 */ }
      // 防御：若解码后出现空格且原片段含 +，还原为 +（标准 base64 的 + 在 query 里有时未编码）
      if (v.indexOf(' ') !== -1 && m[1].indexOf('+') !== -1) v = v.replace(/ /g, '+');
      code = v;
    } else {
      // 退化：用户直接粘贴了裸 code（不含网址）
      const mm = raw.match(/^(?:code=)?([A-Za-z0-9._\-+/=]{20,})$/);
      if (mm) code = mm[1];
    }
    if (!code || code.length < 10) {
      const message =
        '没有从网址里解析到有效的 code。请确认：① 粘贴的是浏览器登录后地址栏里的【完整】网址' +
        '（应以 login.live.com/oauth20_desktop.srf?code= 开头）；② 点地址栏后按 Ctrl+A 全选、再复制，不要漏掉结尾。';
      this.state = 'error';
      this.emit('error', { message, stage: 'live-code' });
      return { ok: false, error: message };
    }
    this.state = 'exchanging';
    this.emit('progress', { text: '正在换取微软令牌…' });
    const res = await request(MS_LIVE_TOKEN, {
      method: 'POST',
      form: {
        client_id: MC_CLIENT_ID,
        code,
        grant_type: 'authorization_code',
        redirect_uri: LIVE_REDIRECT,
        scope: LIVE_SCOPE,
      },
    });
    if (res.status !== 200 || !res.body.access_token) {
      const message = '换取微软令牌失败：' + msError(res);
      this.state = 'error';
      this.emit('error', { message, stage: 'live-code' });
      return { ok: false, error: message };
    }
    return this._completeLogin(MC_CLIENT_ID, {
      access_token: res.body.access_token,
      refresh_token: res.body.refresh_token,
      expires_in: res.body.expires_in,
    });
  }

  /** 第一步：申请设备代码，然后内部轮询直到授权完成（已弃用，保留以备兼容） */
  async startDeviceLogin(clientId) {
    if (!clientId || !/^[0-9a-fA-F-]{36}$/.test(clientId.trim())) {
      const err = { message: '请先填写有效的 Azure 客户端 ID（32 位十六进制，形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）', stage: 'config' };
      this.state = 'error';
      this.emit('error', err);
      return { ok: false, error: err.message };
    }
    this.cancelled = false;
    this.state = 'code';
    const res = await request(MS_DEVICE_CODE, {
      method: 'POST',
      form: { client_id: clientId.trim(), scope: SCOPE },
    });
    if (res.status !== 200) {
      const { message, hint } = friendlyMsError(res, 'device-code');
      const full = '获取设备代码失败：' + message;
      this.state = 'error';
      this.emit('error', { message: full, hint, stage: 'device-code' });
      return { ok: false, error: full, hint };
    }
    const { device_code, user_code, verification_uri, message, expires_in, interval } = res.body;
    if (!device_code || !user_code) {
      const message = '微软返回的设备代码不完整';
      this.state = 'error';
      this.emit('error', { message, stage: 'device-code' });
      return { ok: false, error: message };
    }
    this.emit('code', {
      userCode: user_code,
      verificationUri: verification_uri || 'https://www.microsoft.com/link',
      message: message || `请在浏览器打开 ${verification_uri} 并输入代码 ${user_code}`,
      expiresIn: expires_in || 900,
      interval: interval || 5,
    });

    this.state = 'polling';
    return this._pollToken(clientId.trim(), device_code, interval || 5);
  }

  /** 轮询 token 端点 */
  async _pollToken(clientId, deviceCode, interval) {
    const deadline = Date.now() + 15 * 60 * 1000;
    let wait = Math.max(1, interval);
    while (!this.cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      if (this.cancelled) break;
      let res;
      try {
        res = await request(MS_TOKEN, {
          method: 'POST',
          form: {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: clientId,
            device_code: deviceCode,
          },
        });
      } catch (e) {
        this.emit('progress', { text: '网络波动，继续等待授权…' });
        continue;
      }
      if (res.status === 200) {
        return this._completeLogin(clientId, res.body);
      }
      const err = String(res.body && res.body.error || '');
      if (err === 'authorization_pending') {
        this.emit('progress', { text: '等待浏览器里完成授权…' });
        continue;
      }
      if (err === 'slow_down') {
        wait = Math.min(wait + 5, 30);
        continue;
      }
      if (err === 'authorization_declined' || err === 'access_denied') {
        const message = '你拒绝了授权';
        this.state = 'error';
        this.emit('error', { message, stage: 'authorize' });
        return { ok: false, error: message };
      }
      if (err === 'expired_token') {
        const message = '设备代码已过期，请重新点击登录';
        this.state = 'error';
        this.emit('error', { message, stage: 'authorize' });
        return { ok: false, error: message };
      }
      const message = '授权失败：' + (msError(res) || err);
      this.state = 'error';
      this.emit('error', { message, stage: 'authorize' });
      return { ok: false, error: message };
    }
    if (this.cancelled) {
      this.state = 'cancelled';
      return { ok: false, error: '已取消登录', cancelled: true };
    }
    const message = '授权等待超时，请重试';
    this.state = 'error';
    this.emit('error', { message, stage: 'authorize' });
    return { ok: false, error: message };
  }

  cancel() {
    this.cancelled = true;
    this.state = 'cancelled';
  }

  /** 用 refresh token 直接换登录态（启动游戏时静默刷新） */
  async loginWithRefreshToken(clientId, refreshToken) {
    if (!clientId || !refreshToken) return { ok: false, error: '缺少客户端 ID 或刷新令牌' };
    // 内置 client ID 走 login.live.com 刷新；其它（如有）走 Azure AD v2
    const isBuiltin = clientId === MC_CLIENT_ID;
    const res = await request(isBuiltin ? MS_LIVE_TOKEN : MS_TOKEN, {
      method: 'POST',
      form: isBuiltin
        ? {
            grant_type: 'refresh_token',
            client_id: MC_CLIENT_ID,
            refresh_token: refreshToken,
            scope: LIVE_SCOPE,
          }
        : {
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
            scope: SCOPE,
          },
    });
    if (res.status !== 200) {
      return { ok: false, error: '刷新登录态失败：' + msError(res) + '（请重新登录）' };
    }
    return this._completeLogin(clientId, res.body);
  }

  /** 微软 token → 完整账号信息 */
  async _completeLogin(clientId, tokenBody) {
    const msAccessToken = tokenBody.access_token;
    const refreshToken = tokenBody.refresh_token;
    const expiresIn = Number(tokenBody.expires_in) || 3600;
    if (!msAccessToken) {
      const message = '微软未返回访问令牌';
      this.state = 'error';
      this.emit('error', { message, stage: 'token' });
      return { ok: false, error: message };
    }
    this.emit('progress', { text: '正在连接 Xbox Live…' });

    // 1. Xbox Live 用户令牌
    // 内置 client ID 走 login.live.com 流程，拿到的 MBI_SSL 令牌本身已是完整 RPS 票据，直接用作 RpsTicket（不加 d= 前缀）；
    // 其它（旧 Azure 流程）令牌是 JWT，需要 d= 前缀。
    const isBuiltin = clientId === MC_CLIENT_ID;
    const rpsTicket = isBuiltin ? msAccessToken : 'd=' + msAccessToken;
    const xblRes = await request(XBL_AUTH, {
      method: 'POST',
      json: {
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: rpsTicket },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
      },
    });
    if (xblRes.status !== 200 || !xblRes.body.Token) {
      const message = 'Xbox Live 鉴权失败：' + msError(xblRes);
      this.state = 'error';
      this.emit('error', { message, stage: 'xbox' });
      return { ok: false, error: message };
    }
    const xblToken = xblRes.body.Token;
    const uhs = xblRes.body.DisplayClaims && xblRes.body.DisplayClaims.xui && xblRes.body.DisplayClaims.xui[0] && xblRes.body.DisplayClaims.xui[0].uhs;
    if (!uhs) {
      const message = 'Xbox Live 未返回用户标识';
      this.state = 'error';
      this.emit('error', { message, stage: 'xbox' });
      return { ok: false, error: message };
    }
    this.emit('progress', { text: '正在获取 XSTS 令牌…' });

    // 2. XSTS
    const xstsRes = await request(XSTS_AUTH, {
      method: 'POST',
      json: {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      },
    });
    if (xstsRes.status !== 200 || !xstsRes.body.Token) {
      // 2148916233 = 没有 Xbox 账号；2148916238 = 儿童账号需加入家庭
      const xerr = xstsRes.body && xstsRes.body.XErr;
      let hint = '';
      if (String(xerr) === '2148916233') hint = '（该微软账号没有 Xbox 账号，请先在 xbox.com 注册）';
      else if (String(xerr) === '2148916238') hint = '（该账号是儿童账号，需要加入家庭并获取家长同意）';
      const message = 'XSTS 鉴权失败：' + msError(xstsRes) + hint;
      this.state = 'error';
      this.emit('error', { message, stage: 'xsts' });
      return { ok: false, error: message };
    }
    const identityToken = 'XBL3.0 x=' + uhs + ';' + xstsRes.body.Token;
    this.emit('progress', { text: '正在登录 Minecraft 服务…' });

    // 3. Minecraft Services
    const mcRes = await request(MC_LOGIN, { method: 'POST', json: { identityToken } });
    if (mcRes.status !== 200 || !mcRes.body.access_token) {
      // 把 Mojang 的真实错误（errorMessage / 原始响应）也带出来，避免只看到「HTTP 403」瞎猜
      let detail = '';
      if (mcRes.body && mcRes.body.errorMessage) detail = '（' + String(mcRes.body.errorMessage).slice(0, 240) + '）';
      else if (mcRes.body && mcRes.body.raw) detail = '（响应原文：' + String(mcRes.body.raw).slice(0, 240) + '）';
      let hint = null;
      if (mcRes.status === 403) {
        hint =
          'Minecraft 服务返回 403。同一账号在 PCL2/HMCL 等启动器能登，说明账号本身没问题，' +
          '多半是请求被服务器（Akamai）按 User-Agent 拦截——本版已补上浏览器 UA。若仍失败，' +
          '请把上面的「响应详情」发我，那是 Mojang 给的真实原因。';
      }
      const message = 'Minecraft 服务登录失败：' + msError(mcRes) + detail;
      this.state = 'error';
      this.emit('error', { message, hint, stage: 'minecraft' });
      return { ok: false, error: message, hint };
    }
    const mcToken = mcRes.body.access_token;
    const authHeader = { Authorization: 'Bearer ' + mcToken };

    // 4. 是否拥有游戏
    this.emit('progress', { text: '正在校验游戏拥有权…' });
    const entRes = await request(MC_ENTITLEMENTS, { headers: authHeader });
    if (entRes.status !== 200) {
      const message = '校验游戏拥有权失败：' + msError(entRes);
      this.state = 'error';
      this.emit('error', { message, stage: 'entitlement' });
      return { ok: false, error: message };
    }
    const items = (entRes.body && entRes.body.items) || [];
    const owns = items.some((it) => it.name === 'product_minecraft' || it.name === 'game_minecraft');
    if (!owns) {
      const message = '该微软账号没有 Java 版 Minecraft（可在 Minecraft.net 购买或兑换）';
      this.state = 'error';
      this.emit('error', { message, stage: 'entitlement' });
      return { ok: false, error: message };
    }

    // 5. 角色档案（UUID + 用户名）
    this.emit('progress', { text: '正在获取角色档案…' });
    const profRes = await request(MC_PROFILE, { headers: authHeader });
    if (profRes.status !== 200 || !profRes.body.id) {
      const message = '获取角色档案失败：' + msError(profRes) + '（账号可能还没有创建游戏角色名）';
      this.state = 'error';
      this.emit('error', { message, stage: 'profile' });
      return { ok: false, error: message };
    }

    const account = {
      mode: 'msa',
      name: profRes.body.name,
      uuid: profRes.body.id,
      accessToken: mcToken,
      refreshToken,
      clientId,
      // mc token 有效期约 24 小时；微软 refresh token 约 90 天
      mcExpiresAt: Date.now() + (Number(mcRes.body.expires_in) || 86400) * 1000,
      msExpiresAt: Date.now() + expiresIn * 1000,
    };
    this.state = 'done';
    this.emit('success', { account });
    return { ok: true, account };
  }

  /** 确保账号的 mc token 有效（过期则用 refresh token 刷新） */
  async ensureFresh(account) {
    if (!account || account.mode !== 'msa' || !account.refreshToken) return account;
    if (Date.now() < (account.mcExpiresAt || 0) - 5 * 60 * 1000) return account;
    const res = await this.loginWithRefreshToken(account.clientId, account.refreshToken);
    if (!res.ok) throw new Error(res.error);
    return res.account;
  }
}

module.exports = { MsaAuth, request, friendlyMsError };
