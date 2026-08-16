# Set up CI

```bash
bunx cutver init bun
```

`cargo`, `node` and `bun` are the three. It writes:

```
cutver: /repo (bun)
  ↑ .github/workflows/version.yml  created
  ↑ .github/workflows/publish.yml  created
  ↑ CHANGELOG.md                   created
  ↑ cutver.yml                     created
  ↑ package.json                   devDependency cutver@^2.0.0
  ↑ pre-push (git hook)            created

  first: run your package manager's install. devDependency cutver@^2.0.0 is in
         package.json and not yet in the lockfile, and the generated
         workflow installs with --frozen-lockfile.
```

Nothing is overwritten without `--force`, and `CHANGELOG.md` not even then — it
holds prose someone wrote.

### What that changed besides the workflows

Three of those six are easy to skim past, and each of them changes behaviour.

- **`cutver.yml` now declares `release: [main]`.** Before `init`, the default is
  every branch, because a tool that releases nothing until it is configured is a
  tool that appears broken. Running `init` is choosing, so it writes the choice
  down — and on a repository whose trunk is `master` or `trunk`, that is the
  line to edit first. The file is commented throughout;
  [Configuration](../reference/config.md) is the long form.
- **`package.json` gained cutver as a devDependency**, pinned to the version
  that generated the workflows, so CI and your laptop run the same one. Cargo
  repositories get nothing here — the workflow downloads the executable instead.
- **The `first:` line is load-bearing.** The generated workflow installs with
  `--frozen-lockfile`, so a new devDependency and an untouched lockfile is a
  first CI run that fails before it reaches cutver. Run your install and commit
  the lockfile with the rest.

The pre-push hook is installed too, unless `--no-hook`. It refuses a push whose
branch name promises a lower version than its commits justify, and lets
everything else through — [Hooks](../guides/hooks.md).

### Starting from nothing is the normal case

`init` is for a repository that has **never released anything**, and none of the
things a release tool usually wants have to exist first:

| | |
| --- | --- |
| **No tags** | The version is measured from the last stable tag *if there is one*. With none, the range is every commit in the repository and the base is whatever the manifest says. A brand-new project at `0.0.0` is the case this was written for. |
| **No changelog** | `CHANGELOG.md` is created, with an `## [Unreleased]` heading and nothing under it. |
| **No config** | `cutver.yml` is created. Until then every branch may release, which is the default so that a repository that has not been configured does not look broken. |
| **No published package** | The preflight says so rather than guessing, and [Your first release](first-release.md#the-first-publish-is-manual) covers the one publish that has to be manual. |
| **Not even a git repository** | Everything is written; only the hook is skipped, and it says which line it skipped and why. Scaffolding before `git init` is a reasonable order to work in. |

What that means in practice: on a fresh project, `cutver init` then a first
`feat:` commit is the whole setup. There is no import step, no history to
backfill, and nothing to migrate from.

## Two workflows, never one

The obvious design is one `release.yml` that computes a version, tags it and
publishes. It is easier to write and it throws away the only property that
matters.

Publishing is irreversible. A version number can never be reused, by anyone,
ever. So it gets **its own trigger and its own credentials**:

| | `version.yml` | `publish.yml` |
| --- | --- | --- |
| Fires on | a push to `main` or a `*-beta` branch | a `v*` tag, or a manual dispatch |
| Does | runs your gates, computes a version, commits, tags | verifies, packs, publishes |
| Needs | `contents: write`, `actions: write` | `id-token: write` |
| Reversible | yes — delete the tag | **no** |

A bad merge can cost you a tag. It cannot cost you a version number.

## The two things that will bite you

Both are in the generated files as comments. They are repeated here because
comments get deleted.

### A tag pushed by CI cannot trigger another workflow

GitHub refuses to create workflow runs from events made with the default
`GITHUB_TOKEN`, to prevent recursion. So `version.yml` pushing a tag does
**not** start `publish.yml`, even though `publish.yml` triggers on `push: tags`.

The first automated release that got this wrong tagged `v1.0.1` and then
nothing happened at all — no error, no run, no publish.

`workflow_dispatch` is one of the two documented exemptions, so the tagging job
asks explicitly:

```yaml
      - name: Hand off to publish.yml
        if: steps.check.outputs.released == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ steps.check.outputs.value }}
        run: gh workflow run publish.yml -f tag="v$VERSION"
```

That step is why `version.yml` needs `permissions: actions: write`.

> **A brand-new repository has one more wrinkle.** GitHub only indexes a
> workflow once an event has matched it, and `publish.yml` matches only tags —
> which CI cannot push in a way that triggers anything. So on a fresh repo the
> hand-off can fail with `404: workflow publish.yml not found on the default
> branch` until a *human*-pushed tag registers it once. Push your first tag
> yourself and the problem never returns.

### "Did a release happen" is the version, not `git status`

The tempting check is whether the tree is dirty. It is wrong twice over: it
reports an unrelated formatter edit as "a release happened", and a run that
believes that then dies trying to create a tag that already exists.

The generated workflow reads the version before and after instead:

```yaml
      - name: Did the version move?
        id: check
        env:
          BEFORE: ${{ steps.before.outputs.value }}
        run: |
          after=$(bun -e 'console.log(require("./package.json").version)')
          if [ "$after" != "$BEFORE" ]; then
            echo "released=true" >> "$GITHUB_OUTPUT"
            echo "value=$after" >> "$GITHUB_OUTPUT"
          else
            echo "released=false" >> "$GITHUB_OUTPUT"
          fi
```

## Your gates are yours

cutver does not run your tests. It cannot know what they are, and a release
tool that guesses at your build commands is a release tool that skips them.

The generated `version.yml` leaves a marked spot before the bump:

```yaml
      # cutver does not run your gates: it cannot know what they are. They go
      # here, before anything is written, so a release cannot be cut from a
      # tree that does not pass.
      - run: bun test
```

Put your real gates there. They run **before** the version is written, so a
release can never be cut from a tree that does not pass.

## `--if-needed`

Most pushes are docs and chores and warrant no release. Without `--if-needed`
cutver exits 1 on those, so every ordinary merge ends in a red cross — and a
workflow that is usually red is a workflow nobody reads.

The generated workflow passes it. `--branch` is there for the same class of
reason: CI checks out a detached HEAD, where git answers the literal string
`HEAD` and the real branch name only exists in the event payload.

```yaml
      - run: bunx cutver stage --if-needed --branch '${{ github.ref_name }}'
```

## Skipping the bump commit

`version.yml` commits the bump, which is itself a push, which re-triggers
`version.yml`. It would correctly find nothing to release and exit 0 — but it
is a wasted run every time, so the job skips itself by subject line:

```yaml
    if: "!startsWith(github.event.head_commit.message, 'chore(release):')"
```

Keep that prefix if you change the commit message.

## What the publish job does

Beyond the actual publish, three guards worth keeping:

- **Refuse if the tag and the manifest disagree.** A tag can be created by
  hand, and by hand it can be put on the wrong commit. Publishing then ships
  whatever the manifest says under a tag claiming something else, and both are
  permanent.
- **Run the gates again.** A tag can be moved; a branch can be force-pushed.
  This is the last point anything can stop.
- **Derive the dist-tag from the version, never pass it in.** `1.2.0-beta.3`
  publishes under `beta`. An unrecognised prerelease is refused rather than
  defaulted to `latest`.

## Cargo

`cutver init cargo` differs in three places, all for the same reason — a Rust
workspace has no JavaScript package manager and should not need one:

- cutver is fetched as the **compiled executable**, not through `bunx`.
- Gates default to `cargo test --workspace`.
- Publishing uses `cargo publish --workspace` with `CARGO_REGISTRY_TOKEN`.
  crates.io supports trusted publishing too, and switching to it removes the
  secret — worth doing, and worth checking the current action version yourself
  rather than trusting a file a tool generated months ago.

## Pages, while you are here

These docs are a folder of markdown and one `index.html` that renders it. If
you want the same, point GitHub Pages at `docs/` on your default branch and add
a `CNAME`. There is no build step to run and nothing to deploy.
