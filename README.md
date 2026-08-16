# DeepSeek Harness Desktop Shell

English | [中文](README.zh.md)

A macOS desktop shell for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web app, modeled on VS Code Remote Development: double-click the app icon, and the shell makes the harness web UI reachable at `http://127.0.0.1:<port>` — either from a local checkout or from a remote machine over an SSH tunnel.

The shell is a **thin wrapper**: it only loads a fixed URL and runs git/pnpm on the repo. Upgrading the harness source never touches the shell — after an update the shell just reloads the page.

This directory is the desktop-shell product directory. Local mode defaults to the `deepseek-harness/` checkout under this directory (an independent clone of the harness repository); the shell code no longer lives inside the harness repository.

## Features

- **Local mode**: defaults to the `deepseek-harness/` checkout under this product directory; the shell always starts its own `apps/cli/lib/bin.js web --port <port>` instance — on the configured port when free, on the next free port when something else already listens — under its **own dsh home** (default `~/.dsh-desktop`): sessions, settings, profiles, and credentials are completely isolated from any other harness instance on the machine (seeded from `~/.dsh` on first use). An optional repo URL makes the shell clone the repo into the directory when it is missing or not a git repo. All local children run under a clean, self-built environment (see below), independent of the launchservices PATH.
- **SSH remote mode** (VS Code Remote style): pick a host alias from `~/.ssh/config` in the settings dialog (HostName/User/Port/IdentityFile/ProxyJump all apply automatically, `Include` is followed), or enter a custom `[user@]host[:port]`; the shell clones the repo on the remote when missing, keeps a `ssh -N -L` tunnel alive, and starts/restarts the remote web service over ssh. Requires key-based (passwordless) ssh login. The remote needs no system toolchain: the shell bootstraps a portable node and the repo-pinned pnpm into `~/.dsh-tools` on the remote when they are missing or incompatible.
- **Multi-window**: the app menu, Dock menu, and tray can create a new window; new windows start on the local workspace (windows on the same device share one backend, like opening another web tab), and each window can switch to any SSH device from its connection settings. Windows on different devices own independent tunnels, services, and update state.


  - **Startup auto-check**: enabled by default; after the connection reaches `ready` the shell checks that device's own components in the background and shows a macOS notification when updates are available. The prompt is deduplicated per available set until the next launch, and the toggle and dedupe state are stored per device.
- **Self-contained toolchain**: node candidates are filtered by the repo's engine range (^22.19 || >=24), so a stale brew node never wins; when no compatible node exists, the shell downloads the portable node tarball into `<repo>/.dsh-tools/node`; when no pnpm runs, it installs the repo-pinned pnpm into `<repo>/.dsh-tools` via npm. Local children get `PATH = node dir + .dsh-tools + repo node_modules/.bin + system base`, never the launchservices PATH. The same bootstrap runs on the remote into `~/.dsh-tools`.
- **Visible state**: the main window title shows the live URL/port, the settings dialog shows the current connection, and the menu-bar tray carries the status. The update/init progress window closes itself on success (the log stays in the file), and stays open with retry/copy buttons on failure.
- **Menu-bar tray**: connection status plus the same update-manager entries (open / check / update all / harness-only) without the main window; the tooltip shows the pending update count.
- **Dock activation**: clicking the Dock icon shows a brief pressed-icon state, then follows macOS window restoration — minimized windows deminiaturize with the system animation, hidden windows are shown again, and a missing window is recreated.

- **One macOS-style settings window per workspace**: connection, update manager, and advanced tool paths live behind one source-list sidebar bound to its owning main window; the window uses an inset title bar, traffic-light-safe layout, and the same appearance as macOS — light and dark follow the system automatically (`prefers-color-scheme`). Connection settings, update sources, and auto-check are scoped per device: switching a window to a new target starts from that device's own settings and never carries over another device's plugins or notification state.

- Closing the window hides it (macOS convention); Cmd+Q quits and stops only services the shell started.

## Layout

```
desktop-shell/
├── deepseek-harness/    local harness checkout (independent clone, default repoDir)
├── src/
│   ├── main.js            main process: lifecycle, menu/tray wiring, IPC handlers
│   ├── settings.js        settings store (userData/settings.json)
│   ├── components.js      update-component catalog + version/hash helpers
│   ├── update-manager.js  unified check/update logic for all components
│   ├── connection.js      local + ssh connection lifecycle, port fallback, tunnel, remote service
│   ├── update.js          harness check / update-and-restart pipeline, .dsh-tools pnpm bootstrap
│   ├── runner.js          foreground command runner + detached service spawner
│   ├── ssh.js             ssh target parsing, quoting, remote-path rendering
│   ├── tools.js           engine-aware node/pnpm discovery + clean child environment

├── build/                 icon.icns, icon.png, iconPressed.png, tray template icons (committed)
└── scripts/               gen-icons.sh, build.sh, install.sh, smoke.js, e2e-local.js, e2e-ssh.js
```

This directory is independent of the harness repository and keeps its own npm install, so the product dependency graph stays untouched.

## Prerequisites

- macOS (the shell is macOS-only: menu, tray, app bundle).
- Node.js 22.19+ and pnpm are **not** required on the machine or the remote: the shell bootstraps a portable node and the repo-pinned pnpm into `.dsh-tools` when they are missing or incompatible.
- SSH mode: passwordless key login to the remote (`ssh <target>` must work without a prompt); `StrictHostKeyChecking=accept-new` records new host keys but still rejects changed ones. On macOS 15+, the first LAN connection triggers the system's Local Network permission prompt — allow it, otherwise LAN ssh attempts fail with "No route to host".

## Usage

```sh
cd desktop-shell
bash scripts/build.sh
bash scripts/install.sh
```

`build.sh` runs npm install, regenerates the icons, and builds the app with electron-builder; `install.sh` copies the bundle to /Applications.

First launch opens the connection settings dialog. Pick 本地 (repo dir + port) or SSH 远程 (a host alias from `~/.ssh/config`, remote repo url, remote dir, ports), then 保存并连接. The first connection runs an initialization build (pull if possible → install → build → start) when `apps/cli/lib/bin.js` is missing. After that the top menu 「更新」 handles routine upgrades. Connection settings, update sources, and startup auto-check are stored per device: switching to a new SSH host or to local starts 更新管理 from that device's own harness row and plugin sources, never from the previous device.

Ports: in local mode the configured 端口 is a **preferred port** — the shell uses it when free and otherwise falls back to the next free port (for example when a terminal already runs `dsh web`); it always passes the actual port as `--port` to `dsh web`, which overrides the web profile's `webserver.port`, and the main window follows the actual port. In SSH mode the shell fully owns 本地转发端口; 远程端口 must match the remote web profile.

## Design contract (why upgrades never touch the shell)

The shell depends on exactly three stable product surfaces:

1. the fixed URL `http://127.0.0.1:<port>` (the web app's serving contract),
2. the repo layout `apps/cli/lib/bin.js web --port <n>` (the built CLI entry),
3. git + pnpm as the update toolchain.

Everything else — the frontend dist, plugin composition, presets — changes freely underneath. The shell itself has no auto-update framework: when a shell change is ever needed, rebuild and reinstall from this directory.

## Known limitations

- macOS only; no code signing/notarization (local use — macOS may ask to confirm on first launch).
- SSH mode requires key-based auth; password prompts cannot work without a terminal.
- 服务日志 for local mode only covers the shell-owned process; an externally started server logs elsewhere.
- The tray icon is the favicon whale (black template image), matching the web tab.
- Icon regeneration (`scripts/gen-icons.sh`) needs Chrome or Edge for the transparent SVG raster; the committed icons work without it.
