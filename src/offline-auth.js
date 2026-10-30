'use strict';
const crypto = require('crypto');

/**
 * 离线模式的标准 UUID 算法，等价于 Java 的 UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))
 * 与 Mojang 官方一度使用的离线 UUID 保持一致，皮肤站/部分模组会依赖它
 */
function offlineUuid(playerName) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + playerName, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // version -> 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // variant -> IETF
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createOfflineAccount(playerName) {
  const name = String(playerName || '').trim();
  if (!name) throw new Error('玩家名不能为空');
  return {
    name,
    uuid: offlineUuid(name),
    accessToken: offlineUuid(name + '|token').replace(/-/g, ''),
    userType: 'legacy',
    userProperties: '{}',
  };
}

module.exports = { offlineUuid, createOfflineAccount };
