# dsh-desktop

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 应用的桌面壳，支持 **macOS / Windows / Linux**，交互模型参考 VS Code Remote：双击图标，Harness Web UI 即可在 `http://127.0.0.1:<端口>` 访问——来自**本机**或**SSH 远程机器**。

壳是**薄包装**：只加载固定 URL，只对 harness 运行时执行官方 npm 安装。升级 harness 永远不碰壳——更新后只需刷新页面。

## 平台与架构

| 平台 | 架构 | 安装包 |
|---|---|---|
| macOS 11+ | Apple Silicon（`arm64`）、Intel（`x64`） | `.dmg`、`.zip`、`.app` |
| Windows 10/11 | `x64`、Windows on ARM（`arm64`） | NSIS 安装程序 `.exe`、便携版 `.exe`、`.zip` |
| Linux | `x64`、`arm64` | `.AppImage`、`.deb`（尽力而为） |
| **Android 8.0+** | `arm64-v8a`、`armeabi-v7a`、`x86_64` | `.apk`（手机竖屏 + 平板横屏） |

桌面产物均未签名，首次启动时系统可能要求确认；Android 版为独立原生客户端，见 [android/README.md](android/README.md)。

## 核心特色

- **本地 / SSH 远程静默部署驻留程序**——连上即自动把 harness 驻留服务（`dsh web`）部署并保持在最新版本：自动安装官方产物、启停服务、每次重连自动升级到当前版本，全程无需登录服务器。**远程不需要系统工具链**：缺 node 时自动在远端 `~/.dsh-tools` 引导便携版工具链。
- **多窗口，VS Code Remote 风格**——首个窗口自动恢复当前终端并连接；新建窗口默认停在连接页、不自动连接；每个终端只保留一个已绑定窗口；连接已打开终端时仅切换到已有窗口，当前窗口保持不变。
- **更新友好**——官方预构建产物 + 版本化运行时原子切换 + 启动失败自动回滚；更新经独立进程执行，**关掉壳也会继续完成**，崩溃后可续跑。

## 功能

- **本地模式**：从壳自己管理的 dsh home 提供服务，使用独立隔离的数据目录。
- **SSH 远程模式**：直接选 `~/.ssh/config` 主机别名（HostName/User/Port/IdentityFile/ProxyJump/Include 全部生效）或输入 `[user@]host[:port]`；`ssh -N -L` 隧道自动保活重连、经 ssh 启停远端服务。要求免密登录。
- **壳内加载面板**：连接/安装/更新期间实时状态与日志，失败可在面板内重试。
- **托盘 / 状态区 + 程序坞**：不开窗口也能看状态、待更新数、做更新管理。
- **贴合各平台的原生体验**：46px 壳边框内嵌系统窗口控件（macOS 左侧红黄绿、Windows 右侧最小化/最大化/关闭）、嵌入设置面板、浅/深色跟随系统、设置与更新源按设备隔离。
- **数据隔离**：harness 运行在壳自己的 dsh home 下，不触碰你真实的 `~/.dsh` 与已安装应用数据。
- **启动自动检查**：发现更新发系统通知（每轮启动去重一次，按设备保存）。

## Android 版（手机 / 平板）

`android/` 是同一产品理念的原生 Android 客户端（Kotlin + Compose + WebView + JSch），
不是在手机上跑桌面壳：

- **SSH 远程**：手机上直接连 Linux 机器，自动**复用或启动**远端 `dsh web`，
  JSch 建立本地端口转发，WebView 加载隧道另一端的 Harness UI。协议与桌面壳同源，
  两边的驻留服务可以互相复用。
- **直接地址**：填一个已能访问的 URL（反向代理 / 局域网），不建 SSH、不托管服务。
- **自适应布局**：手机竖屏单栏（终端列表 ⇄ Harness 全屏）；平板横屏双栏
  （左侧常驻终端导航，右侧 Harness）。按**窗口**宽度判定，分屏时自动退回单栏。
- **后台保活**：前台服务持有连接，切到后台隧道不断；就绪后每 4 秒探活，
  连续两次失败自动重连。
- **WebView 兼容层**：文档启动即注入 `Promise.withResolvers` / `AbortSignal.any` 等
  缺失 API，让 Chromium 99+ 的老设备也能跑起来；更老的设备给出明确提示而不是白屏。

详见 [android/README.md](android/README.md)。

## 快速开始

### macOS

```sh
bash scripts/build.sh
bash scripts/install.sh
open '/Applications/DeepSeek Harness.app'
```

### Windows

```powershell
# 同时构建 x64 与 arm64（安装程序 + 便携版 + zip）
powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1

# 或只构建单个架构
npm run dist:win:x64        # Windows on ARM 用 dist:win:arm64
```

安装用 `dist\dsh-desktop-<版本>-windows-<arch>-setup.exe`；免安装用
`-portable.exe`。

### 任意平台（开发态）

```sh
npm install
npm start
```

首次启动弹出连接设置：选「本地」或「SSH 远程」，点「保存并连接」。首次连接自动安装官方运行时并启动；日常升级走「更新」菜单。

> 预写一个 SSH 设备，首次启动免配置（仅 macOS 脚本）：
>
> ```sh
> bash scripts/install.sh --ssh <你的ssh别名>
> ```

## 开发与验证

```sh
npm run smoke                        # 不依赖 Electron 的模块测试（全平台）
DSH_DESKTOP_SMOKE=1 npx electron .   # macOS/Linux 应用内冒烟
npx electron .                       # 启动壳
```

Windows 上用 PowerShell 执行同样的命令；环境变量写法为
`$env:DSH_DESKTOP_SMOKE=1; npx electron .`。

## 文档

- [架构文档](docs/architecture.md)——模块地图、端口与进程策略、驻留程序自动升级、打包发布。
- [需求文档](docs/requirements.md)——功能需求、边缘场景、验收标准。
- [开发文档](docs/development.md)——开发约定、测试、新版本发布验证。
- [Agent 文档](docs/agent.md)——后续编码 Agent 的不变量、速查与常见坑。
- [开发计划](docs/roadmap.md)——阶段总览；移动端（手机 SSH 连 Linux）分阶段计划。

## 已知限制

- 各平台产物均未签名（macOS Gatekeeper / Windows SmartScreen 首次启动可能要求确认）。
- SSH 模式必须免密登录；没有终端，密码交互无法工作。
- 本地模式的「服务日志」只覆盖壳自管进程。
- Windows 上没有 `lsof` 的廉价等价物，「这个进程是否在用我的 dsh home」改用进程命令行的运行时路径判定；判断不出来时壳保持「不杀」。
