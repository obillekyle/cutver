# CLI

```
cutver [version] [options]
cutver init <cargo|node|bun> [--force]
```

## Arguments

| | |
| --- | --- |
| `version` | An explicit semver, overriding the computation. No leading `v` — the tag adds that, and `v1.1.0` is not a valid version string in any manifest. Prerelease and build metadata are allowed. |
| `init` | Write `version.yml`, `publish.yml` and a `CHANGELOG.md` stub for that ecosystem. See [Set up CI](../getting-started/ci.md). |

## Options

| | |
| --- | --- |
| `--dry-run` | Compute and report, write nothing. Runs nothing either — no `cargo update`, no file writes — and still reports every change the real run would make. |
| `--alpha` `--beta` `--rc` | Cut a prerelease in that channel. Pick one; two is refused rather than resolved. |
| `--adapter js\|cargo` | Force the manifest adapter. Only needed when a repository has both manifests. |
| `--cwd <path>` | Repository root. Defaults to the working directory. |
| `--branch <name>` | Branch name, for CI on a detached HEAD where git answers the literal string `HEAD`. |
| `--if-needed` | Exit 0 rather than 1 when no release is warranted. What CI wants. |
| `--offline` | Skip the registry preflight entirely. |
| `--allow-first-publish` | Proceed even though a package is not on the registry yet. |
| `--force` | (`init`) Replace workflows that are already there. Never replaces `CHANGELOG.md`. |
| `-h`, `--help` | Usage. |
| `-v`, `--version` | The version of cutver itself. |

`--adapter js` and `--adapter=js` both work, as does every other option that
takes a value.

## Exit codes

| | |
| --- | --- |
| `0` | A release was cut, or nothing was warranted and `--if-needed` was passed. |
| `1` | Anything else — nothing to release, a refused branch declaration, a dirty tree, a package that has never been published, a malformed version. |

## What it checks, in order

1. **It is a git repository.** The version comes from commit messages; there is
   nothing to compute without them. (`init` skips this — scaffolding a tree
   that has not been initialised yet is reasonable.)
2. **Which adapter applies.** Both manifests present and no `--adapter` is an
   error, not a guess.
3. **The current version**, read from the manifest.
4. **The plan** — [the number and where it came from](../guides/versions.md).
5. **The version is valid semver.** Including a computed one, as cheap
   insurance against a bug in the arithmetic.
6. **The preflight** — registry presence, OIDC status, and whether each
   manifest names the repository it is being built from.
7. **The tree is clean.** Skipped under `--dry-run`, since a dry run captures
   nothing.
8. **The writes**, and the changelog.

Everything that can refuse, refuses before step 8. Nothing is half-written.

## Reading the output

```
cutver: /repo (js, at 2.0.0-alpha.6, on '2.0.0-alpha')
```

Root, adapter, current version, branch. If the branch is not what you expect,
you are on a detached HEAD and want `--branch`.

```
cutver: 56 commit(s) since v1.2.3
  major 7
        feat(dashboard)!: the console stops editing your database
        … and 4 more
```

The work, shown. A computed version nobody can check is worse than a typed one:
the reason for a major has to be visible before it is tagged.

```
files (dry run — nothing is written)
  ↑ packages/core/package.json  2.0.0-alpha.6 -> 2.0.0-alpha.7
  = apps/example/package.json   private — left alone
  · bun.lock                    no lockfile, nothing to sync
```

| Mark | Means |
| --- | --- |
| `↑` | Written (or would be) |
| `=` | Looked at, deliberately unchanged |
| `·` | Absent |

`=` and `·` are reported rather than filtered. A run that lists only what moved
cannot distinguish "the lockfile is already in step" from "the lockfile was
never considered", and those have failed differently.

## The preflight block

```
preflight (8 package(s) on npm)
  ✓ oidc  GitHub Actions OIDC available — trusted publishing can authenticate
  ✓ @scope/core  published (latest 1.2.3)
  ✗ @scope/new   NOT on the registry — this would be its first publish
  ! repo  @scope/core names no repository, but this checkout is github.com/you/repo
```

| Mark | Means |
| --- | --- |
| `✓` | Fine |
| `✗` | Stops the run — see [`--allow-first-publish`](#options) |
| `?` | The registry did not answer. Never fatal; a release that cannot be cut because a laptop is offline is a worse failure than the one this prevents. |
| `!` | A warning you should act on but that does not stop anything |

Under `--dry-run` a `✗` prints "a real run would stop here" and continues — a
dry run writes nothing, so withholding the report it was asked for would be
pointless.

## Environment

cutver reads no configuration file and no environment variables of its own. It
does read the two GitHub Actions sets when reporting OIDC status:

| | |
| --- | --- |
| `GITHUB_ACTIONS` | Whether this is a GitHub Actions runner at all. |
| `ACTIONS_ID_TOKEN_REQUEST_URL` `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | Both present means an OIDC token can be minted. In Actions without them means the job is missing `permissions: id-token: write` — which is worth catching, because it otherwise fails at publish time with an error about credentials. |
