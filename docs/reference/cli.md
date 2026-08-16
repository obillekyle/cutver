# CLI

```
cutver                            help, like a bare `bun`
cutver stage [<channel>|<version>]  work out the next version and write it
cutver notes <tag> | <from> <to>    the release body on stdout
cutver changelog                    rebuild CHANGELOG.md from the tags
cutver check                        may this branch release what it implies
cutver doctor                       one read-only report of everything
cutver explain                      which rule claims this branch
cutver config                       the effective configuration
cutver init [<ecosystem>]           write version.yml + publish.yml
cutver hook install|uninstall       the pre-push guard
cutver completions <bash|zsh|fish>  a completion script
cutver help [command]               this, or one command in full
```

`cutver help <command>` prints the long form for any of them, generated from
the same table this page is checked against.

> **Releasing was the bare invocation before 2.0.** `cutver --if-needed` is now
> a command-less run: it prints this list, and exits **1** when nothing is
> attached to a terminal so a CI step fails loudly rather than going green
> having released nothing. Every generated workflow says `cutver stage` from
> 2.0 onward, and `cutver check` reports one that does not.

## Commands

| | |
| --- | --- |
| `stage` | Work out the next version from the commits and write it into every manifest. Then stop — no commit, no tag, no publish. Takes a channel (`beta`), a version (`1.4.0`), or `release` to force a stable one whatever the branch is configured to cut. With no argument the branch decides. |
| `notes` | The release body for a tag, on stdout: the `CHANGELOG.md` section for that version, rewritten by the [summariser](config.md#the-summariser) if one is configured. A range compiles from the commits instead and never reads the changelog. Never fails over content: no changelog, no section, or a summariser that died each print why and exit 0. A missing or extra argument still exits 1. This is what the generated `publish.yml` calls. |
| `changelog` | Rebuild `CHANGELOG.md` from the tags and release nothing. `--overwrite` carries the sections onto the GitHub release pages too. Needs `changelog:` set — without it cutver does not own the file and will not overwrite what you wrote. For adopting compilation on an existing project, or after changing `sections` or `keep`. |
| `check` | Exit 1 only if this branch may not release what its commits imply. Read-only and offline. See [the pre-push guard](../guides/hooks.md). |
| `doctor` | Everything `check` deliberately will not say, in one report: the config as resolved, the plan for this branch, commits that are not conventional, drift between the config and the generated workflows, whether the summariser holds a key, and whether the registry has heard of each package. Exits 1 on anything that would affect a release. |
| `explain` | Which rule claims this branch, and every rule that was tried and did not fire. Read-only, offline, always exits 0. See [Configuration](config.md). |
| `config` | The configuration as cutver resolved it, with every default merged in and every channel normalised — so a key ignored because it was misspelt is visible by its absence. JSON on stdout, which is a format cutver also reads. |
| `init` | Write `version.yml`, `publish.yml` and a `CHANGELOG.md` stub. The ecosystem is detected when omitted. See [Set up CI](../getting-started/ci.md). |
| `hook` | Install or remove a `pre-push` hook that runs `check`. |
| `completions` | A completion script for bash, zsh or fish, on stdout. Nothing is installed for you. |

## Arguments

| | |
| --- | --- |
| `<version>` | An explicit semver, overriding the computation. No leading `v` — the tag adds that, and `v1.1.0` is not a valid version string in any manifest. Prerelease and build metadata are allowed. |
| `<channel>` | A channel declared in [`cutver.json` / `cutver.yml`](config.md), or `release` for a stable version. |

**One positional serves for both, and they cannot collide.** Channel names are
refused at load if they contain a digit, so anything that parses as semver is a
version and anything else is a channel. `prerelease` is accepted as a spelling
of `rc`, and the version written is the canonical `-rc.N`.

## Options

| | |
| --- | --- |
| `--dry-run` | (`stage`, `changelog`, `init`, `hook`) Compute and report, write nothing. Runs nothing either — no `cargo update`, no file writes — and still reports every change the real run would make. |
| `--adapter js\|cargo` | Force the manifest adapter. Only needed when a repository has both manifests. |
| `--cwd <path>` | Repository root. Defaults to the working directory. |
| `--branch <name>` | Branch name, for CI on a detached HEAD where git answers the literal string `HEAD`. |
| `--if-needed` | (`stage`) Exit 0 rather than 1 when no release is warranted. What CI wants. |
| `--offline` | (`stage`, `doctor`) Skip the registry lookups entirely. |
| `--allow-first-publish` | (`stage`) Proceed even though a package is not on the registry yet. |
| `--force` | (`init`, `hook`, `changelog`) Replace files that are already there. Never replaces `CHANGELOG.md`, and never a `pre-push` hook cutver did not write. With `changelog --overwrite` it replaces written release bodies too — see below. |
| `--rev <commit>` | (`check`) The commit to judge, default `HEAD`. The hook passes the sha of the ref being pushed, which is not always the one checked out. |
| `--runner <cmd>` | (`hook`) Pin how the hook invokes cutver, instead of detecting it at run time. |
| `--no-hook` | (`init`) Do not install the pre-push guard. Everything else is written as usual. |
| `--overwrite` | (`changelog`) Also update GitHub release bodies from the compiled sections. **Only replaces a body nobody wrote** — empty, the version repeated, or GitHub’s own generated notes; anything else is reported and left alone. Summarised when a [summariser](config.md#the-summariser) is configured, so a page filled in afterwards reads the same as one written at release time. Needs `GH_TOKEN` or `GITHUB_TOKEN`. |
| `--config <path>` | Read this config instead of looking for one. Given and missing is an error, never a silent fallback to the defaults. |
| `-h`, `--help` | Usage. |
| `-v`, `--version` | The version of cutver itself. |

`--adapter js` and `--adapter=js` both work, as does every other option that
takes a value.

### `changelog --overwrite --force`

`--force` removes the one protection `--overwrite` has: it replaces release
bodies **somebody wrote**, and GitHub keeps no history of a release body, so
there is nothing to restore them from afterwards.

It exists because "nobody wrote this" is deliberately conservative. A page whose
body is a single line above GitHub's generated list counts as authored, and so
does one an earlier `--overwrite` filled in — which is the case worth knowing
about, since it means re-running after changing `sections` reports every page as
left alone until this flag is passed.

Run `--overwrite --dry-run` first: it names which pages hold a written body
without touching any of them. On a terminal `--force` then asks before the first
write; in CI it proceeds, because the flag was typed explicitly.

```bash
cutver changelog --overwrite --dry-run
```

### Deprecated in 2.0

Both still parse, and both say what they became. They are absent from the help
and from completions, and they go in 3.0 — a rename is not worth breaking a
workflow over.

| | |
| --- | --- |
| `--channel <name>` | Now `cutver stage <name>`. |
| `--regenerate-changelogs` | Now `cutver changelog`. |

## Exit codes

| | |
| --- | --- |
| `0` | A release was staged, or nothing was warranted and `--if-needed` was passed. |
| `1` | Anything else — nothing to release, a refused branch declaration, a dirty tree, a package that has never been published, a malformed version. Also a bare `cutver` outside a terminal. |

`cutver check` inverts the interesting half: it exits **0** when nothing is
warranted and **1 only** for the branch-declared refusal, because it is meant
to gate a push rather than report to a person. It exits 0 on its own failures
too — a guard that fails closed on its own bug blocks every push in the
repository.
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

The count is measured from the last release of **any** kind — that is what
decides whether there is anything to release. When the base came from an
earlier, stable tag, a second line says so:

```
  base  major across 14 commit(s) since v1.0.0, the last stable release
```

Without it the output would show one `fix:` and then announce a major, which is
exactly the unexplained number showing the work is supposed to prevent. See
[two ranges, two questions](../guides/versions.md#two-ranges-two-questions).

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

cutver reads no environment variables of its own — its configuration is
[`cutver.json` / `cutver.yml`](config.md), and that is optional. It does read
the two GitHub Actions sets when reporting OIDC status:

| | |
| --- | --- |
| `GITHUB_ACTIONS` | Whether this is a GitHub Actions runner at all. |
| `ACTIONS_ID_TOKEN_REQUEST_URL` `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | Both present means an OIDC token can be minted. In Actions without them means the job is missing `permissions: id-token: write` — which is worth catching, because it otherwise fails at publish time with an error about credentials. |
