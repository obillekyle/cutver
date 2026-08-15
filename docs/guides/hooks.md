# The pre-push guard

```bash
bunx cutver hook install
```

It refuses a push to a release branch whose name promises a lower version than
its commits justify. Everything else it lets through.

## What it catches

A branch named `1.3.0-beta` declares its base: *this branch is building towards
1.3.0*. Land a `feat!` on it and the commits now imply **2.0.0**, so cutting
1.3.0 would ship a breaking change as a minor.

cutver already refuses that at release time. The hook moves the refusal to push
time, which is the difference between renaming a branch and un-publishing a
version:

```
$ git push origin 1.3.0-beta
cutver: branch '1.3.0-beta' declares 1.3.0, but the commits since v1.2.0
        imply 2.0.0 (major).
        Rename the branch to 2.0.0-beta, or pass the version explicitly if
        the branch is right.
        Push with --no-verify if the branch is right.
error: failed to push some refs to 'origin'
```

The **same commit** on a branch that promises enough is fine:

```
$ git push origin 2.0.0-beta
cutver: check ok — '2.0.0-beta' would release 2.0.0-beta.0
 * [new branch]      2.0.0-beta -> 2.0.0-beta
```

That is the whole rule. The name of the branch is the promise; the hook checks
you can keep it.

## What it does not catch

Nothing else. It is not a second opinion on whether your code is good, it does
not run your tests, and it does not care whether a release is warranted at all
— "nothing to release" is a normal state and pushes fine.

It also **fails open**. cutver missing, git broken, a manifest that will not
parse, no `package.json` at all — the push goes through and the hook says why:

```
cutver: check skipped — no package.json or Cargo.toml here
```

A guard that blocks every push in a repository because it crashed is worse than
no guard, and CI still catches the real thing. Only the branch-declared refusal
blocks.

## Bypassing it

Git's own escape hatch, no invention required:

```bash
git push --no-verify
```

Use it when the branch name is right and cutver is wrong — and then think about
why, because that is the case worth a bug report.

## `cutver check`

The hook is a thin shell wrapper around one command, which you can run yourself:

```bash
cutver check
```

```
cutver: check ok — nothing to release on 'main' (no feat/fix/perf or breaking
        commit since v1.2.0)
```

Read-only, offline, and with exit codes aimed at a hook rather than a person:

| Exit | When |
| --- | --- |
| `0` | a valid release would be computed, **or** nothing is warranted, **or** cutver could not run at all |
| `1` | only the branch-declared refusal |

`--branch` and `--rev` override what it judges. The hook passes both, because
the ref being pushed is not always the one checked out — judging `HEAD` instead
would clear a push carrying a commit that is not in it.

## Installing

```bash
cutver hook install
```

Writes `pre-push` into wherever git actually keeps this repository's hooks —
`core.hooksPath` if it is set, otherwise `git rev-parse --git-path hooks`,
which is not always `.git/hooks` (in a worktree, `.git` is a *file*).

It will not overwrite a `pre-push` it did not write. Yours stays, and the
install reports that it stayed:

```
cutver: = pre-push  a pre-push hook is already there and is not ours — --force to replace it
```

`--force` replaces it. Its own hook is replaced without asking, because a
generated file has no content worth keeping.

```bash
cutver hook uninstall
```

Removes it — and only if it is ours.

> **Hooks are not tracked by git.** `.git/hooks` is not part of the repository,
> so installing this on your machine does nothing for anyone else's. Everybody
> who wants it runs the install; the [CI check](../getting-started/ci.md) is
> what covers the whole team, and it is the one that actually blocks a release.
> This is a convenience that moves the failure earlier for you.

### How the hook finds cutver

At run time, not at install time, and in this order:

| | |
| --- | --- |
| 1 | `cutver` on `PATH` |
| 2 | `bunx cutver` |
| 3 | `npx --yes cutver` |
| 4 | **the release executable, downloaded** |
| 5 | give up, and let the push through |

Steps 1–3 are deliberately not pinned at install time, so a repository that
adds cutver as a devDependency next month gets the local copy without
reinstalling anything — `bunx` and `npx` both prefer `node_modules/.bin` over
the registry.

**Step 4 is what makes this work in a repository with no JavaScript runtime at
all** — a Rust workspace, a Go module, a bare deployment checkout. Every
release attaches an executable per platform, so there is something to fetch.
It needs only `curl` or `wget`, plus `uname` to pick the right asset.

The binary lands in **`.git/cutver/`**: never committed, never needs a
gitignore entry, and fetched once rather than per push. It is around 95 MB, so
the first push that needs it says so:

```
cutver: fetching the release binary once into .git/cutver (~95 MB)
```

`hook install` pins the tag it downloads from — the version of cutver that ran
the install. That matters more than it sounds: the unpinned form,
`releases/latest/download/…`, follows **GitHub's** idea of latest, which skips
prereleases, and against a project that has only ever shipped them it is a
plain 404 rather than an empty result. Installing the hook with a released
cutver pins a real tag and the fallback works; installing it from a source
checkout cannot know a version and falls back to the `latest` URL.

Pin the command instead if you would rather:

```bash
cutver hook install --runner "bunx cutver@1"
```

Worth doing on a team, where detection can resolve differently on different
machines: the hook tries `cutver` on PATH first, so a stray global install
decides the version for whoever has one.
