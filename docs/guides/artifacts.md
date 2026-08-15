# Binaries on a tag

For a cargo repository, `cutver init` writes a `publish.yml` that builds
executables and attaches them to the GitHub release — no registry involved.
That is the [default](../reference/config.md#what-a-tag-produces), because
`cargo publish` reserves a crate name permanently and a Rust workspace is more
often an application than a library.

Three runners to start with:

```yaml
matrix:
  include:
    - { os: ubuntu-latest,  target: x86_64-unknown-linux-gnu }
    - { os: macos-latest,   target: aarch64-apple-darwin }
    - { os: windows-latest, target: x86_64-pc-windows-msvc }
```

**Those three are a starting point, not a promise**, and this page is about the
gap between them.

## What cutver knows, and what it cannot

It knows which binaries your workspace declares — the collect step asks
`cargo metadata` rather than naming them, so renaming one changes nothing here.

It cannot know **what they link against.** The thing that stops a build is
usually a *system* library, and system libraries appear in no manifest. `fuser`
needs `libfuse`; nothing in any `Cargo.toml` says so, because its build script
goes looking at build time.

So `init` asks, per runner, and tells you:

```
  the matrix in publish.yml starts with three runners, and:
    aarch64-apple-darwin
      fuser searches for an installed library via pkg-config
    x86_64-pc-windows-msvc
      winfsp-sys needs libclang at build time
```

That is `cargo metadata --filter-platform` under the hood, which resolves the
graph **for** a platform without building for it — so the macOS answer arrives
in seconds on a Windows laptop. You can run it yourself:

```bash
cargo tree -p your-cli --target aarch64-apple-darwin -i some-sys-crate
```

**It reports what a crate looks for, never what a runner lacks.** The ubuntu
image already ships plenty of these, so a flagged Linux row often builds fine.
Over-reporting is deliberate: reading an extra line costs nothing, and a miss
costs a release that fails after the tag is public.

## The `cfg(unix)` trap

The most common way a matrix row fails is not exotic. It is this:

```toml
[target.'cfg(unix)'.dependencies]
some-fuse-backend = { path = "../fuse" }
```

`cfg(unix)` is a **family**, not an OS. Check it without a Mac:

```bash
rustc --print cfg --target aarch64-apple-darwin
```

```
target_family="unix"
target_os="macos"
unix
```

`unix` is set on macOS. So cargo treats that dependency as real there, walks
into it, and the build fails looking for a Linux library. If you mean Linux, say
Linux:

```toml
[target.'cfg(target_os = "linux")'.dependencies]
some-fuse-backend = { path = "../fuse" }
```

**Narrow the manifest and the source together.** A `#[cfg(unix)]` function that
uses a crate now gated to Linux fails to compile on macOS for a new reason.

## Three ways to fix a failing row

| | |
| --- | --- |
| **Delete the row** | Cheapest, and right when you do not support that platform. A binary nobody tests is not a feature. |
| **Add a setup step** | `if: runner.os == 'Windows'` and install the SDK, exactly as your CI job already does. |
| **Narrow the `cfg`** | Only when the dependency was never meant for that platform. Change the source to match. |

A setup step is ordinary:

```yaml
- name: Install WinFsp (with SDK)
  if: runner.os == 'Windows'
  run: |
    Invoke-WebRequest -Uri "https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.25156.msi" -OutFile winfsp.msi
    Start-Process msiexec -ArgumentList '/i','winfsp.msi','/qn','INSTALLLEVEL=1000' -Wait
```

> **If you already have a CI workflow, copy its setup steps.** The release build
> needs whatever `cargo test` needed, and a release job that quietly covers less
> than CI fails at the worst possible moment — after a tag is public.

## One failing row costs the whole release

The job that attaches the binaries has `needs: artifacts`, so it is skipped
unless every row succeeded. That is deliberate — half a release is worse than
none, and a missing platform is not something anyone notices in a release list.

It does mean a single unbuildable row is expensive, which is why `init` bothers
to warn.

## `matrix.target` is a label

Worth knowing before you edit the matrix: `target` names the artifact
(`app-x86_64-pc-windows-msvc.exe`). It is **not** passed to cargo. These are
native builds on native runners, using the host triple.

If you pass `--target`, you are cross-compiling, which is a different and much
fussier activity — and one this project has been bitten by. Five cutver releases
shipped a `cutver-windows-x64.exe` that segfaulted on launch, because CI
cross-compiled every target on Linux and Bun's `--bytecode` produces a broken
executable for the Windows target. Native runners cannot fail that way, which is
why the generated matrix uses three of them rather than one with three targets.

## Prereleases are marked as such

A tag like `v1.3.0-beta.0` creates a release marked **prerelease**, and that is
load-bearing rather than cosmetic:

```
releases/latest/download/app-linux-x64
```

That URL follows GitHub's idea of latest, which **skips prereleases**. A beta
published as a full release becomes the target of every unpinned download in the
world; and in a project that has only ever published prereleases, that URL is a
plain 404 rather than an empty result. Both measured against this project.
