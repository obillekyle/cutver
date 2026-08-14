# Alphas, betas and RCs

Three channels, in semver precedence order — which is also alphabetical, so
`1.3.0-alpha.7` sorts below `1.3.0-beta.0` sorts below `1.3.0-rc.0` sorts below
`1.3.0`. That is not a coincidence anyone should rely on twice, but it does
mean the obvious thing works.

```bash
cutver --beta
```

The base is computed exactly as a stable release would be, then the channel and
a counter are attached.

| Last stable | Commits imply | Current | `--alpha` gives |
| --- | --- | --- | --- |
| 1.2.3 | minor | 1.2.3 | 1.3.0-alpha.0 |
| 1.2.3 | minor | 1.3.0-alpha.0 | 1.3.0-alpha.1 |
| 1.2.3 | minor | 1.3.0-alpha.9 | 1.3.0-alpha.10 |

Pick one channel. `--alpha --beta` is refused rather than resolved.

## The counter restarts when it must

**Continue only when the base *and* the channel both match.** Anything else
restarts at `.0`, because carrying a counter across a change would produce a
version sorting below one already published.

A channel change restarts it:

```
1.3.0-alpha.7  --beta  ->  1.3.0-beta.0
```

Not `beta.8`. It would sort correctly by luck — `beta.8` is above `alpha.7` —
and then break the first time someone opened a channel out of order.

A base change restarts it too:

```
1.3.0-alpha.3  + a feat!  --alpha  ->  2.0.0-alpha.0
```

Not `2.0.0-alpha.4`, which would imply three earlier `2.0.0` alphas that never
existed.

## Release branches

A branch named `1.2.0-beta` declares its own base and channel: *this branch is
building towards 1.2.0, publishing betas along the way.* cutver reads it, so
you do not pass `--beta` on every cut.

```
cutver: 1.2.0-beta.2 -> 1.2.0-beta.3 (declared by branch '1.2.0-beta')
```

`v1.2.0-beta` and `release/1.2.0-beta` work identically. Anything that is not a
version falls through to the ordinary computation — `main`, `master`,
`feat/window-functions`, and deliberately also `1.2.0-fix`, which is a feature
branch and not a channel.

**A push with nothing new in it cuts nothing.** Whether to release is measured
from the last release of *any* kind, so a docs or chore commit on top of
`1.2.0-beta.3` reports "nothing to release" rather than spending `beta.4` on
it. The base is still measured from the last stable tag — see
[two ranges, two questions](versions.md#two-ranges-two-questions).

**The name carries the channel, never the counter.** `1.2.0-beta.3` is not a
valid branch declaration and is ignored: if the name carried the number, every
cut from that branch would be `beta.0` forever. The counter comes from the
manifest.

> **Branch names are not history.** They are mutable, they get deleted after a
> merge, and nothing in the repository records that `1.2.0-beta.3` came from
> one. This is a convenience for choosing the number and never the record of
> it — the tag is the record, and cutver still tells you to create one.

### When the commits outvote the branch

If the commits since the last stable tag imply a *higher* base than the branch
declares — a `release:` or a `feat!` landed on a `1.2.0-beta` branch — cutver
refuses:

```
cutver: branch '1.2.0-beta' declares 1.2.0, but the commits since v1.1.0
        imply 2.0.0 (major).
        Rename the branch to 2.0.0-beta, or pass the version explicitly if
        the branch is right.
```

Refused rather than warned, because publishing `1.2.0` there would ship a
breaking change as a minor, and a warning scrolls past in a CI log while the
wrong version goes out anyway.

> **This check needs a stable tag to mean anything, and only runs when there is
> one.** With no tag the baseline is inferred from your manifest — and on a
> release branch your manifest is a prerelease *of the base the branch
> declares*, so `0.1.0-beta.0` infers a baseline of `0.1.0` and the commits
> that justify `0.1.0` get counted a second time on top of it. cutver refused
> its own first branch build exactly that way, advising a rename to
> `0.2.0-beta` that would have skipped `0.1.0` entirely. The guard protects
> people who already installed a stable release; where none has been published
> there is nobody to protect.

## Graduating

Cut it stable. No flag, no branch declaration:

```bash
cutver
```

The base comes from the last stable tag plus the bump across every commit since
it, so a `1.3.0-beta.4` graduates to **`1.3.0`** — the base the beta was for —
rather than to `1.3.1`. And if a `feat!` landed during the beta, it graduates
to `2.0.0` instead. Both fall out of the same rule; neither is a special case.

## Publishing a prerelease

**Pass the dist-tag.** cutver reminds you, every time it cuts one:

```
  Publish this one with `--tag beta`. Without it npm marks
  1.3.0-beta.0 as `latest` and every plain install resolves to a
  prerelease. Consumers opt in with `@beta`.
```

npm's default is `latest`, it is silent, and undoing it means re-tagging by
hand *after* people have installed the beta. The workflow `cutver init` writes
derives the dist-tag from the version so this cannot be forgotten in CI — and
refuses an unrecognised prerelease rather than defaulting it.

> **The first publish of a package pins `latest` regardless.** Every package
> must have a `latest`, so npm sets it even when you passed `--tag beta`. The
> flag still matters — it creates the `beta` tag that every later release stays
> behind — but the first one lands on both. Nothing to do about it except know
> it, and tell people to install `@beta` until you graduate.
