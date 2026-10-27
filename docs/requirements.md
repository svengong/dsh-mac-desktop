# DSH 桌面壳需求文档

> 状态：已实现（macOS / Windows / Linux 三平台；macOS、Windows 由发布流水线产出双架构产物，Linux 在同一份源码的 Linux 主机上构建）
> 版本：跟随 `package.json#version`
> 更新日期：2026-10-27

## 1. 产品目标

DeepSeek Harness 桌面壳（dsh-desktop）是 macOS / Windows / Linux 上的薄桌面壳：
把 DeepSeek Harness Web UI 稳定地暴露在 `http://127.0.0.1:<端口>`。业务形态参考
VS Code Remote——用户可以选择本机或 SSH 远程主机运行 Harness，壳只负责连接、
安装、更新和启动，不承载任何产品页面逻辑。

平台与架构（全部为一方支持目标，不是"顺带能跑"）：

| 平台 | 架构 | 安装包形态 |
|---|---|---|
| macOS 11+ | `arm64`、`x64` | `.app`、`.dmg`、`.zip` |
| Windows 10/11 | `x64`、`arm64` | NSIS 安装程序、便携版 `.exe`、`.zip` |
| Linux（Chromium 与发行版均在支持期内） | `x64`、`arm64` | `.AppImage`、`.deb`（在 Linux 主机上构建） |

## 1.1 窗口与页面流转设计（产品视图）

状态分两层：终端会话（Session）与窗口工作区（Workspace）。
终端会话状态：未连接 → 连接中 → 就绪（ready）；任务状态：空闲/检查更新/组件更新/Harness 构建更新/服务重启。
窗口工作区状态：未绑定（detached）或已绑定某终端；页面视图：Harness/连接/更新管理。

- 启动第一个窗口：绑定上次活跃终端并自动连接；配置不完整时停在连接页；未初始化时进入初始化/官方产物流程（阻塞式进度横幅）。
- 显式新建窗口（工具栏 +、菜单、Dock）：不绑定任何终端，默认打开连接页；用户选择终端后点「保存并连接」才绑定。
- 未绑定窗口点 Harness：显示「待连接」提示与「打开连接设置」按钮，不加载任何 harness URL。
- 连接/初始化/更新完成不强制切到 Harness：当前窗口停留在连接/更新管理页，Harness URL 在后台准备，点 Harness 时直接显示。
- 已绑定窗口点 Harness：仅当连接 ready 且页面加载完成时显示 WebView；连接中/重启中/任务进度/失败时都由壳加载面板占位，不出现白屏。
- 更新/构建任务按终端共享：同一终端的所有已绑定窗口看到同一个阻塞进度横幅。更新中新建的未绑定窗口不受影响，工具栏始终可点击。
- 更新完成后：服务可能换到新的 OS 端口；壳按会话实际 URL 重新加载所有已绑定窗口，而不是 reload 旧地址。
- 保存已打开的终端是唯一的跨窗口场景：聚焦已有窗口，当前窗口保持原状态（不关闭、不绑定）。其他连接、初始化、更新均在当前窗口内进行，不切换窗口、不抢焦点；从忙碌终端切离时后台取消任务并保留旧版本。

关键场景覆盖：
1. 启动无配置 → 连接页。
2. 启动已配置但未初始化 → 初始化进度 → 连接 → Harness。
3. 更新中新建窗口 → 连接页，不加载旧 harness，不进入重启视图树。
4. 更新中切到 Harness 页 → 共享进度横幅，无白屏。
5. 更新完成后原窗口/其他已绑定窗口 → 按新 URL 加载并回到 Harness。
6. 更新失败 → 阻塞式错误面板，可重试/改用官方产物/放弃。
7. 未绑定窗口点更新管理 → 显示「请先连接终端」空状态；菜单更新操作会引导回连接页。

## 2. 范围

### 2.1 在范围内

- 本地模式：官方 npm 产物安装 / 启动 `dsh web` / 端口回退 / 数据目录隔离。
- SSH 远程模式：`~/.ssh/config` 主机选择、远端运行时安装、隧道保活、远端服务启停与重置。
- 多窗口工作区模型：窗口 ↔ 设备 session 绑定，同设备窗口共享后端。
- 统一更新管理：Harness 本体、npm 插件、Git 预设。
- 安装、更新与进度/日志展示。
- 平台原生外壳：macOS 菜单栏 / 程序坞 / 菜单栏托盘；Windows 与 Linux 状态区托盘、任务栏、`titleBarOverlay` 窗口控件。
- 三个平台的壳边框与嵌入式设置面板（同一套 46px 布局，按平台调整原生控件留白）。
- 全平台双架构：macOS、Windows、Linux 均提供 `arm64` 与 `x64` 产物；macOS 与
  Windows 由发布流水线构建，Linux 包在 Linux 主机上构建。
- 开发态与已安装应用的数据隔离。

### 2.2 不在范围内

- 密码交互式 SSH（只支持免密登录）。
- 壳的运行时自动更新（壳发版走手动发布的 release 流程；升级 harness 不需要升级壳）。
- 任意 shell 脚本执行（用户自定义组件只允许 `dsh plugin add <spec>` 与 Git 预设两类）。
- **Windows 上的「进程是否占用某 dsh home」判定**：没有 `lsof` 的廉价等价物，改用命令行路径前缀匹配；无法判定时保守地「不杀」（见 FR-7.6）。
- **Windows 上的进程组语义**：Windows 没有 POSIX 进程组，改为 `taskkill /T` 递归结束进程树（见 FR-7.2）。

## 3. 核心需求

### FR-1 工作区与多窗口

| 编号 | 需求 |
|---|---|
| FR-1.1 | 启动/恢复的第一个窗口绑定「当前终端」（上次活跃设备）并自动连接；配置缺失则停在连接页。 |
| FR-1.2 | 同设备的多窗口共享一个后端 session；不同设备各有独立隧道/服务/更新状态。 |
| FR-1.3 | 显式新建的窗口处于未绑定状态，不连接任何终端，默认打开连接页；可从菜单栏、Dock 菜单、托盘创建；未绑定窗口不改写「当前终端」记录。 |
| FR-1.4 | 关闭窗口只隐藏，Cmd+Q 才退出；退出前必须停止壳自管子进程。 |
| FR-1.5 | 任一窗口修改设备连接设置后，同设备其他窗口的设置面板不得保留旧表单。 |
| FR-1.6 | 任意窗口发起初始化构建/更新时，同一设备只允许一个构建/更新任务；菜单、托盘和 IPC 都要阻止同设备并发任务。 |
| FR-1.7 | 窗口切换设备时，必须避免旧设备页面闪现，并释放不再被引用的 SSH session。 |
| FR-1.8 | 服务就绪、隧道/服务重启后，所有等待中的同设备窗口都要跟随真实端口刷新；已打开窗口若 URL 变化则原地 reload，不抢焦点。 |
| FR-1.9 | 窗口 bounds、active view、最近活跃 workspace/设备要持久化到 `window-state.json`，启动时恢复上次设备与 bounds。 |
| FR-1.10 | Harness 页仅在终端连接 ready 且页面加载完成时显示 WebView；待连接/连接中/重启中/任务中/错误均由壳加载面板接管，不出现白屏。 |
| FR-1.11 | 每个终端的已绑定窗口全局唯一；保存/连接到已打开终端时，仅聚焦已有窗口，当前窗口保持原状态；其他情况均在当前窗口操作，不跳转。 |

### FR-2 连接与端口

| 编号 | 需求 |
|---|---|
| FR-2.1 | 本地与远端 web 服务使用 `--port 0` 由 OS 分配端口，并从 `dsh web: http://127.0.0.1:<port>` 回读实际端口；SSH 本地转发仍以设置端口为优先，占用则顺延最多 30 个端口。 |
| FR-2.2 | SSH 本地转发的“先探测后绑定”分配必须做进程内预留，避免两个 session 同时选中同一回退端口。 |
| FR-2.3 | 本地/远端 clone 与 build 使用原子目录锁；远端锁写 owner/时间戳，超时 stale 后回收，避免另一个壳实例或 SSH 会话并发安装。 |
| FR-2.4 | 旧版本/残留服务按 state 文件（pid/port/version）回收；版本匹配且仍为 DSH 服务时可复用。 |
| FR-2.5 | 所有子进程必须是壳的进程组，断开/切换时不能遗留 SSH 隧道。 |
| FR-2.6 | 连接失败自动重试 2 次；session 已被停止后，挂起的重试定时器不得复活 session。 |
| FR-2.7 | 端口不再由用户填写：本地/远端 web 服务由 OS 分配（`--port 0`）；SSH 本地转发端口保留设置值作为优先、占用时顺延。 |

### FR-3 数据与进程隔离

| 编号 | 需求 |
|---|---|
| FR-3.1 | 开发态（`electron .` / `npm start`）Electron userData 固定为 `~/.dsh-dev`（不存在时自动创建），不读写已安装应用的 `~/Library/Application Support/DeepSeek Harness`。 |
| FR-3.2 | 可通过 `DSH_DESKTOP_USER_DATA` 覆盖 userData（支持 `~/...`）。 |
| FR-3.3 | 本地服务默认 `DSH_HOME=~/.dsh-dev`，与终端用户常用 `~/.dsh` 完全分离。 |
| FR-3.4 | 每次启动写入独立日志文件到 `<userData>/logs/desktop-<时间戳>.log`。 |
| FR-3.5 | 已安装应用与开发应用使用不同的单实例锁，允许同时运行。 |

### FR-4 更新管理

| 编号 | 需求 |
|---|---|
| FR-4.1 | 更新组件按设备保存：Harness 内置行 + 用户定义的 npm 插件 + Git 预设。 |
| FR-4.2 | npm 插件必须通过官方 `dsh plugin --profile <name> add <spec>` 安装，spec 支持 pnpm 全量 `add` 语法：裸包名、scope、tag/range、`npm:` alias、`github:`、`git+https`、`file:`、`link:`、本地相对路径、tarball URL。 |
| FR-4.3 | 可直接粘贴完整官方命令，也可只填 `add` 后的参数；壳只转发 spec，不做 shell 拼接执行。 |
| FR-4.4 | 裸 npm 包更新时提升为 `pkg@<latest>`；带 tag/range/alias 或非 registry 源按原 spec 原样执行。 |
| FR-4.5 | 自定义 registry 必须同时用于版本检查与实际安装（通过 `npm_config_registry` 传递给 pnpm）。 |
| FR-4.6 | 检查全部时单行失败不得中断其他行，且每行必须有 error 状态。 |
| FR-4.7 | 更新完成后 Harness 管道自动重启服务；插件/预设更新需要显式重启服务。 |
| FR-4.8 | 更新管理 tab 的日志放在最后，固定高度（176px），进入时回填最近日志并滚动到最新。 |
| FR-4.9 | Harness 更新必须在 `<dshHome>/runtime/<version>`（远端 `~/.dsh/runtime/<version>`）完成 staging install/build，成功后原子切换 `current`；上一版本保留。 |
| FR-4.10 | 新 runtime 启动失败时自动回滚上一版本并重启；更新菜单提供手动「回滚 Harness」。 |

### FR-5 壳 UI（macOS 原生风格，跨平台一致）

| 编号 | 需求 |
|---|---|
| FR-5.1 | 主窗口使用无边框标题栏：壳自绘 46px 工具栏，macOS 原生红黄绿按钮在左上角，Windows 原生最小化/最大化/关闭按钮在右上角（见 FR-7.8）。 |
| FR-5.2 | 字体使用 SF Pro / PingFang SC 系统栈，等宽使用 SF Mono / Menlo；13px 正文、11–12px 辅助信息。 |
| FR-5.3 | 颜色、控件高度（20–28px）、圆角（5–10px）、间距遵循 macOS HIG；浅/深色跟随 `prefers-color-scheme`。 |
| FR-5.4 | 按钮有 hover/active/disabled 状态与焦点环；动画遵循 `prefers-reduced-motion`。 |
| FR-5.5 | 工具栏可拖拽，按钮/输入框为 no-drag。 |
| FR-5.6 | UI 只使用系统资源，不依赖在线字体或图标资源。 |
| FR-5.7 | 壳工具栏状态区展示终端任务状态：检查更新中/组件更新中/Harness 构建更新中/服务重启中；未绑定窗口显示待连接。 |

### FR-6 可靠性

| 编号 | 需求 |
|---|---|
| FR-6.1 | 同一设备构建/更新进行中禁止第二次构建/更新、禁止重置/重连后端；退出则直接 teardown（staging 与运行服务隔离，杀 build 安全）。 |
| FR-6.2 | 构建检查失败直接进入连接错误路径，不进入无意义的初始化流水线。 |
| FR-6.3 | 设置文档损坏时按默认值归一化，不崩溃。 |
| FR-6.4 | 日志落盘 + 窗口内 300 行 ring buffer；设置面板晚创建也能回填最近日志。 |
| FR-6.5 | 全部 IPC 只返回 JSON-safe 数据；渲染器无 Node 权限（sandbox + contextIsolation）。 |
| FR-6.6 | 窗口切换/关闭不得被更新任务阻塞；离开时取消该终端任务，官方产物 worker 可后台继续，旧版本继续运行，任务可重试。 |
| FR-6.7 | 连接进入 `ready` 后，壳周期探测服务 URL；检测到服务不可用（连续两次探测失败）或自管服务退出时自动重连并刷新窗口到新端口，无需手动点击「重新连接」（无感接入）。 |

### FR-7 跨平台与架构

| 编号 | 需求 |
|---|---|
| FR-7.1 | 同一份源码在 macOS / Windows / Linux 上可运行；所有平台差异集中在 `src/platform.js`（进程树结束、可执行文件命名、PATH 分隔符与系统目录、node 分发归档、`current` 指针、ssh 配置路径）与 `src/process-scan.js`（进程/端口发现）。业务模块不得直接出现 `process.platform` 分支。 |
| FR-7.2 | 结束子进程必须按平台语义执行：POSIX 结束整个进程组（`kill(-pgid)`，防止 pnpm/git 孙进程孤儿化）；Windows 用 `taskkill /T /F` 递归结束进程树。所有 kill 路径（超时、取消、退出、重置、残留清理）统一走 `platform.killTree`。 |
| FR-7.3 | 驻留服务的父进程监护必须跨平台：`sh` 版 watchParent 包装脚本由 `src/service-guard.js`（node 实现）取代，负责宣告真实服务 pid、父进程消失时结束服务树、服务自行退出时透传退出码。监护进程以 `ELECTRON_RUN_AS_NODE=1` 运行，且不得把该变量泄漏给被监护服务。 |
| FR-7.4 | 运行时 `current` 指针必须原子切换且免提权：POSIX 用相对符号链接 + rename；Windows 用目录联接（junction，无需管理员或开发者模式）并保证切换失败时恢复旧指针。 |
| FR-7.5 | 便携版 node 引导按目标平台选择归档：POSIX 取 `node-v<ver>-<platform>-<arch>.tar.gz`（`--strip-components=1` 解压）；Windows 取 `node-v<ver>-win-<arch>.zip` 并平铺出 `node.exe`。下载优先使用 node 自带 fetch，失败再回退平台 curl。 |
| FR-7.6 | 进程与端口发现按平台实现：POSIX 用 `lsof`/`ps`，`ps` 被拒时回退 `pgrep -fl`；Windows 用 `netstat -ano`（LISTENING 行的 owner pid）与 `Get-CimInstance Win32_Process`（pid + 命令行）。「该进程是否在用我的 dsh home」在 Windows 上改用**命令行路径前缀**判定（本地 host 必从 `<dshHome>/runtime/…` 启动）；读不到命令行时返回 false（保守不杀）。 |
| FR-7.7 | 工具发现按平台解析可执行文件：Windows 依次尝试 `.exe`/`.cmd`/`.bat`，PATH 键名用 `Path` 且与 `PATH` 保持一致，`.cmd` 垫片经 shell 执行；登录 shell 探测在 Windows 上改用 PowerShell `Get-Command`。仓库内引擎版本校验（node ^22.19 或 ≥24）在三个平台一致生效。 |
| FR-7.8 | 窗口外壳按平台使用不同原生控件：macOS `hiddenInset` + `trafficLightPosition`（左侧红黄绿，壳边框留 84px）；Windows/Linux `hidden` + `titleBarOverlay`（右侧最小化/最大化/关闭，留白改到右侧）。壳边框高度恒为 46px 且等于 overlay 高度。 |
| FR-7.9 | 菜单与托盘按平台挂载：macOS 用应用菜单承载 连接/更新，并提供 Dock 右键菜单；Windows/Linux 用窗口菜单但默认隐藏菜单栏（保留 `CmdOrCtrl` 加速键），操作入口同时出现在托盘菜单。快捷键文案按平台显示 ⌘ 或 Ctrl。 |
| FR-7.10 | 托盘图标按平台选取：macOS 用模板图（黑 + alpha，随菜单栏自动着色）；Windows/Linux 用彩色应用图标缩放到 16px（黑色模板图在深色任务栏不可见）。 |
| FR-7.11 | 三个平台均覆盖双架构：release 工作流产出 macOS `arm64`/`x64` 与 Windows `arm64`/`x64`（含 Windows on ARM）；Linux `arm64`/`x64` 在同一份源码的 Linux 主机上构建（AppImage/deb 不能交叉构建）。CI 在 macOS 与 Windows runner 上分别跑冒烟与打包预检。 |
| FR-7.12 | 安装包命名按平台区分：macOS 保持 `dsh-mac-desktop-<ver>-macos-<arch>.<ext>`（向后兼容既有下载链接）；Windows 为 `dsh-desktop-<ver>-windows-<arch>-setup.exe` / `-portable.exe` / `.zip`；Linux 为 `dsh-desktop-<ver>-linux-<arch>.<ext>`，但**架构名按格式不同**——AppImage 用 `x86_64`、deb 用 `amd64`（`arm64` 两者一致），由 `build.appImage` / `build.deb` 各自的 `artifactName` 决定。**顶层 `artifactName` 是 macOS 命名**，只依赖它会产出带 `-macos-` 后缀的错误文件名。 |
| FR-7.13 | 冒烟测试必须跨平台：不得依赖 `/bin/sh`、`/bin/echo`、`/bin/sleep`、`/bin/zsh` 等 POSIX 路径；子进程测试统一用当前 node 执行内联脚本。当宿主拒绝进程枚举（沙箱、无 Full Disk Access）时，依赖枚举的断言降级跳过并显式提示，而不是报失败。 |
## 4. 关键边缘场景

| 场景 | 处理 |
|---|---|
| 两个窗口同时连接不同 SSH 设备，均配置 3080 本地转发 | 转发端口通过进程内预留顺延，远端服务本身由 OS 分配端口。 |
| 开发版与已安装版同时运行 | 开发版 userData 与 DSH_HOME 均在 `~/.dsh-dev`，web 服务使用 `--port 0`，无固定端口争用。 |
| Harness 更新/服务重启期间新建窗口 | 新窗口未绑定终端，默认连接页，不加载旧端口，不会白屏；工具栏仍可切换页面。 |
| harness 因外部因素重启（插件安装、进程内重载、外部托管服务换端口、远端服务崩溃） | 自管服务退出由 close watcher 自动重启并发布新端口；其余场景由健康看门狗连续两次探测失败后自动 `connect()` 重连，窗口无缝刷新到新 URL，无需手动重连。 |
| 终端 B 更新中，用户切到已打开的 A 或新终端 | 不弹锁：取消 B 任务，关闭/重绑 B 窗口，聚焦目标窗口；旧服务继续运行，更新可重试。 |
| 窗口 A 保存本地 repo 后，窗口 B 再打开设置 | 保存后重载该设备所有窗口的设置面板，防止旧表单回写。 |
| 启动时恢复窗口 | 从 `window-state.json` 恢复上次活跃设备和 bounds，不影响 settings 里的 activeDeviceId。 |
| 两个壳实例同时安装官方产物 | 本地 `mkdir` 锁；远端 owner+时间戳锁，stale 后回收。 |
| 同一设备后台窗口正在安装产物，前台窗口点击更新 | 按设备 busy 检测，菜单禁用并弹提示。 |
| 产物安装中 Cmd+Q / 托盘退出 | 直接 teardown 子进程；staging 目录与运行服务隔离，杀安装安全，下次启动重建。 |
| SSH session 因切设备被 stop，旧重试定时器到点 | 检查 session 仍注册且仍有窗口，否则丢弃。 |
| 隧道建立超时 | 杀死本次超时子进程后再报错，防止半死隧道占端口。 |
| 更新管理 tab 晚打开 | `updates:get-log` 回填 connection log ring 并滚动到底。 |
| 插件是 `github:owner/repo` 或 `file:./plugin` | 不查询 npm `/latest`，按原 spec 执行安装；检查时提示“自定义安装源”。 |
| 官方产物安装失败 | current 不被切换，失败版本目录被移除，旧服务继续运行。 |
| 新 runtime 启动失败 | 自动切回 manifest.previous 并重启旧 runtime，更新行显示回滚状态。 |
| 用户手动回滚 | 菜单「回滚 Harness…」切回上一版本并重置/重连后端。 |

## 5. 验收标准

- `node scripts/smoke.js` 在 macOS、Windows 与 Linux 上全部通过（含平台原语断言：
  可执行文件命名、home 展开、node 分发归档形状、`current` 指针原子切换、
  netstat/CIM 解析、npm 定位、ssh 配置路径、干净子进程 PATH、killTree 幂等）。
- `DSH_DESKTOP_SMOKE=1 npx electron .` 输出 `ok:true`。
- `npm run dist:win:x64` 与 `npm run dist:win:arm64` 各产出一份 NSIS 安装包、
  一份便携版与一份 zip，命名符合 FR-7.12。
- `npm start` 后 `~/.dsh-dev/settings.json` 与 `~/.dsh-dev/logs/` 正常生成，不触碰
  `~/Library/Application Support/DeepSeek Harness`。
- 主窗口顶部 46px 工具栏：macOS 可见红黄绿按钮且未与品牌区重叠；Windows
  可见右上角原生窗口控件、未与「新建窗口」或状态区重叠。Linux 走与 Windows 相同的
  `hidden` + `titleBarOverlay` 分支，但 `shell.css` 目前只写了
  `:root[data-platform="windows"]` 规则，Linux 仍套用 macOS 的左侧 84px 留白、
  右侧未避让原生控件——**属已知缺口，见 README「Known limitations」**。
- 更新管理 tab 滚动顺序为：运行组件 → 更新源 → 固定高度日志。
- 新建 npm 插件时，直接粘贴 `dsh plugin --profile web add github:owner/repo` 可保存并执行。
- smoke 实际启动 `dsh web --port 0`，断言回读端口 > 0；`window-state.json` 可恢复 last-active 设备与 bounds。

## 10. Android 客户端（`android/`）

> 独立原生客户端，与桌面壳共享**远端协议**但不共享代码。产品说明见
> [android/README.md](../android/README.md)。

| 编号 | 需求 |
|---|---|
| FR-10.1 | 支持两种连接模式：SSH 远程（本机开隧道 + 托管远端服务）与直接地址（只加载已有 URL）。 |
| FR-10.2 | SSH 必须复用桌面壳的远端协议：登录 shell 探测（`getent passwd` 第 7 列）、sentinel 包裹、`~/.dsh/desktop-web.state.json` 读写、`curl -sL` 探活、`setsid` 后台启动 `--port 0`、`rehostUrl` 重宿令牌。 |
| FR-10.3 | 复用判定：`state.version == manifest.json#current` 且端口探活通过；令牌被服务拒绝（单跳 401/403）时才重启服务换新令牌。 |
| FR-10.4 | 启动新服务前必须清理**本 home** 的残留 `dsh web`（`usesHome` 限定），不得误杀他人实例。 |
| FR-10.5 | 本地转发端口由 JSch 自行分配并回报，禁止「先探测再绑定」的竞态。 |
| FR-10.6 | 连接工作必须离开主线程（`Dispatchers.IO`）：主线程 socket 会抛 `NetworkOnMainThreadException` 并被探活吞成「隧道超时」。 |
| FR-10.7 | 就绪后每 4s 探活，连续 2 次失败自动整链重连；隧道/服务换端口后必须把新 URL 推给 WebView。 |
| FR-10.8 | 布局按**窗口**尺寸判定：≥720dp 且宽大于高双栏（左侧 264dp 常驻终端栏 + 右侧 Harness），否则单栏路由栈。 |
| FR-10.9 | 手机单栏：终端列表 ⇄ Harness 全屏；返回键在页面有历史时回退页面，否则回列表。 |
| FR-10.10 | 平板双栏：切换终端不重建 Harness 视图，仅换 URL；启动时自动连接上次使用的终端。 |
| FR-10.11 | Harness 页仅在连接 ready **且**页面加载完成后显示；连接中/失败/未连接一律由壳面板占位，不出现白屏。 |
| FR-10.12 | 文档启动即注入缺失 JS API 兼容层（`Promise.withResolvers`、`AbortSignal.any`、`findLast`、`toSorted`、`structuredClone`），只补齐缺失者。 |
| FR-10.13 | WebView 主版本 < 99 时显示可操作的升级提示面板，而不是空白页。 |
| FR-10.14 | WebView 只加载回环转发地址；其余 http(s) 与所有非 web scheme 交给系统浏览器/处理器。 |
| FR-10.15 | 连接期间以前台服务持有进程；服务不保存连接状态（单一是 ConnectionManager）。 |
| FR-10.16 | 私钥只存应用私有目录（0600），不在 UI 回显；口令单独保存。 |
| FR-10.17 | 连接日志（300 行环形缓冲）必须在应用内可读、可选中复制——手机上这是唯一排障入口。 |
| FR-10.18 | 设备与密钥以单个 JSON 文档持久化；损坏时按空列表归一化，不崩溃。 |

