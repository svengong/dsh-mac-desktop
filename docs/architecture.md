# 架构与技术细节

本文档承载桌面壳的技术内容：目录布局、模块职责、端口与进程策略、工具链、数据隔离、更新架构、打包发布。产品介绍与快速开始见 [README](../README.md)。

## 1. 设计契约（升级不改壳）

壳只依赖三个稳定产品面：

1. 固定 URL `http://127.0.0.1:<端口>`（Web 应用的服务契约），
2. 运行时入口 `…/lib/bin.js web --port <n>`（官方 npm 产物或仓库布局，见 `runtime-layout.js`），
3. 官方 npm 产物渠道（`@deepseek-ai/dsh`）+ 免密 ssh。

前端产物、插件组合、预设如何变化都不影响壳。壳自身没有运行时自动更新；壳发版走 `scripts/release.js` + GitHub Actions 发布流程（tag `v*` → macOS arm64/x64 与 Windows arm64/x64 构建 → Release）。

## 1.1 平台抽象（`platform.js` / `process-scan.js`）

同一份源码跑 macOS / Windows / Linux，三个平台是**同等的一方支持目标**。业务模块里
**不允许**出现 `process.platform` 分支或 `/bin/...` 硬编码——所有平台差异只在这两个模块里：

| 能力 | POSIX | Windows |
|---|---|---|
| 结束进程 | `kill(-pgid)` 结束整个进程组 | `taskkill /T /F` 递归结束进程树 |
| 父进程监护 | 原 `sh` 包装脚本 | `src/service-guard.js`（node，两平台共用） |
| `current` 指针 | 相对符号链接 + rename | 目录联接（junction），无需提权 |
| 便携 node | `.tar.gz` + `--strip-components=1` | `.zip` + 平铺 `node.exe` |
| 端口→pid | `lsof -iTCP -sTCP:LISTEN` | `netstat -ano -p TCP` 的 LISTENING 行 |
| 进程列表 | `ps ax -o pid=,command=`，被拒时回退 `pgrep -fl` | `Get-CimInstance Win32_Process` |
| home 占用判定 | `lsof -Fn -p`（打开的文件） | `Get-CimInstance` 的 CommandLine 路径前缀（读不到则不杀） |
| 可执行文件 | `node` | `node.exe` / `pnpm.cmd`（垫片经 shell 执行） |
| PATH 键 | `PATH`（`:` 分隔） | `Path`（`;` 分隔，且与 `PATH` 保持同值） |
| 登录 shell 探测 | `zsh -l -c 'command -v …'` | PowerShell `Get-Command` |
| ssh 配置 | `~/.ssh/config` | `%USERPROFILE%\.ssh\config` |

**进程组 vs 进程树**是这里最容易出错的一点：POSIX 下 `spawn(detached:true)` 让子进程
成为新进程组的组长，所以 `kill(-pid)` 能一次带走 pnpm/git 的孙进程；Windows 没有这个
概念，只能靠 `taskkill /T` 遍历子进程。`killTree()` 把两者统一成一个调用。

**Linux 与 macOS 同属 POSIX 分支**，`platform.js` 里没有第三套实现：`IS_LINUX` 只
用于 `platformName()` 与 node 分发归档的默认值。因此 Linux 的行为完全由 POSIX 一列
决定——唯一的例外在**窗口外壳**：`main.js` 对 Linux 走 Windows 的 `hidden` +
`titleBarOverlay` 分支，而 `shell.css` 的留白规则只写了 `[data-platform="windows"]`，
所以 Linux 实际套用 macOS 的左侧 84px 留白、右侧未避让原生控件条（已知缺口）。

## 2. 目录与模块

```
desktop-shell/
├── deepseek-harness/    本地 harness 检出（独立 clone，默认 repoDir，gitignored）
├── src/
│   ├── main.js            main process: lifecycle, workspace frame wiring, IPC handlers
│   ├── settings.js        settings store (userData/settings.json)
│   ├── window-manager.js  window bounds/active-view/last-active persistence
│   ├── runtime-store.js   local/remote service state, URL/port parsing, clone/build locks
│   ├── runtime-layout.js  repo/npm 两种运行时布局解析（bin 查找唯一入口）
│   ├── artifact.js        官方 npm 产物渠道：registry 预检/安装/校验
│   ├── update-worker.js   独立更新执行器（壳退出后继续完成安装）
│   ├── ports.js           SSH local-forward port reservation + TCP probe
│   ├── labels.js          shared DSH-[终端] labels for titles/menus/tray
│   ├── shell-preload.js   preload for the local workspace frame
│   ├── dialog-preload.js  preload for the embedded settings panel
│   ├── external-open.js   URL classification for harness navigation (main/sub frame)
│   ├── menu.js            application menu
│   ├── tray.js            menu-bar tray (status + terminal actions)
│   ├── windows.js         window presentation helpers
│   ├── device-merge.js    merges one device's settings/update state
│   ├── dialogs.js         embedded settings panel
│   ├── components.js      update-component catalog + version/hash helpers
│   ├── update-manager.js  unified check/update logic for all components
│   ├── connection.js      local + ssh connection lifecycle, port-0 service, tunnel, remote service
│   ├── update.js          harness check / update-and-restart pipeline, .dsh-tools pnpm bootstrap
│   ├── runner.js          foreground command runner + detached service spawner + 进程登记表
│   ├── service-guard.js   驻留服务的跨平台父进程监护（node 实现，取代 sh 包装脚本）
│   ├── platform.js        **唯一**平台差异层：killTree/taskkill、可执行名、PATH、node 归档、current 指针、ssh 路径
│   ├── process-scan.js    **唯一**进程/端口发现层：lsof+ps（POSIX）/ netstat+CIM（Windows）
│   ├── ssh.js             ssh target parsing, quoting, remote-path rendering
│   ├── tools.js           engine-aware node/pnpm discovery + clean child environment
│   └── ui/                shell.html (workspace frame + loading panel), settings.html, shell.css
│
├── build/                 icon.icns, icon.png, iconPressed.png, tray template icons (committed)
└── scripts/               gen-icons.sh, build.sh, install.sh, build-win.ps1, smoke.js, release.js
```

本目录独立于 harness 仓库，保留自己的 npm install，产品依赖图不受影响。

## 3. 数据流与多窗口模型

```text
BrowserWindow (shell.html 边框)
 ├─ harness WebContentsView        ← http://127.0.0.1:<实际端口>
 └─ settings WebContentsView       ← dialog:* / updates:* IPC
        │
        └─ main.js: workspace ── session ── ConnectionManager
                                            ├─ local service (node bin.js web --port 0)
                                            ├─ ssh tunnel (ssh -N -L)
                                            └─ UpdateManager / Updater
```

- `workspaces`：`Map<id, workspace>`，一个 BrowserWindow 一个 workspace。窗口可以是未绑定（detached，不持有 session）或已绑定某终端。
- `sessions`：`Map<deviceKey, session>`，`deviceKey` 为 `local`、`ssh:<host>` 或归一后的 `machine:<id>`。
- 同设备窗口共享 session；窗口关闭只是隐藏，workspace 持续存活，显式退出时才销毁。
- 启动/恢复的第一个窗口绑定上次活跃设备并自动连接；显式新建窗口为 detached，默认连接页。每个终端最多一个已绑定窗口；保存已打开终端时仅聚焦已有窗口，当前窗口保持不变。
- 任务进度横幅存在 session 上（`session.progress`），同终端所有已绑定窗口共享；`sessionTask` 给壳工具栏提供检查/更新/构建/重启状态。切离窗口时通过 runner owner 取消该终端任务，释放锁后再停 session。
- 窗口切换设备调用 `attachWorkspace`；`local` session 常驻以支持多开。
- **焦点归属**：`WebContentsView.webContents.focus()` 会激活其宿主窗口（实测 Electron 35），
  因此所有视图聚焦都经 `windows.js#focusViewInKeyWindow`——只有已经是 key window 的窗口
  才真正聚焦视图。否则同终端会话级广播（`onSessionStatus`/`setProgress`/
  `observeUpdateWorker`/`reloadSessionWindows`）会让后台窗口抢焦点；双屏下表现为
  窗口与顶部菜单在两块屏幕间来回闪。

### 3.1 harness 视图的导航护栏（`external-open.js` + `main.js`）

壳只在 harness 视图内渲染**一个**页面：服务根 `http://127.0.0.1:<port>/`。导航护栏分主/子框架两套规则（`installHarnessNavigationGuard`）：

- **主框架**（`will-navigate`，用 `isExternalUrl`）：只保留根路径（harness 是 hash 路由，真实应用路由的 `pathname` 恒为 `/`）；其他 loopback 路径、`https:`、`file:` 一律交系统默认浏览器。点 workspace `.html` 就是走这条——服务对这些路径回 404 空页，若不拦会得到一张无法自愈的空白 harness 视图。
- **子框架**（`will-frame-navigate`，用 `isExternalSubFrameUrl`）：子框架属于嵌入它的插件（如 sidebar 文件预览），壳只驱逐真正跨源内容（非 loopback、`file:`），其余让插件自行路由。把主框架规则套到子框架上会劫持插件 UI——预览点击被顶到系统浏览器。

两个关键状态机细节（实测于 Electron 35）：

- 被 `preventDefault()` 的导航不会发出 `did-finish-load`，所以 `harnessReady` 不会自动恢复；`will-navigate` 里必须调 `restoreHarnessAfterBlockedNav()` 从快照恢复。
- `did-start-loading` 对**任意框架**都触发，包括 iframe；只有主框架的 `did-start-navigation`（`isMainFrame`）才代表 harness 文档被替换。在 `did-start-loading` 里清 `harnessReady`，会让任何插件 iframe 加载把 harness 永久打成加载态。

### 3.2 设置面板（`settings.html` + `shell.css`）

- 左侧 208px 定位菜单（更新/连接/外观/日志，全部平铺不折叠），随滚动高亮；菜单是贴窗边缘的实体面板（glass 背景 + 右边框 + 底部终端标识），不再是浮在空白里的裸列表。
- 正文列 940px 且**左对齐**（不居中）：标题栏、正文、页脚共用同一条左边缘，整页读作一个整体。曾经把外层限宽 940px 再整体居中、正文再限 660px，导致标题栏/页脚的分隔线在窗口中间断掉、两侧大片空白，视觉上像一条悬在中间的窄条。
- 分区定位：滚动动画结束前锁住 scroll-spy（`scrollend` + 定时兜底），否则长距离跳转途中高亮会从目标分区跳到下一分区。滚到底时高亮取「顶部探针线之上最后一个分区」，而不是无条件取最后一节——页面滚到底不等于已看到最后一节。
- 入口焦点：只有「连接」语义的入口（终端启动器／⌘,／终端徽标／失败页「连接设置」）锚定「连接」；顶栏「设置」等普通入口锚点为 `null`，停在顶部。初始焦点在 boot 状态与 `updates.getState()` 两次渲染都完成后施加。
- 定位目标夹取到最大可滚动位置（底部不留垫层，滚到底就是日志本身）。

## 4. 端口与进程策略

1. 本地和远端 `dsh web` 统一使用 `--port 0`；CLI 打印 `dsh web: http://127.0.0.1:<port>`，壳解析后写 state，窗口跟随实际端口。
2. SSH 本地转发不能由 ssh 汇报端口，使用**优先端口 + 顺延 30**：`localPort` 空闲则用，否则 `ports.js` 探测下一个空闲端口；探测→绑定窗口用 `reservePort/releasePort` 括起来。
3. 所有子进程 spawn 都经 `runner.js`：`runCommand`（有界前台命令，`detached: true` 独立进程组，超时组杀 SIGKILL）、`spawnService`（长驻服务，组 SIGTERM 停止）、`spawnDetached`（更新 worker，不注册登记表，壳退出不杀）。
4. **进程登记表**：每个 spawn 自动登记，`before-quit` 调 `killActiveChildren()` 组杀全部——包括在途 git/pnpm 构建与插件安装。
5. 本地 clone、远端 clone、build pipeline 都通过 `runtime-store.js` 的原子目录锁；本地锁 owner 为 `{pid, host, createdAt}`，owner 进程消失即 stale；远端锁 owner JSON 超 2 小时视为 stale。
6. 旧版/残留自管服务通过 `<dshHome>/desktop-web.state.json`（远端 `~/.dsh/desktop-web.state.json`）按 `{pid, port, version}` 回收；版本一致且仍响应 `__DSH_BOOT__` 时复用。

## 5. 连接生命周期与驻留程序自动升级

`connect()` 重置本地引用、杀旧子进程、释放旧预留，然后 `connectLocal/connectSsh`。失败触发 `connect-failed`，main 最多自动重试 2 次（10s/20s）。

**连接时自动升级（reap → launch）**：连接对比 state 记录的 version 与当前 `serviceVersion`。不匹配 → 自动清理旧驻留程序（kill 记录 pid / lsof 兜底）→ 以当前版本重新启动。版本身份即官方产物的包版本（npm 布局），统一经 `versionToken`。

**两层升级语义**：连接只负责「升级到 current」；「获取新版本」走更新管线（registry 预检 → 下载官方产物 → 原子切换 → 重启）。

**远端恢复**：state 匹配但服务已死（崩溃/远端重启）时，锁内探活（node fetch + `__DSH_BOOT__`）→ 自动 reap + relaunch，不会建隧道到死端口空等。

**无感自动重连（seamless reconnect）**：harness 可能因外部因素重启——插件安装触发进程退出或进程内重载、外部托管服务换端口、远端服务在隧道仍活时崩溃。壳用两层机制兜住，均不打断用户手动操作：

1. **close watcher 发布新端口**：自管本地服务退出时，`spawnLocalService` 的 close watcher 转 `restarting`（壳边框切加载面板）→ 按版本重解析后重启 → 成功后 `setStatus({state:'ready', url: this.url()})` 发布 OS 新分配端口，`onSessionStatus` 据此刷新窗口。此前重启后从不发布新 URL，窗口仍指向死端口，是「必须手动重连」的根因之一。
2. **健康看门狗**：`status.state === 'ready'` 期间每 `HEALTH_INTERVAL_MS`(4s) 探测一次服务 URL，连续 `HEALTH_FAILURE_THRESHOLD`(2) 次失败判定服务已不可用，自动 `connect()` 重连（走既有 reap→launch→ready 流程）。覆盖 close 事件观察不到的进程内重载、外部托管、远端崩溃场景。非 `ready` 态（connecting/restarting/error）看门狗退避，避免与 close watcher / 重连定时器抢跑。

## 6. 更新架构（产物优先 + 可恢复 + 生命周期解耦）

1. **仅官方产物**：`artifact.js` 先做 registry 预检（最新版本 + 依赖链完整性），`npm install --prefix` 装进 `runtime/<version>`（npm 布局），校验后原子切换 `current`。registry 链断则更新失败并给出明确原因，不再回退源码构建。
2. **detached worker 执行**：菜单「更新并重启」与初始化在本地产物可用时由 `update-worker.js` 独立进程执行（`spawnDetached`，壳退出不杀）。壳轮询 `runtime/update-status.json` 推送阶段/日志；`done` 后由壳重启服务（或下次连接按版本不匹配自动重启）。
3. **意图可恢复**：更新前写 `update-pending.json`，正常结束才清除；启动时 `resumePendingUpdate()` 检测残留——worker 还在跑则接管观察，已完成则提示，被打断则询问「继续/放弃」后重跑。
4. **版本化运行时与回滚**：官方产物安装在 `<dshHome>/runtime/<version>`（远端 `~/.dsh/runtime/<version>`），成功后原子切换 `current`；新版本启动失败自动回滚 `previous`，更新菜单可手动「回滚 Harness」。
5. **始终跟踪最新发布**：无用户可选通道。每次检查在 registry 声明的所有 dist-tag（`latest`/`next`/`alpha`/`beta`/`rc`）里取 semver 最高者，由 `resolveChannelVersion()` 纯函数解析；胜出的 tag 仅用于展示。版本比较保留预发布后缀（semver 优先级）。预发布版因此默认可见，插件兼容性由用户负责。详见 [development.md §6.5](./development.md)。

## 7. 数据与进程隔离

- 开发态（`app.isPackaged === false`）userData 固定为 `~/.dsh-dev`（不存在时自动创建），不触碰已安装应用的 `~/Library/Application Support/DeepSeek Harness`；`DSH_DESKTOP_USER_DATA` 可覆盖。
- 本地服务 `DSH_HOME` 默认 `~/.dsh-dev`（或设置里的 dshHome），与终端用户常用 `~/.dsh` 完全分离；首次使用时从 `~/.dsh` 播种 settings/凭据。
- 已安装应用与开发应用使用不同的单实例锁，允许同时运行。
- 本地子进程 `PATH = node 目录 + .dsh-tools + 仓库 node_modules/.bin + 系统基础目录`，与登录环境无关；远程在 `~/.dsh-tools` 做同样的自包含引导。

## 8. 打包与发布

- 产物命名遵循 GitHub Release 约定 `<name>-<version>-<os>-<arch>.<ext>`。版本号唯一来源 `package.json#version`。
  - macOS：`dsh-mac-desktop-<ver>-macos-<arch>.{dmg,zip}`（`build.artifactName`，**保持不变**以免既有下载链接失效）。
  - Windows：`dsh-desktop-<ver>-windows-<arch>.{zip,exe}`、`…-windows-<arch>-setup.exe`（NSIS）、`…-windows-<arch>-portable.exe`。
- 构建脚本：
  - `npm run dist`（app 目录）/ `npm run dist:dmg`（DMG+ZIP）/ `npm run dist:publish`（`GH_TOKEN=<token>` 直发 GitHub）。
  - `npm run dist:win`（NSIS+便携版，双架构）/ `dist:win:x64` / `dist:win:arm64` / `dist:publish:win`。
  - Windows 目标为 `nsis`、`portable`、`zip`，`arch` 均为 `["x64","arm64"]`（Windows on ARM 是一方支持目标）。
- 图标：`build/icon.png`（512px）会被 electron-builder 自动转成多分辨率 `.ico`，无需手工维护 ICO 文件；macOS 用 `build/icon.icns`。
- Linux：`dsh-desktop-<ver>-linux-<arch>.AppImage` / `.deb`，由 `electron-builder --linux` 在 Linux 主机上产出。**顶层 `artifactName` 是 macOS 命名**，Linux 构建必须显式传 `-c.linux.artifactName`，否则产物会带 `-macos-` 后缀；AppImage/deb 也不能交叉构建。
- 推送 `v*` 标签触发 `.github/workflows/release.yml`：校验标签与版本一致 → 四条并行构建（macOS arm64/x64、Windows x64/arm64，全部 `--publish never`）→ 上传各平台产物 → 创建 GitHub Release。**Linux 产物不在该流水线内**，需在 ubuntu/本地 Linux 上手工构建后上传。
- `.github/workflows/ci.yml` 在 `macos-14` 与 `windows-latest` 上分别跑 `npm run smoke`，并各自做一次打包预检——两条打包链路完全不同，只验一条会让另一条静默腐化。Linux 的烟雾测试在 ubuntu 上同样可跑，但尚未进入矩阵。
- 产物未签名/未公证（`identity: null`）。

## 9. 相关文档

- [需求文档](requirements.md)：功能需求、边缘场景、验收标准。
- [开发文档](development.md)：开发约定、测试、提交约定、新版本发布验证。
- [Agent 文档](agent.md)：后续编码 Agent 的不变量、速查与常见坑。

## 10. Android 客户端（`android/`）

> 目录、模块、构建与 e2e 说明见 [android/README.md](../android/README.md)；远端命令
> 依据见 [android-remote-protocol.md](android-remote-protocol.md)。

### 10.1 与桌面壳的关系

同一个远端 `dsh web` 服务的**两个客户端**。共享的只有协议（state 文件、启动令牌、
探活判据、启动命令），代码零共享：桌面壳是 Electron/Node，Android 是 Kotlin/JVM。

```text
桌面壳 (Electron)                     Android 客户端
  ssh -N -L 子进程                       JSch setPortForwardingL
  remoteRun(ssh …)                       RemoteShell(exec + sentinel)
  readRemoteState / launchRemoteService  RemoteService.adopt/launch
  probeOnce / tokenAccepted (node http)  HttpProbe (HttpURLConnection)
  WebContentsView                        WebView + document-start shim
  BrowserWindow 46px 壳边框               Compose: 单栏路由 / 双栏 rail
```

因此**两个客户端可以并存**：桌面端启动的服务，Android 端会直接复用（版本一致时）；
Android 端启动的服务，桌面端同样复用。

### 10.2 连接状态机

```text
Idle --connect()--> Connecting(step) --> Ready(url) --watchdog 连续 2 次失败--> 重连
                        |
                        +--异常--> Failed(message, hint)
```

- `epoch` 是连接代数：`connect()`/`disconnect()` 自增，所有异步回调（探活、
  看门狗、connectJob）先比对代数再动状态，防止陈旧回调把新连接打回 Failed。
- 连接工作整体跑在 `Dispatchers.IO`：主线程开 socket 会抛
  `NetworkOnMainThreadException`，而探活 try/catch 会把它吞成「超时」——
  实测表现为「SSH 已连接、端口已绑定，却报隧道建立超时」。

### 10.3 兼容的三层

| 层 | 位置 | 作用 |
|---|---|---|
| 版本门禁 | `ui/WebViewSupport.kt` | < Chromium 99 直接给出可操作提示，不加载页面 |
| API 兼容层 | `ui/WebViewCompatScript.kt` | 文档启动注入缺失 API，只定义不存在的，原生实现优先 |
| 加载面板 | `ui/HarnessPane.kt` | ready 且 onPageFinished 前用壳面板占位，无白屏 |

三者顺序有依赖：门禁决定**能不能**加载，兼容层决定加载后**跑不跑得起来**，
加载面板决定用户**看不看得到空白**。

### 10.4 前台服务

`service/HarnessConnectionService.kt` 只做两件事：把进程钉在前台（否则后台
freeze 会带走 JSch 隧道），以及提供通知入口。它**不持有**任何连接状态——
`ConnectionManager` 是唯一事实源，服务重启不会造成「两份连接」。
