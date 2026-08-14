# Install

Three ways in, and which one is right depends on what your repository already
has rather than on preference.

## bunx

Nothing to install if the repository already has Bun:

```bash
bunx cutver@beta --dry-run
```

`bunx` fetches the package, runs it, and does not add it to your dependencies —
which is correct for a release tool. It is not part of your app.

> **Why `@beta` and not a bare `bunx cutver`.** There is no stable release yet.
> Worse, `latest` points at `0.1.0-beta.0` and will keep pointing there until
> `0.1.0` graduates: npm pins `latest` on a package's *first* publish whatever
> `--tag` said, because every package must have one. So `bunx cutver` today
> gets you the oldest beta rather than the newest. Name the channel.

## npx

Same thing, for a repository that uses npm rather than Bun. cutver is written
in TypeScript and run by Bun, so `npx` will fetch Bun's runtime as needed —
if that bothers you, use the executable below.

```bash
npx --yes cutver@beta --dry-run
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

> **`releases/latest` follows GitHub's idea of latest, not npm's.** Prereleases
> are marked as such and are skipped by that URL, so while cutver is in beta
> `releases/latest/download/cutver-linux-x64` is a plain **404** — measured,
> not assumed. Name a tag until a stable release exists:
> `.../releases/download/v0.1.0-beta.7/cutver-linux-x64`.

> **Windows binaries before `v0.1.0-beta.7` crash on launch.** They were
> cross-compiled on Linux with Bun's `--bytecode`, which produces a segfaulting
> executable for the Windows target — isolated to a one-line program on Bun
> 1.3.14. Later releases are built without it. Linux and macOS assets are
> unaffected.

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
