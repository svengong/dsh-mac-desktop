# DSH 桌面壳 Agent 文档

本文档供后续在仓库中工作的编码 Agent / 开发者使用。目标是：**看懂最近一次实现、
不破坏既有边界、按同一套方式继续加固和交付。**

## 1. 项目一句话

Electron 薄壳（macOS / Windows / Linux，三者同等支持）：主窗口顶部 46px 壳边框，
下面是 harness WebContentsView；每个窗口绑定一个设备 session；更新/安装全部走官方
npm 产物渠道（`@deepseek-ai/dsh`）与 `dsh plugin` 命令。

## 2. 最近一次实现清单

| 主题 | 位置 | 关键点 |
|---|---|---|
| 开发态隔离 | `src/main.js#configureUserData` | 未打包时 userData=`~/.dsh-dev`（自动创建）；`DSH_DESKTOP_USER_DATA` 可覆盖 |
| 端口 0 | `src/runtime-store.js`、`src/connection.js` | 本地/远端 `dsh web --port 0`，解析 `dsh web: URL` 回读真实端口 |
| 版本化运行时 | `src/runtime-store.js`、`src/update.js` | 官方产物 npm install → 原子 `current` → 自动/手动回滚 |
| 转发端口 | `src/ports.js` | 仅 SSH 本地转发使用优先端口 + 顺延 30 + 进程内预留 |
| 安装锁 | `src/runtime-store.js`、`src/update.js` | 本地 `mkdir` 锁；远端 owner+2h stale 锁；产物安装串行 |
| 窗口状态 | `src/window-manager.js`、`src/main.js` | `window-state.json` 保存 bounds/active-view/last-active，启动恢复 |
| 多窗口加固 | `src/main.js` | 保存后重载同设备所有设置面板；按终端 busy 阻止同设备并发任务；重连定时器不复活已 stop session |
| 退出防护 | `src/main.js#before-quit` | 退出直接 teardown 子进程；staging 与运行服务隔离，杀安装安全 |
| 日志面板 | `src/ui/settings.html` | 日志在 tab 最后、固定 176px、`updates:get-log` 回填最新 |
| macOS UI | `src/main.js#createBrowserWindow`、`src/ui/shell.css` | hiddenInset + trafficLightPosition；系统字体与浅/深色变量 |
| npm 插件 | `src/components.js`、`src/update-manager.js`、`src/ui/settings.html` | `installSpec` 支持 pnpm `add` 全语法；可直接粘贴完整命令 |
| 终端身份 | `src/settings.js`、`src/connection.js`、`src/main.js` | 远程机器身份用 `~/.dsh/.desktop-machine-id`，设备键归一为 `machine:<id>`，不同 ssh 别名指向同一机器时合并 |
| SSH banner 隔离 | `src/connection.js#remoteRun` | 远程命令用随机 sentinel 包裹，网关登录 banner（`authz success` 等）被隔离在 payload 之外 |
| 加载面板 | `src/main.js`、`src/ui/shell.html`、`src/ui/shell.css` | 连接/加载/构建/更新期间用主窗口内置面板展示 spinner + 状态 + 实时日志，替代独立进度窗口 |
| 移除进度窗口 | `src/dialogs.js`、`src/ui/progress.html` | ProgressDialog 已删除；进度经 `shell:state` / `shell:log` 进加载面板，重试走 `shell:action` |
| 无感自动重连 | `src/connection.js` | close watcher 重启后发布新端口 `ready`；`ready` 态每 4s 健康探测，连续 2 次失败自动 `connect()`（`startHealthMonitor`/`healthTick`/`HEALTH_INTERVAL_MS`/`HEALTH_FAILURE_THRESHOLD`），覆盖插件安装/进程内重载/外部托管/远端崩溃 |
| 设置定位菜单 | `src/ui/settings.html`、`src/ui/shell.css` | 左侧 208px 菜单只**定位**分区（更新/连接/外观/日志，全部平铺不折叠），随滚动高亮；菜单是贴左边缘的实体面板（背景 + 右边框 + 底部终端标识），正文列 940px 左对齐；有可用更新时「更新」带橙点 |
| 设置入口焦点 | `src/main.js#setWorkspaceView`、`src/dialogs.js`、`src/ui/settings.html` | 只有「连接」语义的入口（终端启动器／⌘,／终端徽标／失败页「连接设置」）才锚定到「连接」；顶栏「设置」等普通入口锚点为 `null`，面板停在顶部。初始焦点在 boot 状态与 `updates.getState()` **两次渲染都完成后**才施加，否则偏移量按旧布局计算会落空 |
| 多屏焦点抖动 | `src/windows.js#focusViewInKeyWindow`、`src/main.js#updateHarnessVisibility`、`src/dialogs.js` | 聚焦 `WebContentsView.webContents` 会**激活其宿主窗口**（实测 Electron 35）：会话级广播会给同终端所有窗口重设视图焦点，后台窗口因此抢走前窗；双屏下表现为窗口与顶部菜单在两个屏幕间来回闪。所有视图聚焦统一走「仅当窗口已是 key window 才聚焦」 |
| harness 导航护栏 | `src/external-open.js`、`src/main.js#installHarnessNavigationGuard` | 主框架 `isExternalUrl` 只保留 harness 根路径，其余交系统浏览器；子框架 `isExternalSubFrameUrl` 只驱逐跨源内容（插件 iframe 归插件）。拦截后 `restoreHarnessAfterBlockedNav()` 恢复就绪态；`did-start-navigation`(isMainFrame) 才代表文档被替换 |
| `--no-open` 门控 | `src/connection.js` | `dsh web --no-open` 只在运行时 ≥ `NO_OPEN_MIN_VERSION` 时传（旧产物遇未知选项启动即失败）；`unknown` 版本按旧处理 |
| 平台抽象 | `src/platform.js` | **唯一**平台差异层：`killTree`（POSIX 进程组 / Windows `taskkill /T`）、可执行文件命名、PATH 键与分隔符、node 分发归档、`current` 指针（symlink / junction）、ssh 配置路径。业务模块禁止出现 `process.platform` 分支 |
| 进程/端口发现 | `src/process-scan.js` | **唯一**发现层：`lsof`+`ps`（POSIX，`ps` 被拒回退 `pgrep -fl`）/ `netstat -ano`+CIM（Windows）。`processUsesHome` 用于**杀进程决策**，Windows 走命令行路径前缀，判定不出来必须是 false |
| 跨平台父进程监护 | `src/service-guard.js`、`src/runner.js#spawnService` | 原 `sh` watchParent 包装脚本由 node 监护进程取代：宣告真实服务 pid、父进程消失时结束服务树、服务自行退出时透传退出码。监护进程以 `ELECTRON_RUN_AS_NODE=1` 运行，且**不得**把该变量泄漏给被监护服务 |
| Windows 窗口外壳 | `src/main.js#createBrowserWindow`、`src/ui/shell.css` | macOS 用 `hiddenInset`+`trafficLightPosition`（左侧留 84px）；Windows 用 `hidden`+`titleBarOverlay`（右侧留 152px，overlay 高度 = 46px）。平台信息经 query param 传给 shell.html / settings.html，落到 `:root[data-platform]` |
| 菜单/托盘按平台 | `src/menu.js`、`src/tray.js`、`src/main.js#refreshMenu` | macOS 装应用菜单 + Dock 菜单；Windows/Linux 装窗口菜单但 `setMenuBarVisibility(false)`（保留 `CmdOrCtrl` 加速键），操作入口靠托盘。托盘图标 macOS 用模板图、其它平台用彩色图标缩到 16px |
| Linux 支持 | `src/platform.js`、`src/ui/shell.css`、`package.json#build`、`.github/workflows/*.yml` | 与 macOS 共用 POSIX 实现；AppImage/deb 双架构进 CI 与 release；窗口留白已覆盖 `data-platform="linux"`；架构名按格式不同（见不变量 35） |
| 目录选择器 | `src/picker.js`、`src/harness-preload.js`、`src/main.js#picker:directory`、`src/dialogs.js` | harness 页与设置面板都走同一个窗口 sheet 选择器；父窗口按 webContents 显式解析，不按焦点 |

## 3. 必须遵守的不变量

1. **壳不执行任意用户命令。** 用户组件只有 `npm` 与 `git-preset`；npm 安装必须是
   `node bin.js plugin --profile <profile> add <spec>`，`spec` 作为单个 argv 传入。
2. **壳只杀自管子进程。** 非自管服务只探测、只复用，不 kill。
3. **settings 永远先归一化。** 所有入口都经 `normalizeSettings`，坏数据回退默认。
4. **Web 服务端口必须用 `--port 0`。** 不要重新引入本地/远端 web 端口扫描；只有 SSH
   转发端口使用 `acquireLocalPort()`，停止/失败路径调 `releaseReservedPorts()`。
5. **产物安装必须过 runtime-store 锁。** 新增任何运行时写入或产物安装路径时，
   先判断是否会被第二个壳实例并发执行。
6. **busy 任务按终端互斥。** 新增任何产物安装/plugin update 路径前，先经过
   `isSessionBusy()` / `canStartBusyTask()` 语义（或复用 `Updater.runPipeline` /
   `UpdateManager.update*`）；不同终端的安装互不阻塞。
7. **多窗口设置不能有第二事实源。** 连接设置保存后必须 `setupDialog.reload()` 同设备窗口；
   更新状态用 `broadcastSession` 推送。
8. **标题与菜单统一走 `labels.js`。** 不要手写第二份 `DSH-[终端]`。
9. **渲染器保持 sandbox。** 只通过 preload 的窄 API；IPC 返回 JSON-safe 数据。
10. **开发态不要碰生产数据。** 不要绕过 `configureUserData` 或写死
   `~/Library/Application Support/DeepSeek Harness`。
11. **每个功能提交一次 git，并在提交前跑两条 smoke。** 见下。
12. **子进程引用必须做身份校验，禁用无条件覆盖。** `ConnectionManager` 的
    `connectEpoch` 是连接代数：close 处理器与重试定时器先比对代数再动作
    （陈旧回调不得再 spawn 或清引用）；`this.localChild === service.child`
    之类身份检查防止跨代误杀/误清。新增任何子进程回调都按此模式。
13. **退出必须杀光所有子进程。** 所有 spawn 都经 `runner.js` 的进程登记表
    （trackChild），`before-quit` 调 `killActiveChildren()` 组杀；不要让
    在途 git/pnpm 构建在应用退出后继续运行。
14. **超时杀进程必须连进程组一起杀。** `runCommand` 一律 `detached: true`，
    超时用 `process.kill(-pid, 'SIGKILL')`，否则 pnpm/npm 的孙进程会孤儿化。
15. **仅官方产物，无源码构建。** 更新只走 `artifact.js` 预检（registry 最新版 +
    依赖链完整性）→ `installNpmArtifact` 安装 → `activateLocalRuntime` 原子切换；
    链断/安装失败直接报错并说明原因，不回退源码构建。新增安装路径必须复用这套
    原语，不要自造第三套。
16. **更新意图必须可恢复。**
17. **连接时自动升级驻留程序是核心契约。** 连接对比 state.version 与
   serviceVersion，不匹配自动 reap + relaunch；但「获取新版本」只走更新管线——
   版本只在更新管线里变更。改版本语义前先读
   `development.md`「10. 新版本发布约定」。 开始更新前写 `update-pending.json`，正常结束才清除；
    被打断（退出/崩溃）后启动时 `resumePendingUpdate()` 询问继续/放弃。detached
    worker（`update-worker.js`）不注册进进程登记表，壳退出不杀它；壳通过
    `runtime/update-status.json` 观察，`done` 后重启服务，下次连接按版本不匹配兜底。
18. **导航分类分主/子框架，且子框架归插件。** `will-navigate` 用 `isExternalUrl`
    （只保留 harness 根路径）；`will-frame-navigate` 用 `isExternalSubFrameUrl`
    （只驱逐真正跨源内容）。子框架属于嵌入它的插件（sidebar 的文件预览就是），
    壳拦截会把插件 UI 顶到系统浏览器。**不要**把主框架规则套到子框架上。
19. **拦截导航后必须自己恢复就绪态。** 被 `preventDefault()` 的导航不会发出
    `did-finish-load`，`harnessReady` 不会自动恢复，加载面板会永久盖住 harness。
    `will-navigate` 里必须调 `restoreHarnessAfterBlockedNav()`。
20. **`did-start-loading` 对任意框架都触发，包括 iframe。** 只有主框架的
    `did-start-navigation`（`isMainFrame`）才代表 harness 文档被替换。在
    `did-start-loading` 里清 `harnessReady`，会让任何插件 iframe 加载把 harness
    永久打成加载态——这是「点预览后 harness 进加载页」的根因。
21. **版本门控新 CLI 选项。** 加 `--no-open` 一类选项前先确认运行时支持
    （`NO_OPEN_MIN_VERSION`）；未知选项会让旧产物启动即失败。版本解析不出来
    （`unknown`）时按**旧**处理——猜「新」会搞挂本来要救的那次启动。
22. **设置面板初始焦点必须在两次渲染都完成后施加。** boot 状态与
    `updates.getState()` 是两次异步渲染，更新行会改变页面高度；只等第一次就锚定，
    偏移量按旧布局计算会落空（实测 135 vs 真实 249）。用 `settleAndFocus()` 模式。
23. **定位目标要夹取到最大可滚动位置。** 页面底部不留垫层（垫层在滚到底时就是一片
    空白），所以末尾分区物理上到不了顶部；`goToSection` 用
    `Math.min(maxScroll, …)` 夹取，保证它完整可见即可。

24. **平台差异只准出现在 `platform.js` / `process-scan.js`。** 业务模块里出现
    `process.platform` 分支、`/bin/...`、`kill(-pid)`、`lsof`、`ps` 都是缺陷：
    先在这两个模块里加能力，再调用。三个平台是同等的支持目标，不是「顺带能跑」。
25. **杀进程一律走 `platform.killTree`。** POSIX 用它结束整个**进程组**（pnpm/git
    的孙进程），Windows 用它递归结束**进程树**。直接 `process.kill(-pid)` 在 Windows
    上抛 ESRCH 而不是「结束进程」，直接 `child.kill()` 会漏掉孙进程。
26. **驻留服务的父进程监护不能依赖 shell。** Windows 没有 `sh`，也没有 PDEATHSIG；
    用 `service-guard.js`。它输出的 `SERVICE_PID_PREFIX` 行是 state 文件记录**真实服务
    pid** 的唯一来源——记录成监护进程的 pid，会让 keepPid 清扫杀掉本想保护的服务。
27. **`ELECTRON_RUN_AS_NODE` 只进不出。** 用 `process.execPath` 跑辅助脚本时必须置该
    变量（否则会启动一个完整 Electron 主进程）；但监护进程 spawn 真实服务前必须删掉它，
    否则服务工具链里任何 Electron 二进制都会退化成 node。
28. **Windows 不能 symlink `current`。** 符号链接需要管理员或开发者模式；用目录联接
    （junction）。它不能用 rename 覆盖，所以 `swapCurrentLink` 的交换顺序是
    「旧指针先改名→新指针就位→删旧」，并且中途失败要恢复旧指针。
29. **程序头（`spawn options`）走 `platform.spawnOptions()`。** 它同时保证 POSIX 的
    `detached` 进程组与 Windows 的 `windowsHide`（否则每次 git/npm 都闪一个控制台窗）。
30. **Windows 上没有 `/bin/sh` 可借。** 需要「找某个工具」时用 `findOnPath`（Windows
    走 `where`）与 `findViaLoginShell`（Windows 走 PowerShell `Get-Command`），不要拼
    `spawnSync('/bin/sh', …)`。
31. **跨平台的冒烟测试不能写死 POSIX 路径。** 子进程测试用
    `node -e '<script>'`（见 `scripts/smoke.js` 的 `nodeChild` / `sleepCommand` /
    `echoCommand`）。宿主拒绝进程枚举时（沙箱/无 Full Disk Access），依赖枚举的断言
    必须**显式跳过**并打一行提示，不能当成失败——那不是壳的缺陷。
32. **Windows 托盘不能沿用 macOS 模板图。** 模板图是黑 + alpha、由系统着色；直接放到
    深色任务栏就是一块看不见的黑。非 macOS 一律用彩色图标缩到 16px。
33. **`titleBarOverlay` 的高度必须等于 `SHELL_FRAME_HEIGHT`。** 46px 是壳边框、也是原生
    窗口控件的高度；两者不一致会让控件条与壳边框错位。平台留白（左 84px / 右 152px）
    写在 `:root[data-platform]` 规则里，不要写进 JS。
34. **Linux 走 POSIX 实现，但窗口外壳走 Windows 分支——两处都要照顾到。**
    `platform.js` 里 `IS_LINUX` 只影响 `platformName()` 与 node 归档默认值，进程/端口
    发现完全复用 POSIX（`lsof`/`ps`/`pgrep`）。但 `main.js` 对 Linux 用的是
    `hidden` + `titleBarOverlay`（只有 macOS 走 `hiddenInset`），所以 `shell.css` 的
    overlay 留白必须**同时**匹配 `[data-platform="windows"]` 与 `[data-platform="linux"]`：
    只写 `windows` 会让 Linux 保留 macOS 的左侧 84px 留白、右侧不避让原生控件，
    品牌区被窗口按钮压住。动窗口外壳时 CSS 选择器与 JS 分支要一起改。
35. **Linux 的架构名按产物格式不同，别统一写成 `x64`。** `${arch}` 宏对 AppImage
    展开为 `x86_64`、对 deb 展开为 `amd64`（`arm64` 两者一致），实测产物是
    `…-linux-x86_64.AppImage` 与 `…-linux-amd64.deb`。因此 `build.appImage` 与
    `build.deb` 必须**各自**声明 `artifactName`；只依赖顶层（macOS 命名）会得到
    `…-macos-…` 的错误文件名。CI 与 release 都断言真实文件名，改配置后跑一次。
36. **Linux 包不能交叉构建，arm64 也不行。** AppImage/deb 必须在 Linux 主机上打包；
    deb 走 fpm，arm64 需要 aarch64 工具链，x64 runner 上交叉不出来。所以 release
    用原生架构 runner（`ubuntu-24.04` / `ubuntu-24.04-arm`），不要在 x64 上加 `--arm64`。
37. **deb 目标无 `homepage` / `author` 会直接构建失败。** `computeFpmMetaInfoOptions()`
    在两者缺失时抛错（`Please specify project homepage` / `author 'email'`）。这两个
    字段在 `package.json` 顶层，删掉之前先确认没有 Linux 打包任务。
38. **目录选择框必须是「发起窗口的 sheet」，父窗口按 sender 显式解析。**
    harness 自带的 native picker 行只要发现 `globalThis.__DSH_DIRECTORY_PICKER__` 存在就走桌面桥，
    否则回退 Host 的 `osascript` 面板——那是个非前台 Accessory 应用开的 `NSOpenPanel`，
    面板不是 key window，第一下点击只用来激活 DSH。所以：harness view 必须挂
    `harness-preload.js`，`picker:directory` 必须 `dialog.showOpenDialog(owner, …)` 传父窗口。
    **别用 `BrowserWindow.fromWebContents(event.sender)` 当唯一来源**：对 `WebContentsView`
    的 sender 它不保证返回宿主窗口，退回 app-modal 就复现原症状。用
    `workspaceOwning(sender)`（workspace 表里按 webContents 匹配）。设置面板同理走
    `handlers.ownerWindow`。
## 4. 验收命令

```sh
node scripts/smoke.js                 # 全平台；含平台原语断言
DSH_DESKTOP_SMOKE=1 npx electron .    # macOS/Linux
$env:DSH_DESKTOP_SMOKE=1; npx electron .   # Windows PowerShell
node --check <改动的 .js>
```

改了 `platform.js` / `process-scan.js` / `runner.js` / `connection.js` 的进程相关逻辑后，
**必须在 macOS 与 Windows 上都跑一次 `npm run smoke`**：这两个平台的杀进程与进程发现
走的是完全不同实现，只在一个平台上绿等于没验证。Linux 与 macOS 同属 POSIX 分支，
通常跟着 macOS 一起过；CI 已在 `ubuntu-24.04` 上跑同一套冒烟。

改了打包配置（`package.json#build` / 工作流）后，Linux 侧**必须真跑一次**
`npm run dist:linux`：架构名、`executableName`、desktop 文件名都只在真实产物里
才看得见，配置校验不会替你发现 `…-macos-` 这种错名。

UI 改动额外检查：

```sh
python3 - <<'PY'
import re, pathlib
for name in ['settings.html','shell.html']:
    text = pathlib.Path('src/ui/' + name).read_text()
    open('/tmp/%s.js' % name, 'w').write('\n'.join(re.findall(r'<script>(.*?)</script>', text, re.S)))
PY
for f in /tmp/settings.html.js /tmp/shell.html.js; do node --check "$f"; done
```

## 5. 改哪里：速查

- 想加“设备级能力”→ 看 `sessionFor` / `workspace`，不要挂在全局单例。
- 想加端口/服务生命周期 → `connection.js`，复用 `ports.js`。
- 想加可更新组件 → 先读 `components.js` 的归一化，再在 `update-manager.js`
  加 check/update 方法；同时补 `scripts/smoke.js` 的无网络测试。
- 想加设置字段 → `settings.js` 默认值 + 归一化、`settings.html` 表单、
  `main.js#save` 校验，并确认多窗口 reload。
- 想动壳边框 UI → `shell.css` 设计变量 + `shell.html` 栏目；禁止引入在线字体/图标依赖。
- 想改日志 → `ConnectionManager.logRing` 是 300 行 ring；面板晚创建用
  `updates:get-log` 回填，不要只依赖实时 push。
- 想改 harness 导航/外部链接规则 → `external-open.js`（`isExternalUrl` 主框架 /
  `isExternalSubFrameUrl` 子框架）+ `main.js#installHarnessNavigationGuard`。
- 想改设置面板布局/入口焦点 → `settings.html`、`shell.css`、`dialogs.js`、
  `main.js#setWorkspaceView`（锚点语义）。
- 想用平台特有 API（杀进程/找工具/路径/归档/链接）→ 先看 `platform.js` 有没有；
  没有就加在那里，**不要**在业务模块里写 `process.platform` 分支。
- 想用平台特有的进程/端口发现 → `process-scan.js`。
- 想改窗口外壳的原生控件留白 → `main.js#createBrowserWindow`（`titleBarOverlay` /
  `trafficLightPosition`）+ `shell.css` 的 `:root[data-platform]` 规则。
- 想加 Windows/Linux 专属入口 → 托盘菜单（`tray.js`），因为那些平台没有应用菜单栏。
- 想加构建目标/架构 → `package.json#build.{mac,win}.target` + `.github/workflows/*.yml`
  的矩阵；两边必须同步，否则会出现「本地能打、CI 不产」的空洞。

## 6. 常见坑

1. **`dsh plugin` 是 pnpm 转发器。** 相对路径 spec（`.`、`../x`）会被 CLI 锚定到调用目录，
   所以本地安装用 `cwd=repoDir`；远端用登录 shell 路径并保持 `shellQuote`。
2. **pnpm 11 对已写死的精确依赖不会自动升级。** 裸包名必须查 latest 后传
   `pkg@x.y.z`；用户显式写了 tag/range/git spec 则原样转发。
3. **远程命令会被双重单引号包裹。** 内层路径/值仍要用 `shellQuote`/`remotePath`，
   不要手拼裸字符串。
4. **`tcpProbe` 成功 ≠ 端口是 DSH。** 本地复用只认 state.version + `__DSH_BOOT__` 标记。
5. **窗口关闭是隐藏不是销毁。** 清理逻辑要区分 `close`（hide）与 `closed`（quit）。
6. **退出不阻塞安装。** 退出直接 teardown 子进程；staging 目录与运行服务隔离，杀安装安全，下次启动重建。
7. **设置面板是懒创建且常驻。** 修改共享设置后必须 reload，否则旧 form 会被另一个窗口保存回去。
8. **端口不再暴露给用户。** 内部 `dsh web --port 0`；SSH 本地转发 `localPort` 仅作优先值、占用时顺延，settings 里的 `remotePort` 仅作兼容保留。
9. **官方产物安装失败会回滚。** 新产物启动失败自动切回 `previous` 并重启旧版本；
   无上一版本（首次安装）时则报错并保留失败目录待重试。
10. **serviceVersion ≠ currentVersion。** 状态复用必须用 active runtime 的 `serviceVersion`；
    直接比较包版本之外的东西会让回滚后的服务在下一次连接时被误杀重建。
11. **运行时布局不再只有仓库形状。** bin 查找必须走 `runtime-layout.js`
    （repo 布局 `apps/cli/lib/bin.js`；npm 布局 `node_modules/@deepseek-ai/dsh/lib/bin.js`），
    直接拼 `apps/cli/lib/bin.js` 会漏掉官方产物运行时。
12. **重连会杀旧子进程，close 事件异步到达。** 旧 child 的 `close` 可能在新的
    `spawnLocalService` 之后触发：先比 `connectEpoch` 再清引用/排重试，
    否则新服务会失去跟踪（退出时不杀）或触发双 spawn（两个服务进程）。
13. **30s 端口等待定时器可能跨代触发。** `portTimer` 到期时 `this.localChild`
    可能已属于新一代连接；必须身份校验后再 kill，否则会杀掉健康的新服务。
14. **远端命令的 stat 必须 GNU 优先。** `stat -c %Y`（GNU/Linux）先试，
    `stat -f %m`（BSD/macOS）兜底；反序时 GNU 的 `-f %m` 会把文件系统信息块
    打到 stdout 污染 lines[0]。
15. **远端 state 文件必须带换行结尾。** `writeRemoteState` 的 printf 缺 `\n`
    会让 `cat` 输出与 remoteRun 的 END marker 粘连，payload 隔离失效导致
    state 读取返回 null（历史潜伏缺陷）。`extractPayload` 按子串匹配 marker
    做纵深防御，新增无换行输出的远端命令前先想清楚 marker 行为。
16. **版本只在更新管线里变更，连接不触发升级。** `serviceVersion` 在
    manifest.current 有效时返回它；只有「获取新版本」（更新管线）才会切换
    current，连接只负责「升级到 current」。
17. **服务重启后必须发布新端口 `ready`，否则窗口卡死在死端口。** `--port 0` 重启
    可能换端口；close watcher / 隧道重连 / 健康看门狗恢复成功后都要
    `setStatus({state:'ready', url: this.url()})`，`onSessionStatus` 才能据此
    刷新窗口。只更新 `localPort` 而不发 status，窗口仍指向旧 URL。
18. **健康看门狗只跑在 `ready` 态，且要连败计数防抖。** 非 ready
    （connecting/restarting/error）退避，避免与 close watcher、`onSessionConnectFailed`
    重试、更新流水线抢跑造成双重连/无限重连。
19. **`--no-open` 要版本门控。** 新选项对旧产物是「未知选项」会启动即失败；
    用 `supportsNoOpen()`（`NO_OPEN_MIN_VERSION`），`unknown` 版本按旧处理。
20. **导航被拦截 ≠ 导航没发生副作用。** 实测顺序 `did-start-loading → will-navigate
    → preventDefault → did-stop-loading`：拦截前 `harnessReady` 已被清掉，必须
    `restoreHarnessAfterBlockedNav()` 恢复，否则加载面板永久盖住 harness。
21. **`did-start-loading` 会被子框架触发。** 插件 iframe 加载也会走到它；清
    readiness 会误伤 harness。只信主框架的 `did-start-navigation`。
22. **设置面板焦点别在第一次渲染后就锚定。** `updates.getState()` 异步渲染会改变
    页面高度，导致偏移量过时（实测 135 vs 249）；等两次渲染都完成再锚定。
23. **别给页面底部加垫层来实现「末分区定位到顶」。** 垫层在滚到底时就是大片空白；
    用 `Math.min(maxScroll, …)` 夹取，让末分区完整可见即可。
24. **给 `WebContentsView` 聚焦会激活宿主窗口，必须用 `focusViewInKeyWindow()`。**
    实测（Electron 35 / macOS）：`win.webContents.focus()` 对非 key 窗口无效，但
    `view.webContents.focus()` 会把该窗口**激活**并抢走最前状态。壳的
    `onSessionStatus` / `setProgress` / `observeUpdateWorker` / `reloadSessionWindows`
    都会遍历**同终端所有窗口**，无守卫的 `focus()` 因此让后台窗口抢焦点；
    健康看门狗每 4s 还会持续喂事件，于是两个窗口互相顶替——双屏下就是窗口与顶部
    （菜单栏）在两块屏幕间来回闪。`isFocused()` 在窗口自身 `focus` 事件里已为 true，
    所以正常的窗口切换重新聚焦不受影响。新增任何视图聚焦都走该守卫。

25. **Windows 的 `spawn` 不会替你找 `.cmd`。** `spawn('pnpm', …)` 在 Windows 上抛
    ENOENT——真正的可执行文件是 `pnpm.cmd`，而且 node 不能直接 exec 它，必须
    `shell: true`。`platform.executableNames()` 负责找对文件，`tools.js` 的 pnpm 探测与
    `service-guard.js` 负责在它是 `.cmd/.bat` 时开 shell。
26. **`taskkill` 退出码 128 表示「进程已经没了」。** 那不是失败，别把它当错误上报；
    `killTree()` 因此把 0 和 128 都视为成功。
27. **junction 的 `lstat().isSymbolicLink()` 为 true，但 `fs.realpathSync` 会解开它。**
    任何「这个目录是链接吗」的判断都要先想清楚是要判链接本身还是目标。删 junction 用
    `fs.unlinkSync`（`platform.removeLink` 已处理），用 `rm -rf` 反而会删掉**目标目录内容**。
    （POSIX 的 `rm -rf` 对符号链接是安全的，Windows 的 junction 不是——这是本仓库里最容易
    造成数据丢失的一处平台差异。）
28. **Windows 上 `path.delimiter` 是 `;`，环境变量键名是 `Path` 不是 `PATH`。**
    `childEnv()` 两个都写且写同一个值；只写 `PATH` 时 cmd.exe 可能读不到。
29. **PowerShell 的单引号字符串里单引号要写两遍。** 传路径给 `-Command` 时用
    `process-scan.psQuote()`，别手拼。`-NoProfile -NonInteractive` 必须带上：用户 profile
    可能打印自己的输出，把逐行解析的行序冲掉。
30. **`-NoProfile` 之外还要 `-ExecutionPolicy Bypass`。** 企业机器常用 AllSigned，
    默认策略会直接拒绝 `-Command` 内联脚本。
31. **`netstat -ano` 的 LAN-only 监听不是证据。** 只认 loopback 与通配绑定（`0.0.0.0`/`::`），
    并且只认 `LISTENING` 行；把 `192.168.x.x:445` 当成本机服务会让「端口→pid」全程错位。
32. **`ps` 被拒绝不等于「没有进程」。** 空数组意味着「清扫没发现任何东西」——行为上
    安全（不杀），但会让残留 host 一直占着 session store，下次 spawn 就崩溃循环。
    沙箱 / 容器 / 无 Full Disk Access 的 macOS 都可能拒绝 `ps`，而 `pgrep`（走 sysctl）
    仍然可用 ⇒ `posixProcessLines()` 先 `ps` 后 `pgrep -fl`。
33. **Windows 安装包必须用 `ELECTRON_BUILDER_7Z_FILTER=BCJ` 打，安装器退出码 0
    不代表装成功了。** electron-builder 26.15.x 在 x64/arm64 上会自动选 BCJ2 打
    `app-*.7z`，而 Nsis7z 解码器读不了多流 BCJ2 ⇒ **静默跳过所有 PE 文件**（主程序 +
    全部 DLL）。实测：BCJ2 装出 68 文件/71.3MB/0 DLL/无主程序，BCJ 装出 75 文件/
    287.7MB/6 DLL/主程序 `PE 0xAA64` 且能启动。所以 `npm run dist:win*` 走
    `scripts/build-win.js`（固定滤镜 + 构建后校验 payload 方法），并且**验收必须在真
    Windows 上装一遍并启动**，不能只看 exit code。
34. **「豁免这个服务」必须同时看 group 和 child，不能只看 group。**
    本地 dsh web 是两进程家族（guard + service）：旧 state 记 guard 的 pid（service 是它的
    **子进程**），新 state 记 service 的 pid（此时它的**组 id 属于 guard**，问「它自己的组」
    什么也问不到）。只查 group ⇒ 少豁免一个 ⇒ **杀掉刚验证过的健康服务**（已复现：
    keep-guard-pid 时清扫杀了 1 个而非 0 个）。用 `serviceFamily()`，它同时走
    `pgrep -g`（组）与 `pgrep -P`（子进程），且都不依赖 `ps`。
35. **`getBounds()` 在 Windows 上可能返回负的 y**（窗口最大化/多显示器）。
    `window-manager.normalizeBounds` 只校验尺寸下限，不夹取坐标——改这块前先想清楚
    多显示器下「恢复到哪里」的语义。
36. **弹出选择框后第一下点击被吃掉，是「面板不是 key window」而不是壳的点透问题。**
    症状：打开工作区弹出文件框，但无法直接选中，得先点一下 DSH 窗口。别去改
    `acceptFirstMouse` 或视图层级——那是壳自身的点击路径，与系统面板无关。真因是面板由
    Host 的 `osascript` 在非前台进程里打开（见不变量 38）。自查两件事：harness view 是否挂了
    `harness-preload.js`，以及 `dialog.showOpenDialog` 第一个参数是不是发起请求的窗口。

## 7. 文档同步要求

完成新功能后，更新三份文档：

- `docs/requirements.md`：新增 FR 编号与验收。
- `docs/development.md`：模块/命令/测试/架构变化。
- `docs/agent.md`：本次提交清单、新坑与速查。

最后按功能拆分 git commit；不要把 UI、端口、插件、文档混成一个 commit。


## 8. Android 客户端（android/）—— 真机验证后才暴露的坑

1. **Compose 面板用 `background()` 会丢内容色。** `Modifier.background()` 只上底色，
   不设 `LocalContentColor`，默认黑色 ⇒ 深色主题下所有没显式写 `color` 的 `Text`
   都是黑底黑字。用 `Surface(color=…, contentColor=…)`。手机截图里那个面板恰好没露出
   标题，平板一眼就看见「选择一个终端」不见了。
2. **双栏布局里的「日志」必须渲染在右栏。** 早先右栏只放了一句「日志在左侧导航中查看」，
   而左栏只有开关，日志实际无处可看。凡「右栏占位 + 左栏入口」的设计，先确认入口真的
   能到达内容。
3. **`adb install` 在 MIUI/澎湃上可能报 `INSTALL_FAILED_USER_RESTRICTED`。** 那是「USB
   安装」需要确认；先 `settings put global adb_install_need_confirm 0` 与
   `verifier_verify_adb_installs 0` 再装。
4. **连接工作必须在 `Dispatchers.IO`。** 主线程开 socket 抛
   `NetworkOnMainThreadException`，被探活的 `try/catch` 吞成「隧道超时」——症状是
   「SSH 已连接、端口已绑定，却说过不去」。
5. **`dsh web` 默认只监听 127.0.0.1。** 用局域网 IP 直连必然超时（不是网络问题）；
   要么远端 `--host 0.0.0.0`，要么用 SSH 模式的隧道。URL 模式的错误提示要能说出这一点。
6. **JSch 绑定转发端口用 (host, 0, rhost, rport)。** 先探测空闲端口再绑定有竞态；
   让 JSch 自己挑并回传实际端口。
7. **WebView 需要在文档启动注入兼容层。** harness 在模块作用域调
   `Promise.withResolvers`/`AbortSignal.any`，注入晚了（onPageStarted 之后）bundle 已经挂了。
