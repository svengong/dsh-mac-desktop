# dsh-mac-desktop

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 应用的 macOS 桌面壳，交互模型参考 VS Code Remote：双击图标，Harness Web UI 即可在 `http://127.0.0.1:<端口>` 访问——来自**本机检出**或**SSH 远程机器**。

壳是**薄包装**：只加载固定 URL，只对 harness 仓库执行 git/pnpm。升级 harness 永远不碰壳——更新后只需刷新页面。

## 核心特色

- **本地 / SSH 远程静默部署驻留程序**——连上即自动把 harness 驻留服务（`dsh web`）部署并保持在最新版本：自动克隆/拉取、构建、启停、每次重连自动升级到当前版本，全程无需登录服务器、无需手工步骤。**远程不需要系统工具链**：缺 node/pnpm 时自动在远端 `~/.dsh-tools` 引导便携版工具链。
- **多窗口，VS Code Remote 风格**——一个窗口一个工作区；同设备窗口共享一个后端；任意窗口可切换到任意 SSH 主机。
- **更新友好**——官方预构建产物优先、源码构建兜底；版本化运行时原子切换 + 启动失败自动回滚；更新经独立进程执行，**关掉壳也会继续完成**，崩溃后可续跑。

## 功能

- **本地模式**：从本机检出提供服务（缺失时自动克隆），使用独立隔离的 dsh home。
- **SSH 远程模式**：直接选 `~/.ssh/config` 主机别名（HostName/User/Port/IdentityFile/ProxyJump/Include 全部生效）或输入 `[user@]host[:port]`；自动克隆、`ssh -N -L` 隧道自动保活重连、经 ssh 启停远端服务。要求免密登录。
- **壳内加载面板**：连接/构建/更新期间实时状态与日志，失败可在面板内重试。
- **菜单栏托盘 + 程序坞**：不开窗口也能看状态、待更新数、做更新管理。
- **macOS 原生体验**：工作区边框 + 嵌入设置面板，浅/深色跟随系统，设置与更新源按设备隔离。
- **数据隔离**：harness 运行在壳自己的 dsh home 下，不触碰你真实的 `~/.dsh` 与已安装应用数据。
- **启动自动检查**：发现更新发 macOS 通知（每轮启动去重一次，按设备保存）。

## 快速开始

```sh
cd desktop-shell
bash scripts/build.sh
bash scripts/install.sh
open '/Applications/DeepSeek Harness.app'
```

首次启动弹出连接设置：选「本地」或「SSH 远程」，点「保存并连接」。首次连接自动执行初始化构建（pull → install → build → 启动）；日常升级走顶部菜单「更新」。

> 预写一个 SSH 设备，首次启动免配置：
>
> ```sh
> bash scripts/install.sh --ssh <你的ssh别名>
> ```

## 文档

- [架构文档](docs/architecture.md)——模块地图、端口与进程策略、驻留程序自动升级、打包发布。
- [需求文档](docs/requirements.md)——功能需求、边缘场景、验收标准。
- [开发文档](docs/development.md)——开发约定、测试、新版本发布验证。
- [Agent 文档](docs/agent.md)——后续编码 Agent 的不变量、速查与常见坑。
- [开发计划](docs/roadmap.md)——阶段总览；移动端（手机 SSH 连 Linux）分阶段计划。

## 已知限制

- 仅 macOS；产物未签名（首次启动 macOS 可能要求确认）。
- SSH 模式必须免密登录；没有终端，密码交互无法工作。
- 本地模式的「服务日志」只覆盖壳自管进程。
