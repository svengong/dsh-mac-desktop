# dsh-desktop

English | [中文](README.zh.md)

A desktop shell for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web app on **macOS, Windows and Linux**, modeled on VS Code Remote Development. Double-click the app icon and the harness web UI is reachable at `http://127.0.0.1:<port>` — from a **local instance** or from a **remote machine over SSH**.

The shell is a **thin wrapper**: it loads a fixed URL and only ever runs git/pnpm on the harness repo. Upgrading the harness never touches the shell — after an update it just reloads the page.

## Platforms

| Platform | Architectures | Installers |
|---|---|---|
| macOS 11+ | Apple Silicon (`arm64`), Intel (`x64`) | `.dmg`, `.zip`, `.app` |
| Windows 10/11 | `x64`, Windows on ARM (`arm64`) | NSIS `.exe` installer, portable `.exe`, `.zip` |
| Linux (distros still supported by Chromium & vendor — e.g. current Ubuntu/Fedora/Debian) | `x64`, `arm64` | `.AppImage`, `.deb` |
| **Android 8.0+** | `arm64-v8a`, `armeabi-v7a`, `x86_64` | `.apk` (phone portrait + tablet landscape) |

The three desktop platforms share one source tree: every OS-specific difference
lives in `src/platform.js` and `src/process-scan.js`, so Linux is a first-class
target rather than a "happens to run" one. macOS and Windows installers are
produced by the release workflow; Linux packages are built from the same source
on a Linux host (see [Quick start](#quick-start)), since AppImage/deb cannot be
cross-built.

Every desktop build is unsigned, so the OS may ask for confirmation on first
launch. The Android client is a separate native app — see
[android/README.md](android/README.md).

## Highlights

- **Silent resident deployment, local or SSH-remote** — connect and the harness **resident daemon (`dsh web`) is deployed and kept up to date automatically**: the shell installs the official npm artifact, starts and restarts the service, and upgrades it to the current version on every reconnect — no shell access, no manual steps. The remote needs **no system toolchain**: a portable node is bootstrapped into `~/.dsh-tools` on the remote automatically.
- **Multi-window, VS Code Remote style** — the first window restores and connects the current terminal; new windows open on the connection page without auto-connecting; each terminal keeps at most one bound window: connecting to an already-open terminal only switches to that window and leaves the current window untouched, while every other action stays in the current window.
- **Update-friendly** — official prebuilt artifacts preferred; versioned runtimes with atomic switch and automatic rollback; updates survive shell quit (detached worker), resume after a crash, and can be safely cancelled when switching terminals.

## Features

- **Local mode**: serves the harness from a shell-owned dsh home with its own isolated data directory.
- **SSH remote mode**: pick a host from `~/.ssh/config` (HostName/User/Port/IdentityFile/ProxyJump/Include all apply) or enter `[user@]host[:port]`; keeps the `ssh -N -L` tunnel alive with reconnection, starts/stops the remote service over ssh. Requires passwordless key login.
- **In-shell loading panel**: live status and logs while connecting/building/updating, with retry actions on failure.
- **Tray/status area**: status, pending update count, and update management without opening a window.
- **Native-feeling UI per platform**: macOS traffic lights or Windows caption buttons integrated into a single 46px shell frame; embedded settings panels, light/dark appearance, per-device settings and update sources.
- **Data isolation**: the harness runs under its own dsh home; your real `~/.dsh` and the installed app's data are never touched.
- **Startup auto-check**: notifies when updates are available (deduplicated per launch, per device).

## Android (phone and tablet)

`android/` is a native Android client for the same product idea (Kotlin + Compose
+ WebView + JSch) — not the desktop shell running on a phone:

- **SSH remote**: connect to a Linux box from the phone, automatically **reuse or
  start** the remote `dsh web`, forward a loopback port over JSch, and render the
  harness UI through it. It speaks the same protocol as the desktop shell, so the
  two can share one resident service.
- **Direct URL**: paste a URL you can already reach (reverse proxy, LAN). No SSH,
  no managed service.
- **Adaptive layout**: phone portrait is a single column (terminal list ⇄
  full-screen harness); tablet landscape is two panes (persistent terminal rail +
  harness). Decided from the *window* width, so split-screen falls back to one
  column.
- **Background survival**: a foreground service holds the connection so the
  tunnel survives backgrounding; once ready the service is probed every 4s and
  reconnected after two consecutive failures.
- **WebView compatibility shim**: `Promise.withResolvers`, `AbortSignal.any` and
  friends are injected at document start, so Chromium 99+ devices work; anything
  older gets a clear message instead of a blank page.

See [android/README.md](android/README.md).

## Quick start

### macOS

```sh
bash scripts/build.sh
bash scripts/install.sh
open '/Applications/DeepSeek Harness.app'
```

### Windows

```powershell
# builds x64 AND arm64 (installer + portable + zip)
powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1

# or one architecture only
npm run dist:win:x64        # dist:win:arm64 for Windows on ARM
```

Then run `dist\dsh-desktop-<version>-windows-<arch>-setup.exe` to install, or
the `-portable.exe` for a no-install build.

### Linux

```sh
npm install

# --arm64 on ARM hosts
npx electron-builder --linux AppImage deb --x64 \
  -c.linux.artifactName='dsh-desktop-${version}-linux-${arch}.${ext}'
```

The `-c.linux.artifactName` override matters: `package.json` only declares a
macOS-named top-level `artifactName`, so a Linux build without an explicit
`linux` block would emit `…-macos-x64.AppImage`. Linux packages must be built on
a Linux host (AppImage/deb cannot be cross-built from macOS or Windows);
`npm start` works on all three platforms for development.

### Any platform (development)

```sh
npm install
npm start
```

First launch opens connection settings: pick **本地** (local) or **SSH 远程** (remote), then **保存并连接**. The first connection installs the official runtime and starts it automatically; routine upgrades go through the **更新** menu afterwards.

> Preconfigure an SSH device for a hands-off first launch on macOS:
>
> ```sh
> bash scripts/install.sh --ssh <your-ssh-alias>
> ```

## Development

```sh
npm run smoke                    # Electron-free module tests (all platforms)
DSH_DESKTOP_SMOKE=1 npx electron .   # macOS/Linux in-app smoke
npx electron .                   # run the shell
```

On Windows use PowerShell and the same commands; `DSH_DESKTOP_SMOKE` works as
`$env:DSH_DESKTOP_SMOKE=1; npx electron .`.

## Documentation

- [Architecture](docs/architecture.md) — module map, ports & processes, resident auto-upgrade, packaging/release.
- [Requirements](docs/requirements.md) — functional requirements, edge cases, acceptance criteria.
- [Development](docs/development.md) — development conventions, testing, release verification.
- [Agent](docs/agent.md) — invariants and pitfalls for coding agents.
- [Roadmap](docs/roadmap.md) — phase overview; mobile (phone-over-SSH to Linux) plan.

## Known limitations

- Builds are unsigned on every platform (macOS Gatekeeper / Windows SmartScreen may ask to confirm on first launch).
- SSH mode requires key-based auth; password prompts cannot work without a terminal.
- The local-mode service log only covers shell-owned processes.
- On Windows the "does this process use my dsh home?" check uses the process command line's runtime path instead of `lsof` open files; when it cannot tell, the shell leaves the process alone.
- Linux reuses the Windows `hidden` + `titleBarOverlay` window branch, but `src/ui/shell.css` only scopes its insets to `:root[data-platform="windows"]` — Linux therefore keeps the macOS left inset and does not reserve the right-hand caption strip. Window chrome on Linux desktop environments has not been verified yet.
