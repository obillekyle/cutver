# How the number is chosen

Conventional commits, since the last **stable** tag. The strongest bump in the
range wins.

| Commit | Bump |
| --- | --- |
| `feat!:`, `fix!:`, any `type!:` | major |
| a body line starting `BREAKING CHANGE:` or `BREAKING-CHANGE:` | major |
| `release:` | major |
| `feat:` | minor |
| `fix:`, `perf:` | patch |
| `docs:` `chore:` `refactor:` `test:` `style:` `build:` `ci:` | none |
| anything else | none |

A scope does not hide the marker: `feat(cli)!:` is a major, and so is
`refactor(orm,core)!:`. The `!` is checked before the type, so a `chore!:` is a
major too — if it breaks something, it breaks something.

## Both breaking markers count

A lot of tooling reads only the `BREAKING CHANGE:` footer. That is a bad bet:
in the history cutver's rules were written against, five commits marked a break
with `!` in the subject and exactly **one** of them also wrote the footer. A
body-only scanner would have shipped four breaking changes as patches.

The footer has to start a line, too. Repositories discuss breaking changes in
prose constantly, and "this is not a BREAKING CHANGE: it only affects…" is not
one.

## Nothing unrecognised is guessed at

`Merge branch main`, `WIP`, `Feat: capitalised`, `feat:no space` — all produce
no bump. Returning `patch` for anything unparseable would turn a typo into a
release. Silence is the safe direction: the worst case is a release you have to
ask for explicitly.

If nothing in the range justifies one:

```
cutver: nothing to release — no feat/fix/perf or breaking commit since v1.2.3.
        Pass a version explicitly to override.
```

Exit 1, or exit 0 under `--if-needed`, which is what CI wants.

## Two ranges, two questions

**Is there anything to release?** Measured from the last release of any kind,
prereleases included.

**What is the base?** Measured from the last *stable* tag, always.

They are different questions and merging them breaks something either way.

Measure both from the stable tag and a long-lived `1.2.0-beta` branch cuts a
new beta on every push forever: the range still holds every `feat:` the branch
was opened for, so a docs-only commit looks exactly like new work and spends a
beta number on nothing.

Measure both from the last *tag* and you get the classic bug back — a `feat!`
that lands during a beta is measured against `1.3.0-beta.2` and ships as
`1.3.0`, a breaking change released as a minor.

When the two ranges differ, cutver says so rather than leaving you to work out
where a major came from when only a `fix:` is on screen:

```
cutver: 1 commit(s) since v2.0.0-beta.0
  patch 1
        fix: a small thing
  base  major across 14 commit(s) since v1.0.0, the last stable release
cutver: 2.0.0-beta.0 -> 2.0.0-beta.1 (declared by branch '2.0.0-beta')
```

## The baseline is the last stable tag

This is the rule that matters most, and it is wrong in both obvious directions.

**Not the current version.** Bumping the version in the manifest means
`1.2.0-rc.1` graduates to `1.2.1`, silently skipping the `1.2.0` everyone spent
the release candidate testing.

**Not the last tag either.** Measuring from `v1.3.0-beta.2` means a `feat!`
that lands during the beta gets measured against a prerelease and ships as
`1.3.0` — a breaking change released as a minor.

Computing from the last *stable* tag handles both without a special case. The
base is recomputed from scratch every time, so escalation just works, and
graduating a prerelease is "the same base, minus the tag":

| Last stable | Commits imply | Current | Result |
| --- | --- | --- | --- |
| 1.2.3 | minor | 1.2.3 | 1.3.0 |
| 1.2.3 | minor | 1.3.0-beta.4 | 1.3.0 — the base the beta was for |
| 1.2.3 | major | 1.3.0-beta.2 | 2.0.0 — the break wins |

## With no tags, the baseline is your manifest

A repository that has never tagged anything has one record of what shipped: the
version in its manifest. So that is what cutver measures from.

The alternative — starting at `0.0.0` — is wrong in a way that is easy to miss.
Against a manifest at `0.1.0`, a minor computes `0.1.0`: the version you are
already on, so cutver reports "nothing to release" across your entire history.
And a patch computes `0.0.1`, which is *lower* than what you have and which the
semver check would happily accept.

> **The catch:** a manifest is a claim that that version was released. If yours
> holds a number that never reached a registry, fix that first — see
> [Your first release](../getting-started/first-release.md#the-manifest-is-a-claim).
> After the first tag exists this cannot recur.

## Overriding it

Pass a version and the computation is skipped entirely:

```bash
cutver 1.4.0
```

Still validated — a computed version is checked too, as cheap insurance against
a bug in the arithmetic. Prerelease and build metadata are allowed; a leading
`v` is not, because the tag adds it and `v1.1.0` is not a valid version string
in any manifest.

## "Already the current version"

```
cutver: nothing to release — 1.1.0 is already the current version.
```

The computed number matches what the manifests already say, so there is nothing
to do. That number is spent — no registry will take it twice.

This is not a hypothetical guard. A tagging workflow pushes the branch and the
tag in one step, but workflows trigger per ref, so a run can start before the
tag is visible. The tag lookup then finds nothing, measures across the whole
history, and lands back on the version already written.

Guarding on the version rather than on a clean tree also makes the check immune
to unrelated dirt, which is what CI was actually tripping over.

## Where to go next

- [Alphas, betas and RCs](channels.md) — prerelease counters, and the release
  branch that names its own base.
- [Changelogs](changelog.md) — what cutver writes, and what it deliberately
  does not.
