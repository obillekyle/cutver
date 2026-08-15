# Install

Three ways in, and which one is right depends on what your repository already
has rather than on preference.

## bunx

Nothing to install if the repository already has Bun:

```bash
bunx cutver --dry-run
```

`bunx` fetches the package, runs it, and does not add it to your dependencies —
which is correct for a release tool. It is not part of your app.

Prereleases stay behind their channel — `bunx cutver@beta` for the next beta,
`@rc` for a release candidate. A bare `bunx cutver` never resolves to one.

## npx

Same thing, for a repository that uses npm rather than Bun. cutver is written
in TypeScript and run by Bun, so `npx` will fetch Bun's runtime as needed —
if that bothers you, use the executable below.

```bash
npx --yes cutver --dry-run
```

## The executable

For a repository with no JavaScript package manager at all. This is what the
compiled binary exists for: a Rust workspace should not have to install another
ecosystem's tooling to bump a version number.

```bash
curl -L -o cutver https://github.com/obillekyle/cutver/releases/latest/download/cutver-linux-x64 && chmod +x cutver
```

```bash
./cutver --dry-run
```

Every release attaches five:

| File | For |
| --- | --- |
| `cutver-linux-x64` | Linux, x86-64 (glibc) |
| `cutver-linux-arm64` | Linux, arm64 |
| `cutver-darwin-x64` | macOS, Intel |
| `cutver-darwin-arm64` | macOS, Apple silicon |
| `cutver-windows-x64.exe` | Windows |

No runtime, no `node_modules`, no PATH surgery. The Bun runtime is compiled in.

> **`releases/latest` follows GitHub's idea of latest, not npm's.** It skips
> prereleases, so the URL above resolves to the newest *stable* release and
> never to a beta. In a repository that has only ever published prereleases it
> is a plain **404** rather than an empty result — measured against this
> project before 1.0.0, not assumed. Pin a tag if you want a specific one:
> `.../releases/download/v1.0.0/cutver-linux-x64`.

> **Every release's binaries are sound, but the Windows ones were not always.**
> `v0.1.0-beta.2` through `v0.1.0-beta.6` originally shipped a
> `cutver-windows-x64.exe` that segfaulted on launch: CI cross-compiles every
> target on Linux, and Bun's `--bytecode` produces a broken executable for the
> Windows target — isolated to a one-line program on Bun 1.3.14, which prints
> without the flag and crashes with it.
>
> Builds since then omit `--bytecode`, and the assets on those older releases
> were **rebuilt from their own tags and replaced in place**, along with the
> other three cross-compiled targets, which were built the same way and could
> not be verified from here. `cutver-linux-x64` was never touched: the runner
> is linux-x64, so that one was always a native build.

> **Checksums are not published yet.** If you are scripting a download and want
> to pin more than a URL, prefer the npm package, which npm integrity-checks
> for you.

### Checking what you got

```bash
cutver --version
```

The version is compiled into the binary at build time rather than read from a
file — a standalone executable does not carry `package.json`, so a binary that
read its version from disk would work perfectly in development and report
nothing at all from the artefact people actually run.

## In CI

Don't install it by hand. [`cutver init`](ci.md) writes a workflow that fetches
it the right way for your ecosystem — `bunx` for Bun, `npx` for npm, and a
`curl` of the executable for Cargo.

## From source

```bash
git clone https://github.com/obillekyle/cutver && cd cutver && bun install
```

```bash
bun test ./src
```

```bash
bun run build
```

`bun run build --all` cross-compiles every release target. The build needs
nothing but Bun.
