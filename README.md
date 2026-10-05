# opencode-termux-native

**OpenCode running natively on Termux (Android aarch64). No glibc, no proot, no wrapper emulating another libc.**

[![ci](https://github.com/Lucas7X7/opencode-termux-native/actions/workflows/ci.yml/badge.svg)](https://github.com/Lucas7X7/opencode-termux-native/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.6-4CAF50.svg)](https://nodejs.org)

## The problem

OpenCode ships as a binary linked against **glibc**. Android runs on **Bionic**, the system libc. Nearly every OpenCode-on-Termux project works around this by loading `glibc` through `ld-linux-aarch64.so.1` (or `bun-termux-loader`, or a seccomp shim).

That works, but it depends on `glibc-repo` — precisely what breaks on **Play Store Termux**, which is frozen and outdated. And in the end you have two libcs living in the same process.

This project takes a different route: it **transplants OpenCode's compiled module graph onto a native Bionic Bun base**. The result is a single ELF linked against `/system/bin/linker64`, zero glibc.

| | glibc wrapper | **opencode-termux-native** |
|---|---|---|
| libc | glibc + Bionic | Bionic only |
| needs `glibc-repo` | yes | **no** |
| Play Store Termux | usually breaks | **works** |
| session `LD_PRELOAD` | gets in the way | handled by the launcher |
| shell tool on Play Store | depends on `glibc-repo` | **bypass via `linker64`** |
| installed files | packages + `.so` + wrapper | 1 binary + 1 launcher |

## Requirements

- Termux — **F-Droid, GitHub or Play Store** all work (the native build needs no `glibc-repo`)
- `aarch64` (ARM64)
- Android 9+ (API 28+). Android 10+ recommended for the TUI
- Node.js 22.6+ for the installer — `pkg install nodejs`
- `ripgrep` for the `glob`/`grep` tools — `pkg install ripgrep` (the launcher copies Termux's `rg` into OpenCode's cache)

> `x86_64` and `armv7` are not supported: there is no viable native build, and the cost isn't worth it.

## Installation

```bash
pkg install nodejs -y
npx opencode-termux-native install
```

The installer:

1. checks the architecture and Android API;
2. downloads the latest native release;
3. verifies the `SHA256`;
4. extracts it with its own tar reader (no dependency on the `tar` binary);
5. installs the runtime into `$PREFIX/libexec/opencode-termux-native/`;
6. writes the `opencode` launcher into `$PREFIX/bin/`.

Then just:

```bash
opencode
```

## Installer usage

```bash
opencode-termux install                 # install or update
opencode-termux doctor                  # check whether the device runs the native build
opencode-termux run -- --version        # forward arguments to OpenCode
opencode-termux uninstall               # remove binary, launcher and libs
opencode-termux install --opencode 1.18.31
opencode-termux doctor --json
```

Everything after `run` is forwarded to the runtime verbatim, flags included, so `run --version` and `run -- --version` are no longer swallowed as installer flags.

Note that the grafted runtime is a Bun standalone executable, and Bun claims `--version` before OpenCode's code runs, so `run --version` prints **Bun's** version. OpenCode has no `--version` flag of its own; `opencode-termux doctor` reports the installed OpenCode version.

| Flag | Effect |
|---|---|
| `--opencode <version>` | Pin an OpenCode version instead of the latest |
| `--no-verify` | Skip the SHA256 (not recommended) |
| `--repo <owner/name>` | Use a different release repository |
| `--json` | Machine-readable output for `doctor` |

## How it works

```
release tarball (opencode-linux-arm64)     Android Bun base (aarch64, Bionic)
              │                                        │
              └── compiled module graph ──────┐        │
                                               ▼        ▼
                    [ Bionic base ][ blob ][ Offsets 32B ][ trailer 16B ][ footer u64 ]
                                               │
                                   single Bionic ELF (opencode)
```

1. Extract the official binary's payload: locate the `---- Bun! ----` trailer and read the `byte_count` (u64) in the `Offsets` struct (32 bytes) just before it.
2. Append that self-contained payload (`blob` + `Offsets` + trailer) to a **pinned aarch64 Bionic Bun base**.
3. Write the `total_byte_count` footer (u64 LE) = total file size, keeping Bun's standalone format.
4. Swap the embedded `libopentui.so` (glibc-linked) for a Bionic build of **the same size**, in place, via `--opentui`. That's the only patch required: the rest of the graph stays byte-for-byte identical to upstream v1.18.21.

The launcher also ensures a usable `TERM`, and copies Termux's `rg` (Bionic) into `~/.cache/opencode/bin/rg`, which is where OpenCode reads the ripgrep for the `glob`/`grep` tools from — replacing the official glibc download, which won't run on Bionic. If the cache holds a broken `rg`, the launcher repairs it on the next run.

### Play Store Termux

On Android 10+, Termux builds declaring **targetSdk ≥ 29** (the Play Store one) run in the `untrusted_app` SELinux domain, which **forbids `execve()` of files under `app_data`**. Termux works around this with `libtermux-exec.so`, but that shim **strips `LD_PRELOAD` from children** — so the runtime loses the shim and can no longer spawn the shell (`PermissionDenied: ChildProcess.spawn`).

The launcher checks `/proc/self/maps` to see whether the shim is already loaded. If it is not, it **re-executes itself** through `/system/bin/linker64` with `libtermux-exec.so` preloaded and `TERMUX_EXEC_OPTOUT=1` — the opt-out stops an already-loaded shim from stripping `LD_PRELOAD` on the way, because the linker is not an app-data target and the shim does not put it back for it. From there the launcher `exec`s the runtime **normally**: the runtime *is* an app-data target, so the loaded shim rewrites that exec and hands the child its own `LD_PRELOAD`. Calling the linker by hand for the runtime would lose the shim.

Neither a probe nor an env guard is reliable: the shim only protects the process that has it loaded, a probe passes whenever the launcher already inherited the shim (while the runtime would still lose it), and a guard can leak into the launching shell and make the launcher skip it. Reading `/proc/self/maps` is exact and needs no external command. This keeps `execve` working for the runtime and everything it spawns, and also lets the launcher itself copy the Bionic `rg` into OpenCode's cache before starting. On official Termux the shim is already loaded, so nothing is re-executed.

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev -- doctor
```

The release build runs in CI (`release-native.yml`): it takes the official `opencode-linux-arm64` and the pinned Bionic base, runs `scripts/graft.py`, and publishes `opencode-termux-native-aarch64.tar.gz` + `SHA256SUMS`.

## Publishing releases

CI runs on its own overnight, but also accepts `workflow_dispatch`. It needs two **seed** assets published once in this repository (pinned tags): the Bionic Bun base `bun-base-v1.4.0-android-aarch64` and the `opentui-bionic-*-aarch64` with the `libopentui.so` compiled for Bionic (NDK). `graft.py` embeds that `.so` into the graph, replacing the glibc build. From then on, every new OpenCode release becomes a native release automatically, with no runtime recompilation.

## Credits

- [anomalyco/opencode](https://github.com/anomalyco/opencode) — OpenCode
- [oven-sh/bun](https://github.com/oven-sh/bun) — the runtime
- [Hope2333/opencode-termux](https://github.com/Hope2333/opencode-termux) — validated the native Bionic graft path

## License

[MIT](LICENSE)
