# DSH 桌面壳开发文档

## 1. 快速开始

```sh
# 安装依赖（Electron 35 + electron-builder）
npm install

# 开发模式：userData 固定在 ~/.dsh-dev，不影响已安装应用
npm start

# Electron-free 模块测试（macOS / Windows / Linux 都跑这一条）
npm run smoke

# Electron 内冒烟（菜单/托盘/Dock 等）
DSH_DESKTOP_SMOKE=1 npx electron .            # macOS / Linux
$env:DSH_DESKTOP_SMOKE=1; npx electron .      # Windows PowerShell

# 构建 macOS 应用目录 / DMG + ZIP（产物带版本号，见「9. 打包与发布」）
npm run dist
npm run dist:dmg

# 构建 Windows 安装包（NSIS + 便携版 + zip）
npm run dist:win          # 双架构
npm run dist:win:x64
npm run dist:win:arm64    # Windows on ARM

# 构建 Linux 安装包（AppImage + deb，必须在 Linux 主机上跑）
npm run dist:linux        # 本机架构
npm run dist:linux:x64    # 或 dist:linux:arm64
```

> **三条打包链路互不相同**（dmg/zip、nsis/portable、AppImage/deb）。改了
> `package.json#build` 或壳里任何与平台有关的东西，三个平台都要跑一次；CI 与
> release 流水线都已覆盖三个平台。

> **Linux 的架构名按格式不同，不能统一写成 `x64`。** `${arch}` 宏对 AppImage
> 展开为 `x86_64`、对 deb 展开为 `amd64`（`arm64` 不变），所以 x64 的产物是
> `dsh-desktop-<ver>-linux-x86_64.AppImage` 与 `…-linux-amd64.deb`。`package.json`
> 已给 `build.appImage` / `build.deb` 分别声明 `artifactName`；**不要**只依赖顶层
> `artifactName`（那是 macOS 命名，产物会带 `-macos-` 后缀）。AppImage/deb 也不能
> 从 macOS 或 Windows 交叉构建，必须在 Linux 主机上打包。

> **Windows 打包必须走 `node scripts/build-win.js`（即 `npm run dist:win*`），
> 不要直接调 `electron-builder`。** 它会固定 `ELECTRON_BUILDER_7Z_FILTER=BCJ`，
> 并在构建完事后校验安装包的 payload 压缩方法。
>
> 原因（已实测复现）：electron-builder 26.15.x 用 7za 的自动滤镜打 NSIS 的
> `app-*.7z` 时，x64/arm64 上会选到 **BCJ2**；而安装器内置的 Nsis7z 解码器读不了
> 多流 BCJ2，于是**静默跳过 payload 里的每一个 PE 文件** —— 主程序 `DeepSeek
> Harness.exe`、所有 `.dll`、以及随包的可执行文件全都不落地。安装器退出码仍是
> **0**，装出来的目录里 `locales/`、`*.pak`、`resources/` 一应俱全，看着像装好了，
> 但那个能启动应用的可执行文件不在。
>
> **受影响的产物是 `-setup.exe` 和 `-portable.exe` 两种**：portable 也是 NSIS
> 自解压包，解压走的是同一个 Nsis7z 解码器（解到 `%TEMP%` 再启动），所以它和
> 安装器一样会丢文件 —— 而且更容易被误判成"架构不支持"，因为它双击后什么都不发生。
> `.zip` 不受影响（用户自己的解压工具解，不经过 Nsis7z），但仍由同一条命令产出，
> 保证三个渠道产物一致。
>
> Windows 11 ARM64 实测对比（同一个包，只改滤镜）：
>
> | | 文件数 | 体积 | DLL | 主程序 | 启动 |
> |---|---|---|---|---|---|
> | BCJ2（错） | 68 | 71.3 MB | 0 | 缺失 | — |
> | BCJ（对） | 75 | 287.7 MB | 6 | `PE 0xAA64` | ALIVE |
>
> 这正是上游在 electron-builder 26.16+ 修掉的问题（PR「reliably install the main
> executable and native binaries on x64 and arm64」）；26.15 也认这个环境变量，
> 所以不强制升级也能修。**验证方式只有一种：在真 Windows 上装一遍，确认
> `DeepSeek Harness.exe` 存在且能启动** —— 只看安装器退出码会漏掉这个 bug。

### 1.1 开发态数据隔离

- 开发态（`app.isPackaged === false`）自动执行
  `app.setPath('userData', '~/.dsh-dev')`，settings.json、logs、单实例锁都在这里；
  目录不存在时启动即自动创建（约定：开发过程中一律使用 `~/.dsh-dev`，
  防止与用户空间 `~/.dsh` 或已安装应用数据冲突）。
- 本地服务的 `DSH_HOME` 默认也是 `~/.dsh-dev`，与用户常规 `~/.dsh` 分离。
- 需要特殊隔离时设置环境变量：

```sh
DSH_DESKTOP_USER_DATA=~/tmp/dsh-shell-dev npm start
```

已打包应用默认仍使用平台 userData 目录
（`~/Library/Application Support/DeepSeek Harness` / `%APPDATA%\DeepSeek Harness`），
除非显式设置该环境变量。

## 2. 目录与模块

> 模块地图与数据流的技术总览见 [架构文档](architecture.md)（README 只保留产品介绍）。

```
src/
├── main.js           主进程：userData 隔离、窗口/会话生命周期、IPC、菜单/托盘装配
├── settings.js       设备级设置归一化与原子保存；默认 dshHome
├── window-manager.js 窗口 bounds/active-view/last-active 持久化与恢复
├── runtime-store.js  local/remote runtime state、`dsh web` URL 解析、原子 clone/build 锁
├── ports.js          SSH 本地转发端口的进程内预留与 TCP 探测
├── connection.js     本地服务/SSH 隧道连接、state 复用、服务重置、日志 ring
├── remote-protocol.js 远端协议：ssh 命令常量与纯解析器（无依赖，Android 侧同源）
├── update.js         官方产物安装管线：registry 预检 → npm install → 原子切换 → 重启
├── update-manager.js 组件检查/更新：harness、npm 插件、git preset
├── components.js     组件目录、归一化、npm spec 解析、版本比较/树哈希
├── ssh.js            ssh config 解析、目标解析、quoting、remote path
├── tools.js          node/pnpm 探测（engine 过滤）与干净子进程环境
├── runner.js         runCommand / spawnService（独立进程组/进程树）
├── service-guard.js  驻留服务的跨平台父进程监护（node，取代 sh 包装脚本）
├── platform.js       **唯一**平台差异层（killTree、可执行名、PATH、node 归档、current 指针）
├── process-scan.js   **唯一**进程/端口发现层（lsof+ps / netstat+CIM）
├── dialogs.js        SetupDialog（嵌入式 WebContentsView）
├── labels.js         全局一致的 DSH-[终端] 标签
├── external-open.js  harness 导航 URL 分类（主框架根路径 / 子框架跨源）
├── menu.js / tray.js / windows.js  菜单、托盘、窗口呈现（按平台挂载，见 §7.1）
├── picker.js         统一目录选择器（窗口 sheet 父窗口解析 / 取消语义归一）
└── ui/
    ├── shell.html / shell.css / shell-preload.js   主窗口 46px 壳边框
    └── settings.html / dialog-preload.js           设置面板（定位菜单 + 居中内容）
```

harness 视图的 preload 是 `src/harness-preload.js`（不在 `ui/` 下）：它只暴露一个
`__DSH_DIRECTORY_PICKER__` 桥，供 harness 的 native directory-picker 行使用，
避免回退到 Host 侧非前台的 `osascript` 面板（见 `docs/architecture.md` §3.3）。

数据流：

```text
BrowserWindow (shell.html 边框)
 ├─ harness WebContentsView        ← http://127.0.0.1:<实际端口>
 └─ settings WebContentsView       ← dialog:* / updates:* IPC
        │
        └─ main.js: workspace ── session ── ConnectionManager
                                            ├─ local service (node bin.js web --port)
                                            ├─ ssh tunnel (ssh -N -L)
                                            └─ UpdateManager / Updater
```

## 3. 多窗口模型

- `workspaces`：`Map<id, workspace>`，一个 BrowserWindow 一个 workspace。
- `sessions`：`Map<deviceKey, session>`。`deviceKey` 为 `local`、`ssh:<host>`，或连接后归一出的 `machine:<id>`（同一远程机器经不同 ssh 别名接入时合并）。
- 同设备窗口共享 session；窗口关闭只是隐藏，workspace 持续存活，显式退出时才销毁。
- 窗口切换设备调用 `attachWorkspace`：旧 SSH session 在最后一个窗口离开后停止；
  `local` session 常驻以支持多开。
- 任何窗口保存连接设置后，主进程重载该设备所有窗口的设置 WebContentsView，
  防止“旧表单被另一个窗口重新保存”。
- `window-manager.js` 持久化 `window-state.json`：bounds、active view、last-active
  workspace/device；启动先恢复 last-active 设备，IPC fallback 不再只靠焦点扫描。
- 视图聚焦一律经 `windows.js#focusViewInKeyWindow(win, webContents)`：聚焦
  `WebContentsView` 会**激活其宿主窗口**，会话级广播若不加守卫就会让后台窗口抢焦点
  （双屏下窗口与顶部菜单来回闪）。守卫用 `win.isFocused()`，该值在窗口自身
  `focus` 事件里已为 true，故正常切换仍会重新聚焦视图。

## 4. 端口与冲突策略

> 端口/进程策略的技术总览见 [架构文档](architecture.md)。

### 4.1 规则

1. 本地和远端 `dsh web` 统一使用 `--port 0`；CLI 打印
   `dsh web: http://127.0.0.1:<port>`，壳解析后写入 state。
2. SSH 本地转发不能由 ssh 汇报端口，所以仍使用**优先端口 + 顺延 30**：
   设置中的 `localPort` 空闲则用，否则 `src/ports.js` 探测下一个空闲端口。
3. 转发端口的“探测 → 绑定”窗口用 `reservePort/releasePort` 括起来；停止/连接失败必须
   `releaseReservedPorts()`。
4. 本地 clone、远端 clone、build pipeline 都通过 `runtime-store.js` 的原子目录锁：
   - 本地锁 owner 为 `{pid, host, createdAt}`，owner 进程消失即 stale；
   - 远端锁写 owner JSON，超过 2 小时视为 stale，可被下一实例回收。
5. 旧版/残留自管服务通过 `<dshHome>/desktop-web.state.json`
   （远端 `~/.dsh/desktop-web.state.json`）按 `{pid, port, version}` 回收；版本一致且仍响应
   `__DSH_BOOT__` 标记时复用。
6. 服务重启后如果 URL 端口变化，`onSessionStatus` 会让已打开窗口原地 reload，不抢焦点。

### 4.2 典型场景

| 场景 | 结果 |
|---|---|
| 本地开发版与已安装版都在运行 | web 服务均由 OS 分配端口；转发端口仍自动顺延。 |
| 两个 SSH 窗口同时连不同主机，均配置 3080 本地转发 | 两个本地转发端口由 reservation 串行分配，不会同时选同一个回退口。 |
| 两个窗口连同一 SSH 主机 | 远端服务由 OS 分配端口；clone/build 由远端锁串行化。 |
| 两个壳实例同时 clone/build | 本地 `mkdir` 锁或远端 owner+stale 锁保证串行。 |
| 隧道超时 | 先杀掉本次超时子进程，再进入错误/重试路径。 |

## 5. 连接生命周期

- `connect()` 重置本地引用、杀旧子进程、释放旧预留，然后 `connectLocal/connectSsh`。
- 失败触发 `connect-failed`，main 最多自动重试 2 次（10s/20s）；session 被 stop 后定时器作废。
- ready 后执行一次性启动自动检查（按设备开关）。
- 构建/更新按设备互斥：同一终端的第二次构建/更新、重连、重置后端、保存连接设置被 `isSessionBusy(session)` 拦截；不同终端的构建互不干扰。
- **无感自动重连**：harness 因外部因素重启（插件安装、进程内重载、外部托管换端口、远端崩溃）时，壳自动恢复不打断用户——
  自管本地服务退出由 `spawnLocalService` 的 close watcher 转 `restarting` 后重启并发布新端口 `ready`；其余场景由健康看门狗（`startHealthMonitor`/`healthTick`）在 `ready` 态每 4s 探测、连续 2 次失败自动 `connect()`。见 `architecture.md`「无感自动重连」。

### 5.1 远端 shell 与 node 解析（易踩的坑）

远端命令都经 `remoteLoginShell()` 取到的 shell 包一层登录 shell 执行。这里曾有一个
致命组合，现已修复，但改动前它同时踩了两个坑：

1. **壳曾按 `zsh → bash → sh` 取第一个存在者**，而不读 `getent passwd` 里用户真实的
   登录 shell（也就是 `sshd` 实际使用的那个）。装了 zsh 的 bash 机器因此一律走 zsh。
2. **zsh 不读 `~/.bashrc`。** `zsh -l -c` 只读 `~/.zshenv`/`.zprofile`/`.zlogin`，
   而 `~/.bashrc` 恰恰是 PATH 配置通常所在。于是远端 `node` 解析到
   `/usr/local/bin/node`，而不是 `.dsh-tools` 里的便携版。

为什么这会致命：dsh CLI 的入口是 `if (import.meta.main) await runCli()`，而
`import.meta.main` 直到 **Node 22.18 / 24.2** 才存在。在更老的 node 上它是
`undefined`，整个 CLI **什么都不做、`rc=0`、零输出** —— 看起来就是"一闪而过"。
外层还有一道：harness 的 node 引擎下限是 `^22.19 || >=24`（`tools.js#engineOk`），
低于它的 node 本来就不是合法运行时。

**现行机制**：`remoteLoginShell()` 用一条 `REMOTE_LOGIN_SHELL_PROBE` 命令解析**用户真实
的登录 shell**（`getent passwd` → `$SHELL` → 已知 POSIX shell 依次兜底），并且只接受
能用 `-l -c` 驱动的 shell（`bash|zsh|sh|dash|ksh|…`）；`/usr/sbin/nologin`、`/bin/false`
这类会被跳过。解析失败一律回落 `/bin/sh`，绝不在未确认的 shell 上"猜"。纯函数
`parseRemoteLoginShell()` 让这套接受规则可离线测试。

这样 bash 登录的机器就走 `/bin/bash`，与 `ssh` 直连行为一致，`~/.bashrc` 里的
PATH（含便携 node）自然生效。

**远端要求**：登录 shell 下的 `node` 应解析到 `^22.19 || >=24`（实测
`~/.dsh-tools/node/bin/node`）。壳启动服务时会显式注入 `remoteToolchainPrefix()`
（把 `.dsh-tools/node/bin` 前置），所以那条路径本来就安全；脆弱的是**任何不带该前缀**
的裸 `node` 调用。若某台机器的登录 shell 属于 zsh 且 PATH 只写在 `~/.bashrc`，可在远端
补一份幂等的 `~/.zshenv`（下列写法用 `case` 守卫，嵌套登录不会重复叠加 PATH）：

```sh
# 远端 ~/.zshenv —— 让 zsh 登录/非登录 shell 都看到便携 node
case ":$PATH:" in
  *":$HOME/.dsh-tools/node/bin:"*) ;;
  *) export PATH="$HOME/.dsh-tools/node/bin:$HOME/.dsh-tools/node_modules/.bin:$HOME/.npm-global/bin:$PATH" ;;
esac
```

## 6. 更新管理

### 6.1 组件模型

`update.components` 按设备保存在 settings 中，Harness 行内置且永远存在。用户行仅两种：

- `npm`：`installSpec` 是 `dsh plugin --profile <profile> add <spec>` 的 spec。
- `git-preset`：`repoUrl/checkoutDir/sourceDir/presetId`。

未知 kind 会在归一化时丢弃，因此 settings.json 永远不能把壳变成任意命令执行器。

### 6.2 Harness 官方产物运行时

- `npm install --prefix <dshHome>/runtime/<npm:version> @deepseek-ai/dsh@<latest>`，
  校验后原子切换 `current` symlink；
- `runtime/manifest.json` 保存 `current` 与 `previous`，最多保留当前 + 上一版本；
- 新 runtime 启动失败：自动切回 `previous` 并重启旧版本；
- 更新菜单「回滚 Harness…」调用同一套 runtime-store 回滚并重置/重连后端；
- 远端同构：`~/.dsh/runtime/<version>` + `~/.dsh/runtime/current`。

### 6.3 npm 插件 spec

支持 pnpm `add` 全语法：

```text
dsh-example
@scope/pkg@^1.2.3
npm:alias@1
github:owner/repo
git+https://github.com/owner/repo.git#main
file:./hello-plugin
link:../hello-plugin
./hello-plugin.tgz
https://example.com/hello-plugin.tgz
```

更新行为：

- 裸 npm 包：先查 `<registry>/<pkg>/latest`，再执行 `add pkg@<version>`，规避 pnpm 11
  对已写死精确版本不更新的行为。
- 带 tag/range/alias：按原 spec 执行，同时仍从 registry 读取 latest 用于展示。
- git/path/tarball：不查 registry，`updateAvailable=true` 表示“重新执行安装源”。

`registryUrl` 通过 `npm_config_registry` 传给实际 pnpm 安装，版本检查也使用同一 registry。
npm 插件与 Git 预设的实际安装通过 `withComponentLock` 串行化（本地/远端锁），
避免第二个壳实例同时写同一 profile 或预设目录。

### 6.4 更新通道与生命周期（Phase 1–3）

更新按以下顺序决策（本地 + 官方仓库 URL 时）：

1. **仅官方产物**（Phase 2）：`artifact.js` 先做 registry 预检——最新版本 +
   依赖链完整性（`@deepseek-ai/dsh-frontend` 曾 404，链断时更新失败并给出明确
   原因，不再回退源码构建）。`npm install --prefix` 装进 `runtime/<version>`
   （npm 布局 `node_modules/@deepseek-ai/dsh/lib/bin.js`），校验后原子切换
   `current`。
2. **detached worker 执行**（Phase 3）：菜单「更新并重启」与初始化在本地产物
   可用时改由 `src/update-worker.js` 独立进程执行（`runner.spawnDetached`，
   不注册进进程登记表——壳退出不会杀它）。壳轮询 `runtime/update-status.json`
   把阶段/日志推给 UI；`done` 后由壳重启服务（或下次连接按版本不匹配自动重启）。
3. **意图可恢复**（Phase 1）：开始更新前写 `update-pending.json`，正常结束才清除；
   启动时 `resumePendingUpdate()` 检测残留——worker 还在跑则接管观察，已完成则
   提示，被打断则询问「继续/放弃」后重跑。

两种运行时布局由 `src/runtime-layout.js` 统一解析（`runtimeLayout`/`runtimeBin`/
`runtimeIsBuilt`/`npmArtifactVersion`），任何 bin 查找不得再假设仓库布局。
更新管理面板内的 Harness 行更新走壳内管线（实时日志），菜单/初始化走 worker，
两者共享同一 artifact 安装原语。

### 6.5 始终跟踪最新发布（无通道选择）

壳**没有**用户可选的更新通道，也不持久化任何通道偏好。每次检查都在 registry
声明的**所有** dist-tag 里取 semver 最高的那个版本：

- `artifact.js` 的 `resolveChannelVersion(tags)` 是纯函数（冒烟可测）：遍历
  `TRACKED_DIST_TAGS`（`latest`、`next`、`alpha`、`beta`、`rc`），取最高版本。
  未跟踪的 tag（`canary`、`dev`…）一律忽略。这正是「检测不到 alpha 版本」的
  修复所在——官方包把 `0.1.2-alpha.3` 发在 `alpha` 上，而只读 `latest` 的壳
  会一直停在 `0.1.1-rc.2`。
- 因此预发布版**默认可见**：谁的版本高就装谁，不论它发在哪个 tag 上。
- 通道只是**结果**而非输入：胜出的 tag 记在 `channel` 字段上，仅用于展示
  （日志一行 note、Harness 行的 badge、菜单/托盘的「…（alpha）」后缀）。
- 一个 tracked tag 都没有时才是唯一的硬性失败。

由于预发布版会默认装上，**插件兼容性由用户负责**：插件装在 `<dshHome>/profiles/`
下（跨 runtime 版本共享），而宿主 API 在 `runtime/<version>` 里（按版本隔离）。
一次破坏性 API 变更会让旧插件在 import 阶段失败（典型报错 `does not provide an
export named ...`），导致新产物启动失败并自动回滚。处理方式是卸载/升级不兼容的
插件，而不是回退 runtime。

## 7. 平台外壳约定

### 7.1 macOS / Windows / Linux 的挂载差异

> Linux 在 `main.js` 里走的是与 Windows 相同的 `hidden` + `titleBarOverlay`
> 分支（`platformName()` 返回 `'linux'`），但 **`shell.css` 的留白规则目前只
> 写了 `:root[data-platform="windows"]`**：Linux 实际仍套用 macOS 的左侧 84px
> 留白，右侧也没有为原生控件条让位。改窗口外壳时三处要一起看：`platformName()`、
> `shell.css` 的 `:root[data-platform=…]` 规则、`titleBarOverlay.height`。

| 能力 | macOS | Windows / Linux |
|---|---|---|
| 标题栏 | `titleBarStyle:'hiddenInset'` + `trafficLightPosition`（左侧） | `titleBarStyle:'hidden'` + `titleBarOverlay`（右侧，高度 = 46px） |
| 壳边框留白 | `padding-left: 84px` | `padding-right: 152px`（`:root[data-platform="windows"]`） |
| 应用菜单 | `Menu.setApplicationMenu(...)`（即菜单栏） | 装为窗口菜单但 `setMenuBarVisibility(false)`，保留加速键 |
| Dock/任务栏 | Dock 右键菜单 + 图标按压反馈 | 无 Dock；入口靠托盘菜单 |
| 托盘图标 | `trayTemplate.png`（模板图，自动着色） | `icon.png` 缩到 16px（彩色，深色任务栏可见） |
| 平台信息下发 | 渲染进程读 `location.search` 的 `platform` 参数（`shell-preload` 暴露 `api.platform`） | 同左 |

`platform` 参数由主进程在 `loadFile(SHELL_HTML, { query })` 与
`SetupDialog.loadQuery()` 里注入，落到 `<html data-platform>`，所以留白规则全在 CSS。

### 7.2 macOS 视觉约定

- 主窗口：`titleBarStyle: 'hiddenInset'`、`trafficLightPosition: {x:18,y:15}`，
  壳边框 46px，左侧 84px 避让红黄绿按钮。
- 字体：
  `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", "PingFang SC", …`
  等宽：`ui-monospace, "SF Mono", SFMono-Regular, Menlo`。
- 颜色：深色 `#1e1e1e/#282828/#f5f5f7` 与 accent `#0a84ff`；浅色
  `#f2f2f7/#ffffff/#1d1d1f` 与 accent `#007aff`；通过 CSS 变量切换。
- 控件：输入框 24px、普通按钮 22px、小按钮 18px、圆角 5–10px、焦点环
  `0 0 0 3px accent-soft`。
- 日志：更新管理 tab 的日志在最后，`.updates-log` 固定 176px，初始回填最近日志并
  `scrollTop = scrollHeight`。
- 设置页栅格：左侧 208px 定位菜单是贴窗边缘的实体面板；正文列 940px **左对齐**，
  与标题栏/页脚共用同一条左边缘。不要把外层限宽后整体居中——那会让分隔线在窗口
  中间断掉、两侧留大片空白（曾表现为「中间一条窄窄的」）。
- 主题卡片是 flex column：`<button>` 默认按内容定高，描述换行会让同排卡片高低不齐。
- 滚动定位：`goToSection` 期间锁住 scroll-spy（`scrollend` + 定时兜底），滚到底时
  高亮取探针线之上最后一个分区而非无条件取最后一节。
- 动效遵循 `prefers-reduced-motion`。不需要在线字体/图标。

## 8. 测试

```sh
node scripts/smoke.js                    # 纯 Node 模块（设置/ssh/runner/组件/端口）
DSH_DESKTOP_SMOKE=1 npx electron .       # Electron 冒烟（菜单/Dock/actions）
```

新增逻辑时建议至少覆盖：

- `normalizeSettings` / `normalizeUserComponent` / npm spec 解析。
- `findFreePort` + reservation 的跳端口行为。
- `parseDshWebUrl` + 实际启动 `dsh web --port 0` 并回读端口。
- `runtimeStore` local state round-trip、本地锁、local/remote runtime 激活与回滚。
- `WindowManager` 保存/恢复 last-active device 与 bounds。
- ssh quoting、remotePath、tunnelArgs。
- UpdateManager 非网络快照与 preset checkout 路径。
- **平台原语**（`src/platform.js`）：可执行文件命名、home 展开、node 分发归档形状
  （tar.gz/zip、arm64/x64/x86）、`current` 指针原子切换且不留临时目录、npm 定位、
  ssh 配置路径、干净子进程 PATH、`killTree` 对无效 pid 幂等。
- **Windows 进程发现**（`src/process-scan.js`）：`netstat -ano` 行解析（只认 loopback/
  通配 + LISTENING）、CIM 进程行解析、PowerShell 引号转义。

> 依赖进程枚举（`ps` / `lsof` / `netstat`）的断言在宿主拒绝枚举时会**显式跳过**并打印
> 一行提示（`enumerationWorks`）。这是环境限制，不是缺陷——不要把它改回硬失败。

## 9. 打包与发布

- 产物命名遵循 GitHub Release 约定 `<name>-<version>-<os>-<arch>.<ext>`
  （`package.json#build.artifactName`，小写连字符、无空格、含版本与架构）：
  - macOS：`dsh-mac-desktop-<ver>-macos-{arm64,x64}.{dmg,zip}` —— **保持不变**，
    避免既有下载链接与 `latest-mac.yml` 失效。
  - Windows：`dsh-desktop-<ver>-windows-{x64,arm64}-setup.exe`（NSIS）、
    `…-portable.exe`、`…-windows-{x64,arm64}.zip`。
  - Linux：`dsh-desktop-<ver>-linux-{x86_64,arm64}.AppImage`、
    `…-linux-{amd64,arm64}.deb`。**架构名按格式不同**（AppImage 用 `x86_64`，deb 用
    `amd64`），由 `build.appImage` / `build.deb` 各自的 `artifactName` 决定；
    `build.linux.executableName` 固定为 `deepseek-harness`（unpacked 目录里的
    二进制名，CI 靠它做断言）。
- 版本号唯一来源是 `package.json#version`（semver）；打包时请先 `npm version`
  或手工提升版本，再打 `v<version>` 标签推送，GitHub Actions 自动构建并发布。
- 本地打包：
  - macOS：`npm run dist`（app 目录，供 install.sh 安装）、`npm run dist:dmg`（DMG + ZIP）。
  - Windows：`powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1`（一键双架构），
    或 `npm run dist:win` / `dist:win:x64` / `dist:win:arm64`。
  - 直接发布到 GitHub Releases：`GH_TOKEN=<token> npm run dist:publish` / `dist:publish:win`。
- Windows 图标不需要单独维护 `.ico`：electron-builder 会把 `build/icon.png`（512px）
  转成多分辨率的 `.ico`。
- 自动发布流水线见 `.github/workflows/release.yml`：tag `v*` → 六条并行构建
  （macOS arm64/x64、Windows x64/arm64、Linux x64/arm64）→ 上传各平台产物 →
  创建 GitHub Release。Linux 用**原生架构 runner**（`ubuntu-24.04` /
  `ubuntu-24.04-arm`）：deb 走 fpm，arm64 需要 aarch64 打包工具链，x64 runner 上
  交叉不出。
- CI（`.github/workflows/ci.yml`）在 `macos-14`、`windows-latest`、`ubuntu-24.04`
  上分别跑冒烟，并在三个平台各做一次打包预检。Linux 会额外断言 AppImage/deb 的
  真实文件名——架构名写错能让产物「构建成功但名字错误」，只有断言拦得住。
- **一键发布**：`node scripts/release.js`——分析自上次 tag 以来的提交
  （conventional commits：breaking→major / feat→minor / fix→patch / 仅文档→不发），
  检查当前版本是否已发布（远端 tag 是否存在：已发布→bump 新版本；未发布→直接
  发当前版本），确认后自动 `npm version` + push main + push tag 触发流水线。
  选项：`--dry-run` 只分析；`--yes` 跳过确认；`--bump <type>` 强制版本类型。
- 未签名/未公证（`identity: null`），发布为正式 Release 即可，首次启动由 macOS
  Gatekeeper / Windows SmartScreen 要求确认。

## 10. 新版本发布约定：驻留程序自动升级验证

开发新版本（harness 更新）后、发布前，必须验证「访问本地/远端 → 驻留程序
自动升级」闭环。这是本产品的核心契约：**驻留程序（dsh web 服务）永远可以被
新的访问自动接管到当前版本**，用户无感、零手工步骤。

### 两层升级语义（先理解，再验证）

1. **连接时自动升级（reap → launch）**：连接时对比 state 记录的 version 与当前
   serviceVersion。不匹配 → 自动清理旧驻留程序（kill 记录 pid / lsof 兜底）→ 以
   当前版本重新启动。版本身份即官方产物的包版本（npm 布局），统一经
   `versionToken` 归一。
2. **获取新版本（更新管线）**：registry 预检 → 下载官方产物 → 原子切换 current →
   重启。连接只负责「升级到 current」，不负责「获取新版本」。

### 验证步骤（每次新版本必做）

1. `node scripts/smoke.js` + `DSH_DESKTOP_SMOKE=1 npx electron .` 全绿；
   改了平台相关代码时，**Windows 上也要各跑一次**。
2. 手工冒烟（推荐）：旧版本壳保持连接 → 另一实例触发升级 → 确认旧壳窗口不会
   把版本拉回旧值（多实例防回退：closeWatcher 重启前重解析 serviceVersion）。
3. 回滚验证：新版本启动失败 → 自动回滚 previous 并恢复旧服务。

### 检查点速查

- 本地：日志出现「清理旧版/残留服务」；`<dshHome>/desktop-web.state.json` 的
  version == 新 token（npm:<ver>）。
- 远端：`~/.dsh/desktop-web.state.json` version 更新；`desktop-web.log` 有新版本
  启动记录；隧道重建后页面就绪（`__DSH_BOOT__` 探测通过）。
- 多实例：两个壳同时连接时，最终 state 必须指向新版本（无旧版本回退）。
- 远端服务被杀（崩溃/远端重启）后重连：自动 relaunch，不出现 90s 死端口等待。

## 11. 提交约定

按功能拆 commit，建议前缀：

- `feat:` 新功能
- `fix:` 边界修复
- `style:` UI/设计系统
- `docs:` 文档
- `test:` smoke 与验收

本次任务对应的提交边界：

1. 开发态 runtime 隔离 + 端口预留。
2. 多窗口并发/重连/退出防护。
3. 更新管理日志位置与固定高度。
4. macOS 壳边框样式。
5. npm 插件安装 spec 兼容。
6. 需求/开发/agent 文档。

## 11.1 三端一致性

macOS / Windows / Linux 共用 `src/`，Android 在 `android/`；两者共享**远端协议**但零
代码共享。哪些行为必须一致、哪些地方有意不同，见
[android-parity.md](android-parity.md)。改远端协议相关代码时按那份清单两端都过一遍。

## 12. Android 客户端开发（`android/`）

### 12.1 环境与构建

```sh
cd android
GRADLE_USER_HOME=$PWD/.gradle-home ./gradlew :app:assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

需要 JDK 17 + Android SDK（`platforms;android-35`、`build-tools;35.0.0`）。
沙箱/CI 中若 `~/.gradle`、`~/.android` 不可写，用仓库内的 `GRADLE_USER_HOME`；
debug 签名用仓库内 `android/.keystore/`（已 gitignore），不依赖 `~/.android/debug.keystore`。

### 12.2 端到端验证（无需真机）

`.e2e/` 下自带一套可复现的 e2e：

- `.e2e/mina/E2eSshd.java`：Apache MINA SSHD 起的**真实 SSH 服务**（公钥认证、
  exec 通道跑真实 shell、`direct-tcpip` 端口转发），替代无法在沙箱里启动的系统 sshd。
- `.e2e/remote-home/.dsh/`：远端 dsh home 夹具（`runtime/current` + `manifest.json`），
  让 adopt/launch 逻辑面对真实的运行时布局与真实的 `dsh web` 进程。
- `.e2e/id_rsa_e2e`：测试专用密钥（gitignore）。

流程：启动 MINA → `adb install` → 往 `files/devices.json` 与 `files/keys/` 落夹具
→ 点终端 → 观察应用内日志与真实 Harness 页面。

> 模拟器注意：软件 GPU 下 harness 首屏需要 1~3 分钟；多台模拟器并行会让主机负载
> 冲到 9 并触发系统 ANR 弹窗——那是模拟器性能问题，不是应用缺陷。

### 12.3 改哪里

- **连接行为** → `connection/ConnectionManager.kt`（唯一状态机）+ `ssh/RemoteService.kt`
  （远端命令）。改远端命令前先对照 `docs/android-remote-protocol.md` 与桌面壳实现，
  两边必须保持一致，否则会互相杀服务。
- **新增远端命令** → 必须走 `RemoteShell.run()`（自带 sentinel 包裹与登录 shell），
  不要自己起 exec；命令体内**不能出现单引号**（外层已单引号包裹）。
- **UI 布局分支** → `ui/FormFactor.kt`。不要在 Composable 里直接读
  `Configuration.screenWidthDp` 做双栏判定——分屏平板的窗口是手机宽。
- **新的兼容 API** → `ui/WebViewCompatScript.kt`，并在 `android/README.md` 的兼容表
  登记「引入版本 + 为什么需要」。
- **持久化** → 设备/密钥在 `data/DeviceStore.kt`（JSON 文档），纯账号级偏好才进
  `SettingsStore`（DataStore）。

### 12.4 已验证的组合

| 形态 | 设备 | 结果 |
|---|---|---|
| 手机竖屏 | Pixel 7 / API 33 / WebView 103 | SSH 连接、复用远端服务、隧道、WebView 加载真实 Harness |
| 平板横屏 | 10.1" / API 34 / 2560×1600（模拟器） | 双栏布局 + 右侧真实 Harness UI |
| **真机横屏** | **小米平板 23073RPBFC / Android 15 / 1920×1200 / WebView 131** | **双栏 + 真实 Harness；SSH 认证、启动远端服务（state 落盘）、JSch 隧道、日志页** |
| **真机竖屏** | 同上（旋转） | 自动切单栏，页面与滚动位置不丢 |
| **断线自愈** | 同上 | `kill -9` 远端服务后，看门狗自动清理并重启，state 换新 pid/端口/令牌，页面恢复 |
| **真机连真实 Linux** | ubuntu22 `sven@192.168.31.5:22`（22.04 / 运行时 `npm0.1.1-rc.2`） | 复用运行中的服务（端口 44001），未重启、未中断会话 |
| **真机连真实 Linux** | ubuntu26 `sven@192.168.31.151:22`（26.04 / 运行时 `npm0.2.1-rc.2`） | 复用运行中的服务（端口 33535） |

真机暴露并修复的两个缺陷（模拟器上不可见或未触发）：

1. **壳面板文字黑底黑字**：`HarnessPane` 的 `ShellPanel` 用 `background()` 修饰符而不是
   `Surface`，只上底色不设内容色，深色主题下所有未显式指定颜色的 `Text` 都是黑色。
   手机截图里恰好没截到那个面板，平板上「选择一个终端」直接看不见。
2. **双栏下日志不可达**：点「日志」后右侧只渲染一句「日志在左侧导航中查看」，
   但左栏只有开关、没有日志本体 —— 平板上日志等于打不开。现在右侧直接渲染 `LogScreen`。

**旧运行时没有启动令牌**：ubuntu22 的 `state` 文件只有 `{pid,port,version}`，没有 `url` —
`0.1.1-rc.2` 早于令牌机制。客户端按「有 url 才重宿、无 url 退回裸回环」处理，
实测页面正常打开，不需要为兼容旧版本做额外分支。

另有 URL 直连模式的诊断改进：`dsh web` 默认只监听 127.0.0.1，直连局域网地址会得到
「连接超时」，原提示只说「检查网络」。现在区分「有响应但不是 dsh」与「端口无响应」，
后者直接指出 `--host 0.0.0.0` 与 SSH 隧道两条出路。
