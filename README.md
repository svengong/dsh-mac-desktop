# DeepSeek Harness Desktop Shell

English | [中文](README.zh.md)

A macOS desktop shell for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web app, modeled on VS Code Remote Development. Double-click the app icon and the harness web UI is reachable at `http://127.0.0.1:<port>` — from a **local checkout** or from a **remote machine over SSH**.

The shell is a **thin wrapper**: it loads a fixed URL and only ever runs git/pnpm on the harness repo. Upgrading the harness never touches the shell — after an update it just reloads the page.

## Highlights

- **Silent resident deployment, local or SSH-remote** — connect and the harness **resident daemon (`dsh web`) is deployed and kept up to date automatically**: the shell clones (or pulls), builds, starts and restarts the service, and upgrades it to the current version on every reconnect — no shell access, no manual steps. The remote needs **no system toolchain**: a portable node and the repo-pinned pnpm are bootstrapped into `~/.dsh-tools` on the remote automatically.
- **Multi-window, VS Code Remote style** — one window per workspace; windows on the same device share one backend; any window can switch to any SSH host.
- **Update-friendly** — official prebuilt artifacts preferred, source builds as fallback; versioned runtimes with atomic switch and automatic rollback; updates survive shell quit (detached worker) and resume after a crash.

## Features

- **Local mode**: serves the harness from a local checkout (auto-clone when missing) under its own isolated dsh home.
- **SSH remote mode**: pick a host from `~/.ssh/config` (HostName/User/Port/IdentityFile/ProxyJump/Include all apply) or enter `[user@]host[:port]`; auto-clones, keeps the `ssh -N -L` tunnel alive with reconnection, starts/stops the remote service over ssh. Requires passwordless key login.
- **In-shell loading panel**: live status and logs while connecting/building/updating, with retry actions on failure.
- **Menu-bar tray + Dock**: status, pending update count, and update management without opening a window.
- **macOS-native UI**: workspace frame with embedded settings panels, light/dark appearance, per-device settings and update sources.
- **Data isolation**: the harness runs under its own dsh home; your real `~/.dsh` and the installed app's data are never touched.
- **Startup auto-check**: notifies when updates are available (deduplicated per launch, per device).

## Quick start

```sh
cd desktop-shell
bash scripts/build.sh
bash scripts/install.sh
open '/Applications/DeepSeek Harness.app'
```

First launch opens connection settings: pick **本地** (local) or **SSH 远程** (remote), then **保存并连接**. The first connection runs the initialization build (pull → install → build → start) automatically; routine upgrades go through the **更新** menu afterwards.

> Preconfigure an SSH device for a hands-off first launch:
>
> ```sh
> bash scripts/install.sh --ssh <your-ssh-alias>
> ```

## Documentation

- [Architecture](docs/architecture.md) — module map, ports & processes, resident auto-upgrade, packaging/release.
- [Requirements](docs/requirements.md) — functional requirements, edge cases, acceptance criteria.
- [Development](docs/development.md) — development conventions, testing, release verification.
- [Agent](docs/agent.md) — invariants and pitfalls for coding agents.

## Known limitations

- macOS only; builds are unsigned (macOS may ask to confirm on first launch).
- SSH mode requires key-based auth; password prompts cannot work without a terminal.
- The local-mode service log only covers shell-owned processes.
