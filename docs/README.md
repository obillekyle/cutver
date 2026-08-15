# cutver

Work out the next version from your commit messages, write it into every
manifest, and stop.

It reads conventional commits since your last stable tag, decides whether that
is a major, a minor or a patch, and puts the number everywhere the number lives
— `package.json` and every workspace package and `bun.lock`, or
`[workspace.package]` and `Cargo.lock`. Then it prints what to do next and exits.

It never publishes. That is the whole design, not a missing feature — see
[Why it stops](#why-it-stops).

## Prerequisites

| | |
| --- | --- |
| **git** | Non-negotiable. The version is computed from commit messages and measured from tags; there is nothing to compute without them. |
| **Conventional commits** | `feat:`, `fix:`, `feat!:` and friends. Not perfectly — anything unrecognised is ignored rather than guessed at — but the ones that should cut a release have to say so. |
| **Bun** | Only if you run it with `bunx`. The [standalone executable](getting-started/install.md#the-executable) has no runtime at all, which is the point for Cargo repositories. |

## Quickstart

Look before you leap. `--dry-run` writes nothing, ever:

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

Happy with it? Drop the flag:

```bash
bunx cutver
```

Now review the diff, commit, and tag. Or better, let CI do all three —
[Set up CI](getting-started/ci.md) writes the workflows for you:

```bash
bunx cutver init cargo
```

## Key concepts

- **The number comes from the commits, the notes come from you.** Every other
  tool in this space generates release notes by listing commit subjects. cutver
  opens the changelog heading and writes nothing under it. The version is
  mechanical; the prose is the work.
- **Measured from the last *stable* tag.** Not the last tag — measuring from
  `v1.3.0-beta.2` is how a breaking change that lands mid-beta ships as a minor.
  Not the current version either — that graduates `1.2.0-rc.1` to `1.2.1` and
  silently skips the `1.2.0` everyone tested.
- **Adapters, not ecosystems.** An adapter knows three things: read a version,
  write a version, name every file that touched. `js` and `cargo` today. The
  arithmetic above them does not know what a registry is.
- **A preflight that runs before the first write.** It asks the registry whether
  each package exists yet, because [a first publish cannot go through a trusted
  publisher](getting-started/first-release.md#the-first-publish-is-manual), and
  finding that out after the tag is how a version number gets spent for nothing.
- **Everything is reported, including what did not change.** A dry run that
  lists only what moved cannot tell you "the lockfile is already in step" from
  "the lockfile was never considered". Those have failed differently.

## Why it stops

Publishing is the one irreversible step in the sequence. npm does not allow a
version number to be reused — by anyone, ever — and neither does crates.io. So
it gets its own trigger, its own credentials, and a human or a workflow that
decided to run it.

A tool that both rewrites the tree and pushes to a registry is one typo away
from a mistake nobody can take back. cutver gets the tree to a releasable state
and prints what comes next. It does not commit, does not tag, and does not
publish.

The two workflows `cutver init` writes keep that split: one computes and tags,
one publishes and only ever fires on a tag.

## What it writes

| Adapter | Files |
| --- | --- |
| `js` | root `package.json`, every non-private workspace package, `bun.lock`'s workspace entries |
| `cargo` | `[workspace.package] version` in `Cargo.toml`, then `cargo update -w` for `Cargo.lock` |
| both | `CHANGELOG.md`, if there is one with a `## [Unreleased]` heading |

Detected from which manifest exists. A repository with both is asked about
rather than guessed at.

## Where next

- [Install](getting-started/install.md) — `bunx`, or a binary with no runtime.
- [Your first release](getting-started/first-release.md) — the whole dance,
  including the parts that only bite once.
- [Set up CI](getting-started/ci.md) — `cutver init`, and what the two
  workflows are doing.
- [How the number is chosen](guides/versions.md) — the rules, and the four that
  are easy to get backwards.
- [The pre-push guard](guides/hooks.md) — stop a `feat!` reaching a branch
  whose name promises less than it needs.
- [Configuration](reference/config.md) — put `develop` in the beta channel,
  or add a channel of your own by adding a key.
- [Troubleshooting](reference/troubleshooting.md) — every error cutver prints,
  and what it actually means.
