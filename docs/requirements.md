# DSH 桌面壳需求文档

> 状态：已实现
> 版本：0.1.0
> 更新日期：2026-08-16

## 1. 产品目标

DeepSeek Harness 桌面壳（dsh-desktop-shell）是 macOS 上的薄桌面壳：把
DeepSeek Harness Web UI 稳定地暴露在 `http://127.0.0.1:<端口>`。业务形态参考
VS Code Remote——用户可以选择本机 checkout 或 SSH 远程主机运行 Harness，壳只
负责连接、构建、更新和启动，不承载任何产品页面逻辑。

## 2. 范围

### 2.1 在范围内

- 本地模式：git clone / 首次构建 / 启动 `dsh web` / 端口回退 / 数据目录隔离。
- SSH 远程模式：`~/.ssh/config` 主机选择、远端 clone、隧道保活、远端服务启停与重置。
- 多窗口工作区模型：窗口 ↔ 设备 session 绑定，同设备窗口共享后端。
- 统一更新管理：Harness 本体、npm 插件、Git 预设。
- 初始化构建、更新与进度/日志窗口。
- macOS 菜单栏、托盘、程序坞唤醒。
- macOS 风格的壳边框与嵌入式设置面板。
- 开发态与已安装应用的数据隔离。

### 2.2 不在范围内

- 非 macOS 平台。
- 密码交互式 SSH（只支持免密登录）。
- 壳自身自更新（升级 harness 不需要升级壳）。
- 任意 shell 脚本执行（用户自定义组件只允许 `dsh plugin add <spec>` 与 Git 预设两类）。

## 3. 核心需求

### FR-1 工作区与多窗口

| 编号 | 需求 |
|---|---|
| FR-1.1 | 每个 BrowserWindow 是一个工作区，初始绑定 `local` 设备。 |
| FR-1.2 | 同设备的多窗口共享一个后端 session；不同设备各有独立隧道/服务/更新状态。 |
| FR-1.3 | 新窗口默认本地；可从菜单栏、Dock 菜单、托盘创建。 |
| FR-1.4 | 关闭窗口只隐藏，Cmd+Q 才退出；退出前必须停止壳自管子进程。 |
| FR-1.5 | 任一窗口修改设备连接设置后，同设备其他窗口的设置面板不得保留旧表单。 |
| FR-1.6 | 任意窗口发起初始化构建/更新时，全局只允许一个构建/更新任务；菜单、托盘和 IPC 都要阻止并发任务。 |
| FR-1.7 | 窗口切换设备时，必须避免旧设备页面闪现，并释放不再被引用的 SSH session。 |
| FR-1.8 | 服务就绪、隧道/服务重启后，所有等待中的同设备窗口都要跟随真实端口刷新。 |

### FR-2 连接与端口

| 编号 | 需求 |
|---|---|
| FR-2.1 | 本地/SSH 转发/远端服务端口均为“优先端口”，空闲则使用，占用则从该端口起顺延最多 30 个端口。 |
| FR-2.2 | 壳内所有“先探测后绑定”的分配必须做进程内预留，避免两个 session 同时选中同一回退端口。 |
| FR-2.3 | 同一远端主机的远端端口分配必须串行化，并跳过本进程已预留端口。 |
| FR-2.4 | 旧版本/残留服务按 state 文件（pid/port/version）回收；版本匹配且仍为 DSH 服务时可复用。 |
| FR-2.5 | 所有子进程必须是壳的进程组，断开/切换时不能遗留 SSH 隧道。 |
| FR-2.6 | 连接失败自动重试 2 次；session 已被停止后，挂起的重试定时器不得复活 session。 |
| FR-2.7 | 端口设置允许 1–65535；0 与非法值回退默认 3080。 |

### FR-3 数据与进程隔离

| 编号 | 需求 |
|---|---|
| FR-3.1 | 开发态（`electron .` / `npm start`）Electron userData 固定为 `~/.dsh-desktop`，不读写已安装应用的 `~/Library/Application Support/DeepSeek Harness`。 |
| FR-3.2 | 可通过 `DSH_DESKTOP_USER_DATA` 覆盖 userData（支持 `~/...`）。 |
| FR-3.3 | 本地服务默认 `DSH_HOME=~/.dsh-desktop`，与终端用户常用 `~/.dsh` 完全分离。 |
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

### FR-5 macOS 壳 UI

| 编号 | 需求 |
|---|---|
| FR-5.1 | 主窗口使用 `hiddenInset` 标题栏，壳自绘 46px 工具栏，原生红黄绿按钮在工具栏左上角。 |
| FR-5.2 | 字体使用 SF Pro / PingFang SC 系统栈，等宽使用 SF Mono / Menlo；13px 正文、11–12px 辅助信息。 |
| FR-5.3 | 颜色、控件高度（20–28px）、圆角（5–10px）、间距遵循 macOS HIG；浅/深色跟随 `prefers-color-scheme`。 |
| FR-5.4 | 按钮有 hover/active/disabled 状态与焦点环；动画遵循 `prefers-reduced-motion`。 |
| FR-5.5 | 工具栏可拖拽，按钮/输入框为 no-drag。 |
| FR-5.6 | UI 只使用系统资源，不依赖在线字体或图标资源。 |

### FR-6 可靠性

| 编号 | 需求 |
|---|---|
| FR-6.1 | 构建/更新进行中禁止退出、禁止第二次构建/更新、禁止重置/重连后端。 |
| FR-6.2 | 构建检查失败直接进入连接错误路径，不进入无意义的初始化流水线。 |
| FR-6.3 | 设置文档损坏时按默认值归一化，不崩溃。 |
| FR-6.4 | 日志落盘 + 窗口内 300 行 ring buffer；设置面板晚创建也能回填最近日志。 |
| FR-6.5 | 全部 IPC 只返回 JSON-safe 数据；渲染器无 Node 权限（sandbox + contextIsolation）。 |

## 4. 关键边缘场景

| 场景 | 处理 |
|---|---|
| 两个窗口同时连接不同 SSH 设备，均配置 3080 | 第二个设备自动使用 3081 起空闲端口；本地/远端分配均有预留。 |
| 开发版与已安装版同时运行 | 开发版 userData 与 DSH_HOME 均在 `~/.dsh-desktop`，端口冲突自动回退。 |
| 窗口 A 保存本地 repo 后，窗口 B 再打开设置 | 保存后重载该设备所有窗口的设置面板，防止旧表单回写。 |
| 后台窗口正在 build，前台窗口点击更新 | 全局 busy 检测，菜单禁用并弹提示。 |
| build 中 Cmd+Q / 托盘退出 | `before-quit` 与 actions.quit 双重拦截，展示进度窗口并提示等待。 |
| SSH session 因切设备被 stop，旧重试定时器到点 | 检查 session 仍注册且仍有窗口，否则丢弃。 |
| 隧道建立超时 | 杀死本次超时子进程后再报错，防止半死隧道占端口。 |
| 更新管理 tab 晚打开 | `updates:get-log` 回填 connection log ring 并滚动到底。 |
| 插件是 `github:owner/repo` 或 `file:./plugin` | 不查询 npm `/latest`，按原 spec 执行安装；检查时提示“自定义安装源”。 |

## 5. 验收标准

- `node scripts/smoke.js` 全部通过。
- `DSH_DESKTOP_SMOKE=1 npx electron .` 输出 `ok:true`。
- `npm start` 后 `~/.dsh-desktop/settings.json` 与 `~/.dsh-desktop/logs/` 正常生成，不触碰
  `~/Library/Application Support/DeepSeek Harness`。
- 主窗口顶部 46px 工具栏可见红黄绿按钮，未与品牌区重叠。
- 更新管理 tab 滚动顺序为：运行组件 → 更新源 → 固定高度日志。
- 新建 npm 插件时，直接粘贴 `dsh plugin --profile web add github:owner/repo` 可保存并执行。
