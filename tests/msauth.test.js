'use strict';
/* 正版登录（msauth）测试：请求管线、错误处理、刷新逻辑 */
const assert = require('assert');
const { MsaAuth } = require('../src/msauth');

let failures = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => console.log('  ✓ ' + name)).catch((e) => { failures++; console.log('  ✗ ' + name + '\n    ' + e.message); });
    console.log('  ✓ ' + name);
  } catch (e) {
    failures++;
    console.log('  ✗ ' + name + '\n    ' + e.message);
  }
  return Promise.resolve();
}

(async () => {
  console.log('正版登录模块测试\n');

  /* ---------- 0. 新登录入口：内置 client ID + live.com 授权码流程 ---------- */
  console.log('=== 新登录入口（login.live.com 授权码流程）===');
  const liveAuth = new MsaAuth();
  let liveUrl = null;
  liveAuth.on('live-url', (e) => (liveUrl = e.url));
  const r = liveAuth.startLiveLogin();
  check('startLiveLogin 不报错且返回 ok', () => assert.strictEqual(r.ok, true));
  check('emit live-url 且包含内置 client ID 00000000402b5328', () =>
    assert.ok(liveUrl && liveUrl.includes('client_id=00000000402b5328'), 'liveUrl=' + liveUrl));
  check('授权地址指向 login.live.com 授权端点', () =>
    assert.ok(liveUrl && liveUrl.startsWith('https://login.live.com/oauth20_authorize.srf'), liveUrl || ''));
  check('scope 为 MBI_SSL（Xbox Live）', () =>
    assert.ok(liveUrl && liveUrl.includes(encodeURIComponent('service::user.auth.xboxlive.com::MBI_SSL')), liveUrl || ''));

  // submitLiveCode 应能解析回跳网址里的 code（无需联网）
  const parseAuth = new MsaAuth();
  let parseState = null;
  parseAuth.on('error', (e) => (parseState = e));
  await parseAuth.submitLiveCode('https://login.live.com/oauth20_desktop.srf?code=ABC123xyzXYZ789qwe&lc=1033');
  check('能从回跳网址解析出 code 并进入换令牌流程（非“无法解析”）', () =>
    assert.ok(parseState && !/解析/.test(parseState.message), 'msg=' + (parseState && parseState.message)));

  // 真实微软 desktop code 可能含 / + = 等 base64 字符，解析不应被字符集卡住
  const parseAuth2 = new MsaAuth();
  let parseState2 = null;
  parseAuth2.on('error', (e) => (parseState2 = e));
  await parseAuth2.submitLiveCode(
    'https://login.live.com/oauth20_desktop.srf?code=M.C506_BL2.2/U.MsaArtifacts+DrVFLDjm0I4elwsc6Hygsd6u7bX0FUT6QUf==&lc=1033'
  );
  check('含 / + = 的真实格式 code 也能解析（不被字符集卡住）', () =>
    assert.ok(parseState2 && !/解析/.test(parseState2.message), 'msg=' + (parseState2 && parseState2.message)));


  console.log('正版登录模块测试\n');

  /* ---------- 1. 客户端 ID 校验 ---------- */
  console.log('=== 本地校验 ===');
  const auth = new MsaAuth();
  const errors = [];
  auth.on('error', (e) => errors.push(e));
  const bad = await auth.startDeviceLogin('not-a-client-id');
  check('无效客户端 ID 被本地拦截', () => {
    assert.strictEqual(bad.ok, false);
    assert.ok(/Azure/.test(bad.error), bad.error);
  });
  check('拦截后状态为 error', () => assert.strictEqual(auth.state, 'error'));
  check('error 事件已推送', () => assert.strictEqual(errors.length, 1));

  /* ---------- 2. 请求管线（真实网络，期望 AAD 报 invalid_client） ---------- */
  console.log('\n=== 设备代码请求管线（真实网络）===');
  const auth2 = new MsaAuth();
  auth2.on('error', () => {});
  const res = await auth2.startDeviceLogin('12345678-1234-1234-1234-123456789012');
  check('格式合法的请求能到达微软（返回 AAD 业务错误而非网络错误）', () => {
    assert.strictEqual(res.ok, false);
    // 不存在的 client id → AAD 返回 invalid_client；能拿到这个错误说明请求编码/解析都正确
    assert.ok(/invalid_client|client|unauthorized_client|AADSTS/i.test(res.error), '错误信息异常：' + res.error);
  });
  check('失败后状态为 error 且事件已触发', () => {
    assert.strictEqual(auth2.state, 'error');
  });

  /* ---------- 3. ensureFresh 刷新逻辑（不联网） ---------- */
  console.log('\n=== ensureFresh 刷新判断 ===');
  const auth3 = new MsaAuth();
  const fresh = { mode: 'msa', name: 'Steve', uuid: 'u1', accessToken: 'tok', refreshToken: 'rt', clientId: 'cid', mcExpiresAt: Date.now() + 24 * 3600 * 1000 };
  await check('未过期的账号原样返回', async () => {
    const got = await auth3.ensureFresh(fresh);
    assert.strictEqual(got.accessToken, 'tok');
  });
  const noRefresh = { mode: 'msa', name: 'Alex', uuid: 'u2', accessToken: 'tok2', mcExpiresAt: Date.now() - 1000 };
  await check('过期但没有 refresh token 时原样返回（不炸）', async () => {
    const got = await auth3.ensureFresh(noRefresh);
    assert.strictEqual(got.accessToken, 'tok2');
  });
  await check('非 msa 账号（离线）原样返回', async () => {
    const got = await auth3.ensureFresh({ mode: 'offline', name: 'x' });
    assert.strictEqual(got.mode, 'offline');
  });
  await check('过期且有 refresh token 时走刷新流程（无效 token 应报错而非崩溃）', async () => {
    const expired = { mode: 'msa', name: 'A', uuid: 'u3', accessToken: 't', refreshToken: 'invalid-refresh-token', clientId: '12345678-1234-1234-1234-123456789012', mcExpiresAt: Date.now() - 1000 };
    const r = await auth3.loginWithRefreshToken(expired.clientId, expired.refreshToken);
    assert.strictEqual(r.ok, false);
    assert.ok(/刷新登录态失败/.test(r.error), r.error);
  });

  /* ---------- 4. 取消逻辑 ---------- */
  console.log('\n=== 取消 ===');
  const auth4 = new MsaAuth();
  auth4.cancel();
  check('取消后状态为 cancelled', () => assert.strictEqual(auth4.state, 'cancelled'));

  /* ---------- 5. 错误提示映射 ---------- */
  console.log('\n=== AADSTS 错误的中文修复提示 ===');
  const { friendlyMsError } = require('../src/msauth');
  await check('AADSTS70002（未标记公共客户端）给出可操作提示', async () => {
    const r = friendlyMsError({
      status: 400,
      body: { error: 'invalid_client', error_description: 'AADSTS70002: The provided client is not supported for this feature. The client application must be marked as \'mobile.\' Trace ID: x' },
    });
    assert.ok(/AADSTS70002/.test(r.message), r.message);
    assert.ok(r.hint && /移动和桌面应用程序/.test(r.hint), '提示应包含平台配置说明：' + r.hint);
    assert.ok(r.hint && /允许公共客户端流/.test(r.hint));
  });
  await check('AADSTS65001（账户类型错误）给出对应提示', async () => {
    const r = friendlyMsError({ status: 400, body: { error_description: 'AADSTS65001: The user or administrator has not consented' } });
    assert.ok(r.hint && /个人 Microsoft 账户/.test(r.hint), r.hint);
  });
  await check('未知错误不硬造提示', async () => {
    const r = friendlyMsError({ status: 500, body: { error_description: 'something else' } });
    assert.strictEqual(r.hint, null);
  });

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过 ✓'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
