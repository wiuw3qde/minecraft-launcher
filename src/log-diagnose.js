'use strict';
/* 错误日志分析基础版（ROADMAP #6）。
 * 规则库匹配常见崩溃/错误特征，给出中文诊断与可点击修复建议。
 * 修复动作（action）由渲染端解释执行（跳转页面 / 调用对应 IPC）。 */

const RULES = [
  {
    id: 'oom',
    level: 'error',
    test: (t) => /OutOfMemoryError|Java heap space|GC overhead limit exceeded|物理内存不足/i.test(t),
    title: '内存不足（Out Of Memory）',
    detail:
      'JVM 堆内存耗尽。常见原因：分配内存过小、Mod 过多、世界/存档过大，或同时开了太多程序。',
    fixes: [
      { label: '把最大内存提到 4096 MB', action: 'set-memory', value: 4096 },
      { label: '打开内存设置页', action: 'open-settings' },
    ],
  },
  {
    id: 'javaver',
    level: 'error',
    test: (t) =>
      /UnsupportedClassVersionError|Unsupported major\.minor|has been compiled by a more recent version of the Java|requires Java (\d+)/i.test(t),
    title: 'Java 版本不符',
    detail:
      '游戏或某个 Mod 需要更高版本的 Java（1.18+ 需 Java 17，1.21+ 需 Java 21）。当前 Java 版本过低。',
    fixes: [
      { label: '自动检测并安装所需 Java', action: 'auto-java' },
      { label: '查看 Java 设置', action: 'open-settings' },
    ],
  },
  {
    id: 'modconflict',
    level: 'error',
    test: (t) =>
      /Could not execute entrypoint stage|DuplicateMod|Mod [^\n]* conflicts|java\.lang\.RuntimeException: .*mod|Mod [^\n]* has been|Exception reading|net\.fabricmc/i.test(t),
    title: 'Mod 冲突 / 加载失败',
    detail: '某个 Mod 无法加载或相互冲突，常见于版本不兼容、重复安装或依赖缺失。',
    fixes: [
      { label: '打开 Mod 管理页排查', action: 'open-mods' },
      { label: '查看完整日志', action: 'show-log' },
    ],
  },
  {
    id: 'corrupt',
    level: 'error',
    test: (t) =>
      /Could not find or load main class|NoClassDefFoundError|ClassNotFoundException|java\.util\.zip\.ZipException|Invalid or corrupt|jar was unsigned|invalid sha|校验不通过/i.test(t),
    title: '版本文件损坏 / 依赖缺失',
    detail: '核心 jar 或某个库文件损坏、缺失或被截断，通常是下载中断或磁盘问题导致。',
    fixes: [
      { label: '重装该版本（重新下载）', action: 'reinstall' },
      { label: '清除并重建 natives', action: 'clear-natives' },
    ],
  },
  {
    id: 'natives',
    level: 'error',
    test: (t) =>
      /no lwjgl|missing natives|LWJGL|Could not load native|UnsatisfiedLinkError|failed to locate|native library/i.test(t),
    title: '缺少原生库（natives）',
    detail: '启动所需的平台原生库（如 LWJGL）缺失或不匹配，常见于跨版本/跨系统拷贝。',
    fixes: [
      { label: '清除并重建 natives', action: 'clear-natives' },
      { label: '重装该版本', action: 'reinstall' },
    ],
  },
  {
    id: 'gl',
    level: 'warn',
    test: (t) =>
      /GLFW error|OpenGL|Could not create context|Failed to create window|The driver does not appear|graphics device|GL_CAPABILITY/i.test(t),
    title: '显卡 / OpenGL 驱动问题',
    detail: 'OpenGL 上下文创建失败，多因显卡驱动过旧，或 OptiFine 与当前显卡/驱动不兼容。',
    fixes: [
      { label: '更新显卡驱动', action: 'driver' },
      { label: '暂时移除 OptiFine 试试', action: 'open-mods' },
    ],
  },
  {
    id: 'auth',
    level: 'warn',
    test: (t) => /Invalid session|Authentication|请重新登录|AccessToken|Please restart|locked account/i.test(t),
    title: '登录 / 会话失效',
    detail: '正版账号会话过期或令牌无效，需要重新登录微软账号。',
    fixes: [{ label: '回到启动页重新登录', action: 'open-launch' }],
  },
  {
    id: 'crash',
    level: 'error',
    test: (t) => /Process crashed with exit code|Game crashed|EXCEPTION_ACCESS_VIOLATION|崩溃|HSGSI/si.test(t),
    title: '游戏崩溃',
    detail: '进程异常退出。请结合上方更具体的错误（Mod / 内存 / 显卡）定位根因。',
    fixes: [{ label: '查看完整日志', action: 'show-log' }],
  },
  {
    id: 'exit0',
    level: 'info',
    test: (t) => /退出码 0|exit code 0|Process exited with code 0/i.test(t),
    title: '正常退出',
    detail: '游戏以退出码 0 结束，属于正常关闭，无需处理。',
    fixes: [],
  },
];

/**
 * 分析日志文本
 * @returns {{ok:boolean, hits:Array, message?:string}}
 */
function diagnose(text) {
  const t = String(text || '');
  const hits = RULES.filter((r) => r.test(t)).map((r) => ({
    id: r.id,
    level: r.level,
    title: r.title,
    detail: r.detail,
    fixes: r.fixes,
  }));
  if (!hits.length) {
    return {
      ok: true,
      hits: [],
      message:
        '未发现已知错误特征。若游戏确实异常，请检查：① Java 版本是否匹配游戏版本；② 分配内存是否足够；③ Mod 之间是否兼容。',
    };
  }
  // 去重：若同时命中 exit0（正常）与崩溃类，优先保留错误类
  const filtered = hits.filter((h) => !(h.id === 'exit0' && hits.some((x) => x.level === 'error' && x.id !== 'exit0')));
  return { ok: true, hits: filtered };
}

module.exports = { diagnose, RULES };
