'use strict';
/**
 * 读取 Windows PE 文件的版本信息字符串（ProductName / CompanyName / FileVersion 等）。
 * 纯 Node 实现：直接在文件里定位 UTF-16 的 "VS_VERSION_INFO" 签名后解析结构，
 * 不做完整 PE 解析，足够用于构建后自检。
 *
 * 用法：node verify-exe.js <exe路径> [期望的 ProductName]
 * 退出码 0 = 校验通过；1 = 读取失败或不符合预期
 */
const fs = require('fs');

function readVersionInfo(file) {
  const buf = fs.readFileSync(file);
  // "VS_VERSION_INFO" 的 UTF-16LE 编码。文件中可能出现多次（asar 数据里会有巧合匹配），
  // 逐个校验结构，只认根节点和子节点键名都正确的那个。
  const sig = Buffer.from('VS_VERSION_INFO', 'utf16le');

  const readStr = (p) => {
    let end = p;
    while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
    return { text: buf.toString('utf16le', p, end), next: end + 2 };
  };
  const align4 = (p) => (p + 3) & ~3;

  let from = 0;
  let root = -1;
  while (from < buf.length) {
    const pos = buf.indexOf(sig, from);
    if (pos < 0) break;
    from = pos + 1;
    const h = pos - 6;
    if (h < 0) continue;
    if (buf.readUInt16LE(h + 4) !== 0) continue; // wType 必须为 0
    const key = readStr(h + 6);
    if (key.text !== 'VS_VERSION_INFO') continue;
    let p = align4(key.next);
    const valueLen = buf.readUInt16LE(h + 2);
    if (valueLen > 0) p += valueLen;
    if (p + 6 > buf.length) continue;
    const childKey = readStr(p + 6);
    if (childKey.text !== 'StringFileInfo' && childKey.text !== 'VarFileInfo') continue;
    root = h;
    break;
  }
  if (root < 0) return null;

  // 遍历子结构（StringFileInfo / VarFileInfo）
  const strings = {};
  const u16 = (p) => buf.readUInt16LE(p);
  const skipKey = (p) => align4(readStr(p).next);
  const rootEnd = root + u16(root);
  let p = align4(readStr(root + 6).next);
  const rootValueLen = u16(root + 2);
  if (rootValueLen > 0) p += rootValueLen;
  while (p + 6 <= rootEnd) {
    const childLen = u16(p);
    if (childLen <= 0) break;
    const childType = u16(p + 4);
    let q = skipKey(p + 6); // 跳过 "StringFileInfo"
    if (childType === 1 && buf.toString('utf16le', p + 6, q).indexOf('StringFileInfo') >= 0) {
      // StringFileInfo 的子节点是 StringTable
      const sfEnd = p + childLen;
      while (q + 6 <= sfEnd) {
        const tableLen = u16(q);
        if (tableLen <= 0) break;
        const tableEnd = q + tableLen;
        let r = skipKey(q + 6); // 跳过语言代码页（如 040904b0）
        while (r + 6 <= tableEnd) {
          const strLen = u16(r);
          if (strLen <= 0) break;
          const strValueLen = u16(r + 2);
          const keyStart = r + 6;
          // szKey（如 "ProductName"）
          let keyEnd = keyStart;
          while (keyEnd + 1 < buf.length && !(buf[keyEnd] === 0 && buf[keyEnd + 1] === 0)) keyEnd += 2;
          const key = buf.toString('utf16le', keyStart, keyEnd);
          // value：按 4 字节对齐后开始
          let valStart = (keyEnd + 2 + 3) & ~3;
          let valEnd = valStart;
          while (valEnd + 1 < buf.length && !(buf[valEnd] === 0 && buf[valEnd + 1] === 0)) valEnd += 2;
          if (strValueLen > 0) {
            strings[key] = buf.toString('utf16le', valStart, valEnd);
          }
          r += strLen;
        }
        q += tableLen;
      }
    }
    p += childLen;
  }
  return strings;
}

/* ---------------- CLI ---------------- */
const file = process.argv[2];
const expect = process.argv[3];
if (!file) {
  console.error('用法：node verify-exe.js <exe> [期望 ProductName]');
  process.exit(2);
}
const info = readVersionInfo(file);
if (!info) {
  console.error('[verify] 未能读取版本信息：' + file);
  process.exit(1);
}
console.log('[verify] ' + file);
for (const k of ['ProductName', 'CompanyName', 'FileDescription', 'FileVersion', 'ProductVersion']) {
  if (info[k] !== undefined) console.log('    ' + k + ' = ' + JSON.stringify(info[k]));
}
const problems = [];
if (expect && info.ProductName !== expect) {
  problems.push(`ProductName 应为 "${expect}"，实际 "${info.ProductName}"`);
}
// 常见异常：字符串末尾混入杂字符（曾经出现过尾部多一个 X 的情况）
for (const [k, v] of Object.entries(info)) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v) || /(X|\s)$/.test(v)) {
    problems.push(`${k} 末尾有异常字符：${JSON.stringify(v)}`);
  }
}
if (problems.length) {
  console.error('[verify] 校验失败：');
  for (const p of problems) console.error('    - ' + p);
  process.exit(1);
}
console.log('[verify] 通过 ✓');
process.exit(0);
