# cutver

Work out the next version from your commit messages, write it into every
manifest, and stop.

```bash
bunx cutver --dry-run
```

```
cutver: /repo (cargo, at 0.1.0, on 'main')
cutver: 49 commit(s) since the first commit
  minor 5
        feat: bidirectional sync engine
        … and 4 more
  patch 8
cutver: 0.1.0 -> 0.2.0 (minor)

preflight (10 package(s) on crates.io)
  · oidc  not in CI — publishing will use whatever credential npm finds locally
  ✗ alloyfs-proto  NOT on the registry — this would be its first publish

files (dry run — nothing is written)
  ↑ Cargo.toml  [workspace.package] 0.1.0 -> 0.2.0
  ↑ Cargo.lock  would run `cargo update -w`
```

It does not publish. See [Why it stops](#why-it-stops-before-publishing).

## Install

> **In beta.** There is no `latest` on npm yet, deliberately — a release tool
> that has not cut many releases should not be what a bare `bunx cutver`
> resolves to. Until `0.1.0` graduates, ask for the channel by name.

Nothing to install for a repository that already has Bun:

```bash
bunx cutver@beta
```

For one that does not — a Rust workspace, a CI image without a package manager
— every release attaches a standalone executable with no runtime:

```bash
curl -L -o cutver https://github.com/obillekyle/cutver/releases/latest/download/cutver-linux-x64 && chmod +x cutver
```

`cutver-{linux,darwin}-{x64,arm64}` and `cutver-windows-x64.exe`.

## Usage

```
cutver [version] [options]
```

| | |
| --- | --- |
| `version` | an explicit semver, overriding the computation |
| `--dry-run` | compute and report, write nothing |
| `--alpha` `--beta` `--rc` | cut a prerelease in that channel |
| `--adapter js\|cargo` | force the manifest adapter (default: detected) |
| `--cwd <path>` | repository root (default: the working directory) |
| `--branch <name>` | branch name, for CI on a detached HEAD |
| `--if-needed` | exit 0 rather than 1 when no release is warranted |
| `--offline` | skip the registry preflight |
| `--allow-first-publish` | proceed even though a package is not on the registry yet |

## How the version is worked out

Conventional commits, since the last **stable** tag.

| commit | bump |
| --- | --- |
| `feat!:`, `fix!:`, any `type!:` | major |
| `BREAKING CHANGE:` at the start of a body line | major |
| `release:` | major |
| `feat:` | minor |
| `fix:`, `perf:` | patch |
| `docs:` `chore:` `refactor:` `test:` `style:` `build:` `ci:` | none |

The strongest bump across the range wins. If nothing in it justifies a release,
cutver says so and exits 1 — or exits 0 under `--if-needed`, which is what CI
wants, because most pushes are docs and a workflow that is usually red is a
workflow nobody reads.

Four rules are worth knowing because getting them wrong is the classic release
bug in one direction or the other:

- **Both breaking markers count**, not just the footer. Tools that scan bodies
  alone miss `feat!:` with no `BREAKING CHANGE:` block — which is how most
  people write one.
- **The base is the last stable release plus the bump across every commit since
  it — never the current version.** Bumping the current version graduates
  `1.2.0-rc.1` to `1.2.1`, silently skipping the `1.2.0` everyone was testing.
  Measuring from the last *tag* lets a `feat!` landing during a beta ship as a
  minor.
- **A prerelease counter continues only while the base and the channel both
  hold.** A break landing mid-beta, or `--beta` after `--alpha`, restarts at
  `.0`; carrying the counter across would eventually produce a version sorting
  below one already published.
- **With no tags at all the baseline is the manifest**, not `0.0.0`. From
  `0.0.0` a patch computes `0.0.1` — lower than the version the repository
  already declares.

### Branch-declared versions

A branch named `1.2.0-beta` (or `v1.2.0-beta`, or `release/1.2.0-beta`) says
"this branch is building towards 1.2.0, publishing betas along the way". The
name carries the channel, never the counter — the counter comes from the
manifest, so the fourth cut from that branch is `beta.3` and not `beta.0`
forever.

If the commits imply a *higher* base than the branch declares, cutver refuses
rather than warns. Publishing 1.2.0 with a breaking change in it is not
something to discover in a scrolled-past CI log.

## Adapters

Detected from which manifest exists. A repository with both is asked about
rather than guessed at.

**`js`** — the root `package.json`, every non-private workspace package, and
`bun.lock`.

That last one is the reason this adapter is more than a JSON edit. `bun pm
pack` expands `workspace:^` using the version recorded in the *lockfile*, not
the one in the sibling manifest, and `--frozen-lockfile` means a plain install
will not fix it. A release that skips it publishes packages declaring
dependency ranges that resolve to the wrong version — seven of them did, once,
and the whole prerelease channel was unusable on the registry while every gate
was green. cutver rewrites those lines in place, and refuses if a package it
just bumped has no lockfile entry at all. (It does not regenerate the lock:
deleting it re-resolves every external dependency *after* your gates have run,
publishing a tree nothing tested.)

`package-lock.json`, `pnpm-lock.yaml` and `yarn.lock` are named in the output
and not touched.

**`cargo`** — `[workspace.package] version` in `Cargo.toml`, then `cargo update
-w` to reconcile `Cargo.lock`. `-w` and not a bare `cargo update`, for the same
reason: re-resolving every dependency at release time changes the tree out from
under the tests.

Members that pin their own `[package] version` instead of inheriting are
reported and left alone — opting out of lockstep is a decision cutver cannot
see the reason for. A single-crate repository with no `[workspace]` works too.

`Cargo.toml` is parsed by offset and rewritten by splice, so comments, key
order and CRLF line endings all survive. The version is read from *between the
quotes*, which is what stops a CRLF file yielding `0.1.0\r` — a string that
prints fine and then cannot name a directory on Windows.

### CHANGELOG.md

If there is one with a `## [Unreleased]` heading, it is rolled into a dated
`## [1.3.0] — 2026-08-14` and a fresh `## [Unreleased]` is left above it. No
changelog, or no such heading, is fine and reported.

cutver never *writes* release notes. Generating them from commit subjects is
what every tool in this space does, and it is a downgrade from a changelog that
explains why things are the way they are. The number is mechanical; the prose
is the work.

## The preflight

Before anything is written, cutver asks the registry whether each package it
would publish actually exists, and asks the environment how it intends to
authenticate.

**A first publish cannot go through a trusted publisher.** npm has nowhere to
attach one until the package exists; on crates.io the first publish is what
reserves the name. A pipeline that does not know this bumps every manifest,
commits, tags, and then 403s at the last step — leaving a tag promising a
version nobody can install, and a version number that can never be reused.
cutver stops before the first write instead. `--allow-first-publish` proceeds
once you have read that and meant it; `--offline` skips the check entirely.

It also reports OIDC status, which catches the workflow that forgot
`permissions: id-token: write`. That one otherwise fails at `npm publish` with
an error about *credentials*, sending you to look for the token that trusted
publishing exists to not need.

## Why it stops before publishing

Publishing is the one irreversible step in the sequence. npm does not allow a
version number to be reused, by anyone, ever. So it gets its own trigger, its
own credentials, and a human or a workflow that decided to run it. A tool that
both rewrites the tree and pushes to a registry is one typo away from a mistake
nobody can take back.

cutver gets the tree to a releasable state and prints what to do next. It does
not commit, does not tag, and does not publish.

## In CI

[`.github/workflows/`](.github/workflows) in this repository is cutver cutting
its own releases; copy it. Two things in there are hard-won and easy to lose:

- **A tag pushed with the default `GITHUB_TOKEN` cannot trigger another
  workflow.** GitHub blocks it to prevent recursion, so the tagging workflow
  has to dispatch the publishing one explicitly. The first automated release
  that got this wrong tagged v1.0.1 and nothing ran.
- **Check whether the version moved, not whether the tree is dirty.** `git
  status` reports a stray formatter edit as "a release happened", and the run
  then fails creating a tag that already exists.

cutver does not run your gates — it cannot know what they are. Run them in the
job, before it, so a release cannot be cut from a tree that does not pass.

## Development

```bash
bun test ./src
```

```bash
bun run typecheck
```

```bash
bun run build
```

`bun run build --all` cross-compiles every release target.

## Provenance

`src/version-from-commits.ts` and its tests were extracted verbatim from the
`bakery` monorepo (the `@bakery-framework/*` packages), where the rules were
worked out against a real release history — the comments cite that history, and
they are kept because the evidence is what makes each rule worth trusting. The
rest of this repository is the part that was coupled to npm, generalised behind
the adapter interface.

## License

MIT
