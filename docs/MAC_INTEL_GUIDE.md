# macOS（Intel x64）真机验收操作手册

> 适用版本：v0.2.3 + 提交 `f9f75fb`（Mac 移植第一批）
> 更新日期：2026-11-13
> **本轮约定：只在 Mac 本地构建与验证，不打包上传、不发 Release、不改版本号。**

---

## 0. 你现在到底要干什么（三句话）

1. Windows 这边的 Mac 移植代码**已全部写完并推送到 GitHub**（`main` = `f9f75fb`），我这边没有待办了。
2. 剩下唯一必须靠 Mac 才能做的事：**在 Intel Mac 上装环境 → 拉代码 → 跑自检/回归/构建 → 真机验收首次打开、自动更新、陶瓦联机**。
3. 跑完把本文第 12 节列的输出整段贴回对话，我据此修第二轮（主要是联机 TUN 与 ad-hoc 签名的真机问题）。

一句话分工：**你负责在 Mac 上按本文敲命令、看现象、贴输出；我负责改代码。**

---

## 1. Intel 芯片：先确认，别跳过

在 Mac 上打开「终端」，逐条执行：

```bash
uname -m
sysctl -n machdep.cpu.brand_string
sw_vers -productVersion
```

| 命令 | Intel Mac 应有的结果 | 如果结果不对 |
| --- | --- | --- |
| `uname -m` | `x86_64` | `arm64` = Apple Silicon（M1/M2/M3/M4），见下方 |
| `machdep.cpu.brand_string` | `Intel(R) Core(TM) i5/i7/i9 ...` | `Apple M1` 等 = Apple Silicon |
| `sw_vers -productVersion` | 建议 `12.0` 以上 | Electron 33 要求 macOS 10.15+，太旧请先升级系统 |

也可以点左上角  →「关于本机」：Intel 机型会显示「处理器 Intel Core ...」，Apple Silicon 会显示「芯片 Apple M...」。

### 为什么本轮锁死 Intel x64

代码里所有平台判据都按 x64 写死，改一个就要全部对齐：

| 位置 | 值 | 作用 |
| --- | --- | --- |
| `package.json` → `build.mac.arch` | `["x64"]` | 只出 Intel 包 |
| `scripts/build-mac.js` | `--mac --x64` | electron-builder 目标架构 |
| `src/platform.js` → `adoptiumArch()` | `x64` | 自动下载 JDK 的架构段 |
| `src/platform.js` → `terracottaArch()` | `macos-x86_64` | 陶瓦联机资产名 `terracotta-0.4.2-macos-x86_64-pkg.tar.gz` |
| `src/platform.js` → `userAgent()` | `Intel Mac OS X 10_15_7` | 网页/微软登录 UA |
| `scripts/mac-preflight.js` | 校验 `uname -m == x86_64` | 自检会明确告警 |

### 如果你手上其实是 Apple Silicon（M 系列）

先告诉我，先别往下跑完整流程。x64 的 Electron 靠 Rosetta 2 能跑（`/usr/sbin/softwareupdate --install-rosetta --agree-to-license`），但**陶瓦联机的 `.pkg` TUN 授权路径不同，本轮不担保**，需要单独开 arm64 分支（`macos-arm64` 资产 + `arm64` 双架构包）。本手册后续步骤默认你已确认是 Intel。

---

## 2. 准备工具（一次性）

### 2.1 Xcode Command Line Tools

```bash
xcode-select --install
```

弹窗点「安装」，等它装完（几分钟）。验证：

```bash
xcode-select -p
# 应输出类似：/Library/Developer/CommandLineTools
which iconutil
# 应输出：/usr/bin/iconutil
```

`iconutil` 用来把 `assets/icon.png`（已是 1024×1024）转成 `icon.icns`，缺了它打包会失败。

### 2.2 Node.js（Intel/x64 版）

项目在 Windows 上用的是 Node v22.12.0，Mac 上装 **Node 20 LTS 或 22 LTS 均可**，但必须是 **macOS x64 安装包**（Intel Mac 别下 arm64 版）。

从 https://nodejs.org/ 下载 `.pkg` 安装，或已装 Homebrew 时：

```bash
brew install node@22
```

验证（**必须**看到 `x64`）：

```bash
node -v
node -p "process.platform + ' / ' + process.arch"   # darwin / x64
npm -v
```

> 若 `process.arch` 是 `arm64`，说明你的终端/Node 跑在 Apple Silicon 原生模式，回到第 1 节。

---

## 3. 把代码拿到 Mac 上

### 方式 A：直接克隆（推荐，网络已恢复，代码已推送成功）

```bash
cd ~/Documents
git clone https://github.com/wiuw3qde/minecraft-launcher.git
cd minecraft-launcher
git log --oneline -3
```

最后一条**必须**看到第一行是 `f9f75fb feat(macos): Intel x64 移植企划第一批...`。
如果只看到 `098e4ca`，说明拉的是旧提交，执行 `git pull origin main` 再确认。

### 方式 B：完全离线（GitHub 连不上时用）

Windows 上已生成完整离线包 `dist/mac-intel-full.bundle`（2.4 MB，含全部历史与 tags）。用 U 盘 / 微信 / 网盘拷到 Mac，例如放到 `~/Downloads/mac-intel-full.bundle`，然后：

```bash
cd ~/Documents
git clone ~/Downloads/mac-intel-full.bundle minecraft-launcher
cd minecraft-launcher
git remote set-url origin https://github.com/wiuw3qde/minecraft-launcher.git
git log --oneline -3
```

`git remote set-url` 那一步别漏，否则以后 push 会指向本地 bundle 文件。

### 重要：不要把 Windows 的 `node_modules` 拷过来

Electron 是**按平台下载的原生二进制**，Windows 版在 Mac 上一定跑不起来。Mac 上必须重新 `npm install`。`dist/` 同理，不用拷。

---

## 4. 安装依赖

```bash
cd ~/Documents/minecraft-launcher
npm install
```

国内网络建议先设镜像（Electron 二进制约 100 MB）：

```bash
export npm_config_registry=https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```

验证：

```bash
node -e "console.log(require('electron/package.json').version)"
npx electron --version
```

**常见报错处理：**

| 现象 | 处理 |
| --- | --- |
| `npm install` 报平台不匹配 / `EBADPLATFORM` | `rm -rf node_modules && npm install`（先别删 `package-lock.json`；确实不行再删，且**不要提交**变更） |
| Electron 下载卡住/超时 | 设好上面两个镜像变量后重跑 `npm install` |
| `npx electron --version` 弹出一个空窗口 | 正常，Electron 是 GUI 程序；关掉即可，看终端输出的版本号 |
| `npm install` 报 `node-gyp` 相关 | 确认第 2.1 步 CLT 已装完，再重试 |

---

## 5. 环境自检（第一条要贴回给我的输出）

```bash
npm run mac:check
```

报告会自动存一份到 `dist/mac-preflight.txt`。**逐项对照：**

| 输出项 | 期望 | 说明 |
| --- | --- | --- |
| 操作系统 | `[✓] darwin` | 不是 darwin 说明跑错机器 |
| CPU 架构 | `[✓] x86_64（Intel，目标平台 ✓）` | 必须是这个 |
| Node / npm | `[✓]` | 有版本号即可 |
| Xcode CLT | `[✓] /Library/Developer/CommandLineTools` | 显示「未安装」→ 回第 2.1 步 |
| iconutil | `[✓] /usr/bin/iconutil` | 缺失会打包失败 |
| Developer ID 证书 | `[!] 未找到` | **预期如此**，本轮就是 ad-hoc 签名，不用去申请证书 |
| Gatekeeper | `assessments enabled` | 正常 |
| 图标 | `[✓] 1024x1024` | 已确认 |
| electron-builder / Electron | `[✓] 已安装` | 否则回第 4 步 |
| `dist/latest-mac.yml` | `[!] 尚未生成` | **预期如此**，第 7 步构建后才有 |
| 陶瓦守护进程 | `[!] 未安装` | **预期如此**，第 10 步首次联机时安装 |

`[✗]` 只有三项需要立刻处理：操作系统不对、架构不对、CLT/iconutil 缺失。

---

## 6. 全套回归测试

```bash
npm test > /tmp/mc-test.log 2>&1; echo "真实退出码=$?"; tail -80 /tmp/mc-test.log
```

必须看到 `真实退出码=0`。测试链共 18 个文件，包含本轮新增的 `platform.test.js`（Mac 分支纯函数）和 `macbuild.test.js`（`latest-mac.yml` 格式、zip 校验、历史版本隔离）。

**失败也不要跳过、不要自己改测试**，把 `/tmp/mc-test.log` 全文贴回给我 —— Mac 真机上跑测试本来就是为了暴露平台差异，这正是本轮要抓的东西。

---

## 7. 构建 Mac 安装包

```bash
npm run dist:mac
```

首次构建会下载 dmg 相关工具，可能要几分钟。成功后 `dist/` 下应多出三样：

```
MC-Launcher-0.2.3-x64.dmg      用户安装用
MC-Launcher-0.2.3-x64.zip      自动更新必需（MacUpdater 只接受 zip，只有 dmg 会更新失败）
latest-mac.yml                 Mac 端更新清单
```

立刻核对清单（**第二条要贴回给我的输出**）：

```bash
cat dist/latest-mac.yml
```

要求：`path:` 指向 `.zip`；`files:` 里的 `url` 是纯 ASCII 文件名；`sha512`/`size` 与 zip 实际一致。

**注意：**
- 本脚本**不会**改 `package.json` 版本号，仍是 `0.2.3`。
- 它**不碰** Windows 的 `scripts/build.js`，Windows 打包链路零改动。
- 无 Developer ID 时 electron-builder 自动做 ad-hoc 签名，这是本轮约定。
- 若报 `hdiutil` / `iconutil` 错误，多半是第 2.1 步没装好；把完整构建日志贴回。

---

## 8. 首次打开（ad-hoc 签名的必经步骤）

推荐**先用源码直接跑一遍**，跳过签名问题、最快验证功能：

```bash
npm start
```

再验证安装包：打开 `dist/MC-Launcher-0.2.3-x64.dmg` → 把 App 拖进「应用程序」。

首次打开若被 Gatekeeper 拦（"无法打开，因为来自身份不明的开发者" / "已损坏"）：

1. **首选**：在 Finder 里对 App 按住 `Control` 点按（或右键）→「打开」→ 弹窗再点「打开」，只需一次；
2. 或终端执行：

```bash
xattr -cr "/Applications/MC 启动器.app"
open -a "MC 启动器"
```

> 自动更新替换 `.app` 后可能再次被拦，同样用 `xattr -cr` 放行。根治办法是正式签名 + 公证，属于后续轮次。

---

## 9. 真机验收清单（逐项打勾，异常记下来）

### A. 原功能不动（最重要，Windows 上有的都要有）

- [ ] 设置页「环境信息」显示 `macOS`（不是 Windows）
- [ ] Java 检测：能找到系统 JDK（`/Library/Java/JavaVirtualMachines` 等），或手动选择 `Contents/Home/bin/java` 成功
- [ ] 无 Java 时「自动下载 JDK」能下到 **mac/x64** 版并正确启动（`bin/java` 有可执行位）
- [ ] 版本下载/安装 → 启动游戏，能进主菜单
- [ ] 离线登录 / 正版登录
- [ ] Mod 平台下载、整合包导入、其它启动器配置导入（Mac 路径 `~/Library/Application Support/minecraft`）
- [ ] 自动备份、备份恢复（设置页第 5/6 区块）
- [ ] 世界存档卡片、冒险日记、跨版本开档守卫（S0–S2）
- [ ] 崩溃日志一键上报

### B. 自动更新（本轮**只验证不下发**）

- [ ] 设置页「自动更新」填 `https://github.com/wiuw3qde/minecraft-launcher` 后点检查，不报错、不卡在「正在检查更新…」
- [ ] 关键：Mac 端只读 `latest-mac.yml` 且只接受 `.zip`，**绝不会去下 `.exe`**
- [ ] 本轮不发 Release，所以「已是最新版本」或「无可用更新」都属正常；真正的新版推送放到下一轮

### C. 联机（最容易出问题，见第 10 节）

- [ ] 联机页出现「macOS 首次使用需安装系统组件」提示条
- [ ] 安装 `.pkg` → 重启启动器 → 提示条消失 → 「启动联机」状态正常
- [ ] 与 Windows 端实际联一局

### D. 安装包

- [ ] dmg 安装后的 App 能打开、能启动游戏、能读到用户数据

---

## 10. 联机专项（陶瓦 TUN，重点看这里）

macOS 建虚拟网卡需要系统级守护进程，Windows 上不存在这一步，所以**这是本轮最大未知项**。

**操作步骤：**

1. 启动器 →「联机」页 → 点「**打开系统组件安装包**」；
2. 在弹出的 `.pkg` 安装器里输入管理员密码完成安装（会写入 `/Library/LaunchAgents/net.burningtnt.terracotta.daemon.plist` 并拉起 `/Applications/terracotta.app` 内的守护进程）；
3. **完全退出并重启启动器**；
4. 回到联机页 →「启动联机」，观察状态与房间码。

**检查命令（第三条要贴回给我的输出）：**

```bash
ls -l /Library/LaunchAgents/net.burningtnt.terracotta.daemon.plist
ls -l /Applications/terracotta.app/Contents/MacOS/terracotta-daemon
launchctl list | grep -i terracotta
ls -la ~/Library/Application\ Support/MC\ 启动器/terracotta/
log show --last 5m --predicate 'process CONTAINS[c] "terracotta"' 2>/dev/null | tail -40
```

**若失败**，别自己折腾权限，把这些贴回：联机页状态文字 + 上面命令输出 + 启动器终端输出。已知候选修法（我来判断用哪个）：改为优先启动 `/Applications/terracotta.app`、给裸 Mach-O 重新 `xattr -c`、或引导用户在「系统设置 → 隐私与安全性」放行。

---

## 11. 自动更新与发版（本轮**不要执行**，只作说明）

- darwin 下 `electron-updater` 的 `getDefaultChannelName()` 固定为 `latest-mac` → 只读 `latest-mac.yml`；`MacUpdater.findFile()` 强制要 `.zip`。这就是本轮单独写 `scripts/build-mac.js` 生成清单的原因。
- 将来真正发版时，**同一个 GitHub Release 必须同时有**：`latest.yml` + Windows `.exe`（含便携版）、`latest-mac.yml` + Mac `.dmg` + `.zip`；缺任何一样，对应平台就收不到更新。
- 在 Mac 上跑 `node scripts/publish.js` 只会补齐 Mac 资产、不会动 Windows 资产（脚本按资产名跳过已存在的）。它需要 `.github_token`（该文件在 `.gitignore` 里，不会随仓库过去），需要时我给你或你本地放一份。
- **发布前一定先 `git push origin main`**，否则 GitHub 自动建的 tag 会指向旧提交（v0.2.3 踩过这个坑）。
- 版本号规则仍是 `0.X.9 → 0.(X+1).0`，当前 `0.2.3` 不动。

---

## 12. 请贴回给我的东西（四份，越多越好）

1. `npm run mac:check` 终端全文（或 `dist/mac-preflight.txt`）
2. `npm test` 全文 + `真实退出码=0` 那一行（失败就贴 `/tmp/mc-test.log`）
3. `npm run dist:mac` 全文 + `cat dist/latest-mac.yml` 内容
4. 第 9 节验收清单的异常项，尤其是：
   - 联机页状态文字 + 第 10 节检查命令输出
   - 首次打开被 Gatekeeper 拦的截图
   - 任何弹窗报错截图

建议直接在 Mac 上跑一条把前三份汇总（方便一次复制）：

```bash
cd ~/Documents/minecraft-launcher
{ echo "===== mac:check ====="; npm run mac:check 2>&1; \
  echo "===== npm test ====="; npm test 2>&1; echo "test_exit=$?"; \
  echo "===== latest-mac.yml ====="; cat dist/latest-mac.yml 2>&1; } > ~/Desktop/mc-mac-report.txt 2>&1
```

产物在桌面 `mc-mac-report.txt`，拖进对话即可。

---

## 13. 现在不要做的 5 件事

1. ❌ 不要跑 `npm run ship` / `npm run release` / `npm run dist`（后两个是 Windows 链路）。
2. ❌ 不要改 `package.json` 的版本号（保持 `0.2.3`）。
3. ❌ 不要改 `scripts/build.js`、Windows 的 `latest.yml` 或任何 Windows 打包配置（「原功能不动」）。
4. ❌ 不要手动编辑 `dist/latest-mac.yml`（哈希必须脚本算）。
5. ❌ 不要把 `dist/`、`node_modules/` 提交到 git（已在 `.gitignore`）。

---

## 附：一条龙命令（确认是 Intel 后可直接整段粘贴）

```bash
# 0) 确认芯片
uname -m                                   # 必须是 x86_64

# 1) 工具（首次才需要）
xcode-select --install
node -p "process.platform + '/' + process.arch"   # darwin/x64

# 2) 代码
cd ~/Documents && git clone https://github.com/wiuw3qde/minecraft-launcher.git && cd minecraft-launcher
git log --oneline -1                      # 必须是 f9f75fb

# 3) 依赖
export npm_config_registry=https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install

# 4) 自检 + 测试 + 构建
npm run mac:check
npm test > /tmp/mc-test.log 2>&1; echo "真实退出码=$?"; tail -80 /tmp/mc-test.log
npm run dist:mac
cat dist/latest-mac.yml

# 5) 跑起来看功能
npm start
```

跑完按第 8～10 节做真机验收，按第 12 节把输出贴回。
