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

**Documentation: [cutver.okyle.dev](https://cutver.okyle.dev)** — setup, the
version rules, both adapters, and a troubleshooting page for every error it can
print. Source in [docs/](docs/).

## Install

Nothing to install for a repository that already has Bun:

```bash
bunx cutver
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
cutver init <cargo|node|bun> [--force]
cutver check [--branch <name>] [--rev <commit>]
cutver hook install|uninstall
cutver explain [--branch <name>]
```

| | |
| --- | --- |
| `version` | an explicit semver, overriding the computation |
| `--dry-run` | compute and report, write nothing |
| `--channel <name>` | cut a prerelease in that channel — `alpha`, `beta`, `rc` (`prerelease` = `rc`), or any channel declared in `cutver.json` / `cutver.yml` |
| `--adapter js\|cargo` | force the manifest adapter (default: detected) |
| `--cwd <path>` | repository root (default: the working directory) |
| `--branch <name>` | branch name, for CI on a detached HEAD |
| `--if-needed` | exit 0 rather than 1 when no release is warranted |
| `--offline` | skip the registry preflight |
| `--allow-first-publish` | proceed even though a package is not on the registry yet |
| `--force` | (`init`, `hook`) replace files that are already there |
| `--config <path>` | read this config instead of looking for one |
| `--rev <commit>` | (`check`) the commit to judge, default `HEAD` |
| `--runner <cmd>` | (`hook`) pin how the hook invokes cutver |
| `--no-hook` | (`init`) do not install the pre-push guard |
| `-h`, `-v` | help, and the version of cutver itself |

### `cutver init`

Writes `.github/workflows/version.yml`, `.github/workflows/publish.yml` and a
`CHANGELOG.md` stub for the ecosystem you name.

```bash
bunx cutver init cargo
```

Two workflows, always — never one `release.yml` that does both. That split is
the thing being scaffolded: publishing is irreversible, so it gets its own
trigger and its own credentials. Both files carry the gotchas below as
comments, because that is the form in which they survive.

`node` uses `npm ci` and `npx`; `bun` uses `bun install --frozen-lockfile` and
`bunx`; **`cargo` downloads the executable** rather than installing another
ecosystem's package manager to run a version bump — which is what the compiled
binary is for.

Nothing is overwritten without `--force`, and `CHANGELOG.md` is never
overwritten at all: it holds prose someone wrote. The gates are left for you to
fill in — cutver cannot know what yours are.

### `cutver hook install`

A `pre-push` guard that refuses a push to a release branch whose name promises
a lower version than its commits justify. A `feat!` on `1.3.0-beta` implies
2.0.0, so cutting 1.3.0 from it would ship a breaking change as a minor:

```
$ git push origin 1.3.0-beta
cutver: branch '1.3.0-beta' declares 1.3.0, but the commits since v1.2.0
        imply 2.0.0 (major).
error: failed to push some refs to 'origin'
```

The same commit on `2.0.0-beta` passes. cutver already refuses this at release
time; the hook moves it to where the fix is a branch rename rather than an
un-publish.

It fails open on everything else — cutver missing, git broken, no manifest —
because a guard that blocks every push in a repository because it crashed is
worse than no guard. `git push --no-verify` bypasses the refusal itself.

## Configuring which branches release what

Optional. Without a config file cutver behaves exactly as it always has, and a
test exists whose only job is keeping that true.

`cutver.json` or `cutver.yml` at the repository root:

```json
{
  "schema": 1,
  "target": "bun",
  "channels": {
    "release": ["main"],
    "beta": ["beta", "develop", "{version}-beta"],
    "canary": ["canary", "nightly/*"]
  }
}
```

**The key is the channel** — the prerelease identifier in the version and the
dist-tag it publishes under. `alpha`, `beta` and `rc` are known without being
told; any other name works the same way, so a channel is created by adding a
key. Registries have no objection: react publishes `next` and `canary`,
typescript publishes `dev` and `insiders`.

Names are kebab-case and converted for you — `myPrefix` and `my_prefix` both
become `my-prefix`. Branch patterns come in three shapes: a literal (`develop`),
a glob (`nightly/*`), or `{version}-beta`, which matches `1.3.0-beta` and lets
the branch declare its own base.

A branch matching nothing releases nothing — `cutver` exits 1, `--if-needed`
exits 0, and `cutver check` exits 0 so the pre-push hook never blocks a feature
branch. `cutver explain` shows which rule matched and every rule that did not.

Full reference: [cutver.okyle.dev](https://cutver.okyle.dev/#/reference/config).

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
  hold.** A break landing mid-beta, or `beta` after `alpha`, restarts at
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

And it compares each manifest's `repository` against the git remote. Trusted
publishing signs a provenance statement naming the repository that built the
tarball, and npm rejects one whose manifest disagrees — including one that says
nothing, which npm normalises to `""`. cutver hit this on its own first
automated release, *after* the tag had been pushed: token minted, tarball
built, provenance written to the transparency log, then `422`.

It reports this rather than fixing it. Filling the field in from `git remote
get-url origin` writes the *fork's* URL on a fork, where it passes locally and
fails identically upstream — and it cannot fix the other half of the failure, a
`repository` that is present and stale.

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
