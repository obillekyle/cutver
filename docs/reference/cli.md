# CLI

```
cutver                                          help, like a bare `bun`
cutver stage [<channel>|<version>]              work out the next version and write it
cutver notes <tag> | <from> <to>                the release body on stdout
cutver changelog [file | pages [<selector>]]    rebuild the file, or the release pages
cutver check                                    may this branch release what it implies
cutver doctor                                   one read-only report of everything
cutver explain                                  which rule claims this branch
cutver config                                   the effective configuration
cutver init [<ecosystem>]                       write version.yml + publish.yml
cutver docs install|update                      scaffold or re-render the docs site
cutver hook install|uninstall                   the pre-push guard
cutver completions <bash|zsh|fish>              a completion script
cutver help [command]                           this, or one command in full
cutver version                                  the version of cutver itself
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
| `stage` | Work out the next version from the commits and write it into every manifest. Then stop — no commit, no tag, no publish. Takes a channel (`beta`), a version (`1.4.0`), or `release` to force a stable one whatever the branch is configured to cut. With no argument the branch decides. Also refreshes `docs/versions.json` [where one exists](#docsversionsjson). |
| `notes` | The release body for a tag, on stdout: the `CHANGELOG.md` section for that version, rewritten by the [summariser](config.md#the-summariser) if one is configured. A range compiles from the commits instead and never reads the changelog. Never fails over content: no changelog, no section, or a summariser that died each print why and exit 0. A missing or extra argument still exits 1. This is what the generated `publish.yml` calls. |
| `changelog` | Two targets, because they are two jobs. `file` — the default — rebuilds `CHANGELOG.md` from the tags. `pages` writes the compiled sections onto the GitHub releases, **creating one where a tag has none**. Releases nothing either way: no manifest, no tag, no version. Needs `changelog:` set. See [the selectors](#changelog-pages). |
| `check` | Exit 1 only if this branch may not release what its commits imply. Read-only and offline. See [the pre-push guard](../guides/hooks.md). |
| `doctor` | Everything `check` deliberately will not say, in one report: the config as resolved, the plan for this branch, commits that are not conventional, drift between the config and the generated workflows, whether the summariser holds a key, and whether the registry has heard of each package. Exits 1 on anything that would affect a release. |
| `explain` | Which rule claims this branch, and every rule that was tried and did not fire. Read-only, offline, always exits 0. See [Configuration](config.md). |
| `config` | The configuration as cutver resolved it, with every default merged in and every channel normalised — so a key ignored because it was misspelt is visible by its absence. JSON on stdout, which is a format cutver also reads. |
| `init` | Set the repository up to release: both workflows, a `CHANGELOG.md` stub, a commented `cutver.yml`, cutver pinned as a devDependency, and the pre-push guard. The ecosystem is detected when omitted. Two of those change behaviour — see [Set up CI](../getting-started/ci.md#what-that-changed-besides-the-workflows). |
| `docs` | Scaffold this documentation site into a repository, or re-render its shell. `install` writes the site and keeps whatever is already there; `update` rewrites `docs/index.html` only. The shell is generated so that a fix reaches every project that runs the command, rather than the one repository somebody remembered to paste into. See [the docs site](#the-docs-site). |
| `hook` | Install or remove a `pre-push` hook that runs `check`. |
| `completions` | A completion script for bash, zsh or fish, on stdout. Nothing is installed for you. |
| `help` | The list above, or the long form for one command — the same text `cutver` bare prints. |
| `version` | The version of cutver itself, and nothing else. `--version` anywhere does the same. |

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
| `--adapter js\|cargo` | (`stage`, `check`, `doctor`, `explain`) Force the manifest adapter. Only needed when a repository has both manifests — every command that resolves one accepts it, since every one of them can be stopped by the ambiguity. |
| `--cwd <path>` | (every command) Repository root. Defaults to the working directory. |
| `--branch <name>` | (`stage`, `check`, `doctor`, `explain`) Branch name, for CI on a detached HEAD where git answers the literal string `HEAD`. |
| `--if-needed` | (`stage`) Exit 0 rather than 1 when no release is warranted. What CI wants. |
| `--offline` | (`stage`, `doctor`) Skip the registry lookups entirely. |
| `--allow-first-publish` | (`stage`) Proceed even though a package is not on the registry yet. |
| `--force` | (`init`, `hook`, `changelog`, `docs`) Replace files that are already there. Never replaces `CHANGELOG.md`, and never a `pre-push` hook cutver did not write. With `changelog --overwrite` it replaces written release bodies too — see below. |
| `--rev <commit>` | (`check`) The commit to judge, default `HEAD`. The hook passes the sha of the ref being pushed, which is not always the one checked out. |
| `--runner <cmd>` | (`hook`) Pin how the hook invokes cutver, instead of detecting it at run time. |
| `--no-hook` | (`init`) Do not install the pre-push guard. Everything else is written as usual. |
| `--overwrite` | (`changelog`) **Deprecated — now `cutver changelog pages`.** Still works: rebuilds the file *and* updates the release pages. **Creates the page when a tag has none**, which is the case a project adopting `changelog:` after a year of tagging is in. **Only replaces a body nobody wrote** — empty, the version repeated, or GitHub’s own generated notes; anything else is reported and left alone. Summarised when a [summariser](config.md#the-summariser) is configured, so a page filled in afterwards reads the same as one written at release time. Needs a token: `GH_TOKEN`, `GITHUB_TOKEN`, or a signed-in `gh`. |
| `--config <path>` | (every command) Read this config instead of looking for one. Given and missing is an error, never a silent fallback to the defaults. |
| `-h`, `--help` | Usage. |
| `-v`, `--version` | The version of cutver itself. |

`--adapter js` and `--adapter=js` both work, as does every other option that
takes a value.

**A flag outside its command is refused, not ignored.** `cutver check
--dry-run` exits 1 naming the flag rather than proceeding as though it had been
understood — the failure it replaces is a CI step that passes while doing
something other than what its arguments say.

### `changelog pages`

```bash
cutver changelog pages v1.2.0
```

| selector | |
| --- | --- |
| *(none)* | The tags the file lists — what `--overwrite` always did. |
| `all` | Every tag, prereleases included. |
| `5` | The newest five. |
| `v1.2.0` | That one. The `v` is optional. |

**`keep` and `prereleases` describe the file, not these.** The file is a
narrative with a length; a release page is one per tag. So with
`prereleases: false` an alpha's commits fold into the stable release that ships
them — right for the file — while the alpha itself is a version somebody
installed through a dist-tag and can land on from a link. `all` gives it a page,
with its body compiled from its own range, exactly as `notes` does when asked
for a tag the changelog does not list.

`keep` never limited the pages: it is applied when the file is rendered, not
when the sections are compiled.

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
   error, not a guess. `check`, `doctor` and `explain` report it rather than
   failing on it — `check` runs from the pre-push hook, and a guard that fails
   closed on an ambiguity it can describe would block every push in a
   dual-manifest repository.
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

**Nothing here configures behaviour** — that is what
[`cutver.json` / `cutver.yml`](config.md) is for, and it is optional. What the
environment holds is credentials, which must never be written into a tracked
file, plus what CI tells cutver about itself.

| | |
| --- | --- |
| `CUTVER_SUMMARIZE_KEY` | The summariser's API key. Tried first, so CI sets one name whatever the connector is. |
| `ANTHROPIC_API_KEY` `OPENAI_API_KEY` `GEMINI_API_KEY` `GOOGLE_API_KEY` | The provider's own convention, tried after it, so a laptop that already exports one needs no extra setup. Which is read depends on `connector`. |
| `CUTVER_SUMMARIZE` | Any command that reads markdown on stdin and writes markdown on stdout, used instead of a connector. Wins when both are set — it is the more specific instruction, and it is what overrides a repository's default without editing a tracked file. |
| `GH_TOKEN` `GITHUB_TOKEN` | For `changelog --overwrite`, which writes release bodies. `GH_TOKEN` first; `GITHUB_TOKEN` is present in every Actions run without being asked for. With neither set, cutver runs **`gh auth token`** and uses that, saying so when it does — `--overwrite` is usually run once from a laptop where `gh` has been signed in for months, and minting a personal access token for a capability you already have is busywork. The environment still wins. |
| `GITHUB_ACTIONS` | Whether this is a GitHub Actions runner at all. |
| `ACTIONS_ID_TOKEN_REQUEST_URL` `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | Both present means an OIDC token can be minted. In Actions without them means the job is missing `permissions: id-token: write` — which is worth catching, because it otherwise fails at publish time with an error about credentials. |

A `.env` or `.env.local` supplies these locally, including to the standalone
executables. It is read **from the directory cutver was launched in, not from
`--cwd`** — the load happens at process startup, before a flag has been looked
at. The symptom is `no key is set` naming variables you are sure you exported.

## The docs site

```bash
cutver docs install
```

Writes `docs/index.html`, `docs/site.json`, a starter `pages.json` and two
markdown pages, skipping anything already there. Re-runnable: a repository that
has the site already gets only whatever is missing.

```bash
cutver docs update
```

Re-renders `docs/index.html`, and nothing else.

**The shell is generated, and that is the feature.** It used to be copied
between repositories, which meant a fix reached whichever one somebody
remembered to paste into. It also meant a copy could be wrong in ways nobody
saw: this site once served another project's brand colour to every reader whose
OS was dark and who had never touched the theme control, because the palette is
stated in three CSS blocks and only two of them were re-themed. All three come
from one value now.

| File | Whose |
| --- | --- |
| `docs/index.html` | cutver's. Replaced on every `update`, so nothing edited here survives. |
| `docs/site.json` | cutver format, your values. Name, description, icon, repository, colours. |
| `docs/versions.json` | cutver format, your data. Seeded from the tags at install, refreshed by `stage`. |
| `docs/pages.json` | Yours. The sidebar. Never replaced. |
| The markdown | Yours. The pages. Never replaced. |

```json
{
  "name": "cutver",
  "description": "Work out the next version from your commit messages.",
  "icon": "✂️",
  "repo": "https://github.com/obillekyle/cutver",
  "theme": {
    "light": { "brand": "#0f766e" },
    "dark": { "brand": "#5eead4" }
  }
}
```

`name`, `description`, `icon` and `repo` are required; `theme` is not.

**`icon` takes an emoji or the URL of an image**, and the two render
differently rather than one being converted into the other. An emoji is drawn
into an SVG `<text>` for the favicon and stays a character in the header. A URL
is handed to the browser as it is — `<link rel="icon" href="…">` and an `<img>`
— so an existing mark can be used without tracing it:

```json
{ "icon": "assets/logo.svg" }
```

Absolute, root-relative and relative URLs all work, the last resolving against
`docs/`. Anything containing `/` or `:`, or ending in an image extension, is
taken as a URL; everything else is an emoji. The image is sized in `em`, so it
tracks the wordmark beside it rather than arriving at its intrinsic size.

`theme.light` and `theme.dark` set CSS custom properties on the shell, written
without their leading dashes. Anything the shell defines can be set, and
anything left out keeps its default — a project that only wants its own accent
writes one line rather than a palette. Storage keys are namespaced from `name`,
so two sites served from one origin do not read each other's theme and pinned
version.

**Only `install` accepts `--force`, and it stops at the content.** It rewrites
`site.json` and `versions.json` in the current schema, keeping the values in
them — so adopting a new field does not mean hand-editing every project. It does not touch the markdown or
`pages.json` whatever is passed, because those are the site and a scaffolder
has no undo. `update` needs no such flag: replacing the shell is all it does.

`--dry-run` reports every one of those decisions and writes nothing, which is
the way to see what `--force` would reset before running it.

## `docs/versions.json`

A versioned docs site needs to know which versions exist. If this file is
present, `cutver stage` rewrites it from the tags — newest first, plus the
version being cut, whose tag does not exist yet:

```json
{
  "latest": "2.2.0",
  "versions": ["2.2.0", "2.1.4", "2.1.3"]
}
```

**Its presence is the opt-in.** There is no config key: commit `[]` once and
cutver keeps it current, or never create it and never see the feature. So `init`
scaffolds nothing new and `doctor` has nothing new to check.

`latest` is the newest tag, prerelease and all — a project living on
`2.0.0-alpha.9` should say so rather than showing a stable release it left
behind, which is what npm's `latest` does, being pinned on a package's first
publish whatever `--tag` said.

**Why a file rather than a lookup.** Reading the tags when the page loads means
GitHub's tags API and its 60 unauthenticated requests an hour *per IP*, shared
by every reader behind one corporate NAT. Reading a registry instead ties the
site to having published a package, which a Rust workspace shipping binaries has
not. cutver already reads these tags to work out the number, so it writes them
down while it has them.

The ordering is cutver's own comparison, not `sort -V` or
`git --sort=-v:refname`: both of those place a prerelease *above* the release it
precedes, so `1.0.0-beta.1` would sort over `1.0.0`.
