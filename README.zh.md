# DeepSeek Harness 桌面壳

[English](README.md) | 中文

DeepSeek Harness Web 应用的 macOS 桌面壳，交互模型参考 VS Code Remote：双击图标，壳让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 在 `http://127.0.0.1:<端口>` 可访问——要么来自本机检出，要么通过 SSH 隧道来自远程机器。

壳是**薄包装**：只加载固定 URL、只对仓库执行 git/pnpm。升级 harness 源码永远不碰壳，更新后壳只需刷新页面。

本目录是桌面壳的产品目录；本地模式默认使用本目录下的 `deepseek-harness/` 检出（该目录是 harness 的独立 clone），不再把壳代码放在 harness 仓库里。

## 功能

- **本地模式**：默认使用本产品目录下的 `deepseek-harness/` 检出；壳**总是启动自己的** `apps/cli/lib/bin.js web` 实例——配置端口空闲就用它，被占用则自动用下一个空闲端口——且使用**独立的数据目录**（默认 `~/.dsh-desktop`）：会话、设置、profiles、凭据与本机其他 harness 实例完全隔离（首次使用时从 `~/.dsh` 播种凭据）。可填「仓库地址」（git URL）：目录不存在或不是 git 仓库时自动克隆。所有本地子进程使用壳自建的环境变量（见下），不依赖 launchservices PATH。
- **SSH 远程模式**：在设置里直接下拉选择 `~/.ssh/config` 的主机别名（HostName/User/Port/IdentityFile/ProxyJump 全部自动生效，`Include` 也会被解析），或输入自定义 `[user@]host[:port]`；远程目录不存在时壳在远端 git clone，隧道 `ssh -N -L` 自动保活重连，远程 web 服务经 ssh 启停。要求免密登录。**远程不需要系统工具链**：缺少或不兼容时，壳会在远端 `~/.dsh-tools` 引导便携版 node 和仓库 pin 版本的 pnpm。
- **多窗口**：菜单栏、程序坞右键菜单和托盘均可新建窗口；新窗口默认打开本地工作区（同设备窗口共享一个后端，像多开一个 Web 标签），每个窗口可在连接设置中切换到任意 SSH 设备；不同窗口连接不同设备时各自持有独立的隧道/服务与更新状态，互不干扰。


  - **启动自动检查**：默认开启；连接就绪后壳在后台检查该设备自己的所有组件，发现更新时发 macOS 通知，同一批更新在本轮启动内只提示一次，开关与去重状态按设备分别保存。

- **自包含工具链**：node 候选按仓库 engine 范围（^22.19 || >=24）过滤，过期的 brew node 不会误选；没有兼容 node 时下载便携版 node 到 `<仓库>/.dsh-tools/node`；没有可用 pnpm 时用 npm 把仓库 pin 的 pnpm 装进 `<仓库>/.dsh-tools`。本地子进程的 `PATH = node 目录 + .dsh-tools + 仓库 node_modules/.bin + 系统基础目录`，与登录环境无关；远程在 `~/.dsh-tools` 做同样的引导。
- **状态可见**：主窗口标题统一为 `DSH-[终端]-地址`（如 `DSH-[本地]-http://127.0.0.1:3080`、`DSH-[ubuntu]-…`），设置页与顶部菜单同样带终端标识，托盘常驻状态。更新/初始化构建窗口成功后自动关闭（日志已落盘），失败则保留窗口并附重试/复制按钮。
- **菜单栏托盘**：常驻状态（模式/地址/详情）与待更新数量，不开主窗口也能打开更新管理/检查/更新全部/仅更新 Harness/退出。
- **程序坞唤醒**：点击程序坞图标先显示短暂的按下态图标，再遵循 macOS 窗口还原行为——最小化窗口以系统动画还原，关闭后隐藏会重新显示，尚未打开则重新创建。
- **工作区边框**：主窗口顶部有固定 DSH 边框，可在 Harness、连接、更新管理、高级之间直接切换；设置作为嵌入面板打开，后续新增管理页只需向边框注册一个栏目。
- **npm 插件安装兼容 pnpm add 全语法**：更新源中可直接粘贴完整官方命令 `dsh plugin --profile web add <spec>`，也可以只填 `<spec>`；裸 npm 包、`@scope/pkg@tag`、`github:owner/repo`、`file:./plugin`、tarball 等都会经官方 CLI 安装，自定义 registry 同时作用于版本检查和安装。
- **版本化运行时与回滚**：Harness 更新先在 `<dshHome>/runtime/<version>`（远端 `~/.dsh/runtime/<version>`）做 staging build，成功后原子切换 `current`，旧版本保留；新版本启动失败自动回滚，更新菜单也可手动「回滚 Harness」。
- **开发态完全隔离**：`npm start` / `electron .` 的开发实例把 Electron userData 固定为 `~/.dsh-desktop`（与服务数据目录一致），不会读写已安装应用的 `~/Library/Application Support/DeepSeek Harness`；需要时用 `DSH_DESKTOP_USER_DATA` 覆盖。本地端口、SSH 本地转发端口与远端端口均为优先端口，占用时自动顺延，壳内探测会做进程内预留，避免多窗口同时抢同一回退端口。
- **每个窗口独立的 macOS 风格设置**：连接、更新管理、高级工具路径作为嵌入面板绑定到所属主窗口，并使用与 macOS 一致的浅色/深色外观（`prefers-color-scheme`）。连接设置、更新源与自动检查按设备隔离：切换窗口连接的新设备就从该设备自己的设置开始，不会带上另一台设备的插件或通知状态。


- 关闭窗口只是隐藏（macOS 习惯）；Cmd+Q 退出时只停掉壳自己拉起的服务。

## 布局

```
desktop-shell/
├── deepseek-harness/    本地 harness 检出（独立 clone，默认 repoDir）
├── src/
│   ├── main.js            main process: lifecycle, workspace frame wiring, IPC handlers
│   ├── settings.js        settings store (userData/settings.json)
│   ├── window-manager.js  window bounds/active-view/last-active persistence
│   ├── runtime-store.js   local/remote service state, URL/port parsing, clone/build locks
│   ├── ports.js           SSH local-forward port reservation + TCP probe
│   ├── labels.js          shared DSH-[终端] labels for titles/menus/tray
│   ├── shell-preload.js   preload for the local workspace frame
│   ├── dialogs.js         embedded settings panel + progress windows
│   ├── components.js      update-component catalog + version/hash helpers
│   ├── update-manager.js  unified check/update logic for all components
│   ├── connection.js      local + ssh connection lifecycle, port-0 service, tunnel, remote service
│   ├── update.js          harness check / update-and-restart pipeline, .dsh-tools pnpm bootstrap
│   ├── runner.js          foreground command runner + detached service spawner
│   ├── ssh.js             ssh target parsing, quoting, remote-path rendering
│   ├── tools.js           engine-aware node/pnpm discovery + clean child environment
│   └── ui/                shell.html (workspace frame), settings.html, progress.html, shell.css

├── build/                 icon.icns, icon.png, iconPressed.png, tray template icons (committed)
└── scripts/               gen-icons.sh, build.sh, install.sh, smoke.js, e2e-local.js, e2e-ssh.js
```

本目录独立于 harness 仓库，保留自己的 npm install，产品依赖图不受影响。

## 先决条件

- macOS（壳仅支持 macOS：菜单、托盘、应用包）。
- **不要求**本机或远端预装 Node.js 22.19+ 与 pnpm：缺失或不兼容时，壳会自动在 `.dsh-tools` 引导便携版 node 与仓库 pin 版 pnpm。
- SSH 模式：必须免密登录远端（`ssh <目标>` 必须能无提示直接成功）；`StrictHostKeyChecking=accept-new` 会记录新主机密钥，但密钥变化仍会拒绝。macOS 15+ 首次连局域网设备会弹「本地网络」权限提示，需点允许，否则局域网 ssh 报 "No route to host"。

## 使用

```sh
cd desktop-shell
bash scripts/build.sh
bash scripts/install.sh
```

`build.sh` 会执行 npm install、重新生成图标并用 electron-builder 构建应用；`install.sh` 把应用包复制到 /Applications。

首次启动弹出连接设置：选「本地」（仓库目录 + 端口）或「SSH 远程」（`~/.ssh/config` 主机别名、远程仓库地址、远程目录、远程端口、本地转发端口），点「保存并连接」。当 `apps/cli/lib/bin.js` 不存在时，首次连接会自动执行初始化构建（可 pull 则先 pull → install → build → 启动）。此后日常升级走顶部菜单「更新」。连接设置、更新源与启动自动检查按设备保存：切到新的 SSH 主机或本地时，更新管理只显示该设备自己的 Harness 与插件源，不会沿用上一台设备。

端口说明：本地和远端 `dsh web` 都由壳传 `--port 0`，由 OS 分配端口；CLI 打印 `dsh web: http://127.0.0.1:<端口>`，壳解析后写 state 并让主窗口跟随实际端口，因此不再有“配置端口被占用”的探测竞态。SSH 模式的本地转发端口仍由壳持有：优先用设置的 `localPort`，占用时自动顺延；远程服务端口旧设置仅作兼容保留。

## 升级不改壳的契约

壳只依赖三个稳定产品面：

1. 固定 URL `http://127.0.0.1:<端口>`（Web 应用的服务契约），
2. 仓库入口 `apps/cli/lib/bin.js web --port <n>`（已构建的 CLI 入口），
3. git + pnpm 工具链。

前端产物、插件组合、预设如何变化都不影响壳。壳自身没有自更新框架——万一壳本身要改，从本目录重建重装即可。

## 文档

- [需求文档](docs/requirements.md)：功能需求、边缘场景、验收标准。
- [开发文档](docs/development.md)：模块架构、端口策略、测试与提交约定。
- [Agent 文档](docs/agent.md)：后续编码 Agent 的不变量、速查与常见坑。

## 已知限制

- 仅 macOS；未做签名/公证（本地自用，首次启动 macOS 可能要求确认）。
- SSH 模式必须免密登录；没有终端，密码交互无法工作。
- 本地模式的「服务日志」只覆盖壳自管进程；外部启动的服务日志在别处。
- 托盘图标即 favicon 鲸鱼（黑色模板图，跟随菜单栏深浅色），与网页标签一致。
- 重新生成图标（`scripts/gen-icons.sh`）需要 Chrome/Edge 做透明 SVG 栅格化；仓库已提交成品图标，不重跑也能用。
