# Your first release

The first one is different from every release after it, and the differences are
the kind that only bite once — but they bite *after* you have tagged, which is
the expensive moment. Read this once and the rest are automatic.

## Look first

```bash
bunx cutver --dry-run
```

A dry run writes nothing, runs nothing, and still reports everything the real
run would do. Three things are worth reading in its output before you go on.

**The number, and where it came from.**

```
cutver: 49 commit(s) since the first commit
  minor 5
        feat: bidirectional sync engine
cutver: 0.1.0 -> 0.2.0 (minor)
```

If that says `since the first commit` rather than `since v1.2.3`, you have no
stable tag yet and the baseline came from your manifest. That is fine, and
[it has one sharp edge](#the-manifest-is-a-claim).

**The preflight**, which is asking a question you want answered now rather than
after tagging:

```
preflight (1 package(s) on npm)
  · oidc  not in CI — publishing will use whatever credential npm finds locally
  ✗ cutver  NOT on the registry — this would be its first publish
```

**The files.** Nothing surprising should be in that list.

## The manifest is a claim

A version in a manifest says *that version was released*. If nothing has been
published, the honest value is `0.0.0`.

This is not pedantry — it changes the number cutver computes. With no tags, the
manifest is the only record of what shipped, so cutver measures from it. A
`package.json` sitting at `0.1.0` that was never published means your first
release computes as `0.2.0`, skipping `0.1.0` entirely.

It shows up loudest on a release branch. cutver refused its own first build
this way:

```
cutver: branch '0.1.0-beta' declares 0.1.0, but the commits since the
        first commit imply 0.2.0 (minor).
        Rename the branch to 0.2.0-beta, or pass the version explicitly.
```

The branch name was right. The baseline was a fiction. Setting the manifest to
`0.0.0` made both agree, and the first release computed as `0.1.0-beta.0`.

> **Set your manifest to `0.0.0` before the first release** if the current
> number has never been on a registry. After the first tag exists this cannot
> recur — tags take over as the baseline.

## The first publish is manual

**A trusted publisher cannot perform a package's first publish.** npm has
nowhere to attach one until the package exists; on crates.io the first publish
is what reserves the name. Either way release one goes out by hand with a
token, and everything after it can be automated.

cutver enforces this rather than leaving it to be remembered:

```
cutver: 1 package(s) have never been published:
          cutver

        A first publish cannot go through npm trusted publishing (OIDC): there
        is nowhere to attach a trusted publisher until the package exists.
        Release one goes out by hand with a token; every release after it can
        be automated.

        Pass --allow-first-publish once you have read that and meant it.
```

So, for release one:

```bash
bunx cutver --allow-first-publish
```

```bash
git add -A && git commit -m "chore(release): v0.1.0"
```

```bash
git tag -a v0.1.0 -m v0.1.0
```

Then publish by hand, with whatever credential you normally use:

```bash
bun publish
```

> **Publishing a prerelease? Pass the dist-tag.** `bun publish --tag beta`.
> Without it npm marks the version `latest` and every plain install in the
> world resolves to your beta — silently, and only fixable by re-tagging after
> people have already installed it.
>
> On the *first* publish it gets pinned to `latest` regardless, because npm
> requires every package to have one. The flag is still not optional: it
> creates the `beta` tag that the second release needs to stay behind.

## Then hand it to CI

```bash
bunx cutver init bun
```

That writes the two workflows. Read them — the comments in them are the
reasons, not decoration — then [set up CI](ci.md), which covers what they do
and the two things about GitHub Actions that will otherwise cost you a release
each.

## Name your repository

One more manifest field, and it is invisible until the first *automated*
release fails:

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/you/yourpkg.git"
  }
}
```

Trusted publishing signs a **provenance statement** naming the repository that
built the tarball, and npm rejects one whose manifest disagrees — including one
that says nothing, which npm normalises to `""`:

```
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/cutver -
Error verifying sigstore provenance bundle: Failed to validate repository
information: package.json: "repository.url" is "", expected to match
"https://github.com/obillekyle/cutver" from provenance
```

This is a requirement a token-authenticated publish never had, which is exactly
why the hand-published first release sails past it and the first automated one
does not. cutver's preflight compares the field against your git remote and
warns:

```
  ! repo  cutver names no repository, but this checkout is github.com/you/yourpkg
```

It reports rather than fixes. Filling the field in from `git remote get-url
origin` writes the *fork's* URL on a fork, where it passes locally and fails
identically upstream — and it cannot fix the other half of the failure, a
`repository` that is present and stale.

## The whole sequence

For a package that has never been published, in order:

1. Set the manifest to `0.0.0` if its current version was never released.
2. Add `repository` to the manifest.
3. `cutver --dry-run` and read it.
4. `cutver --allow-first-publish`, commit, tag.
5. Publish by hand — with `--tag` if it is a prerelease.
6. Configure trusted publishing on the registry, naming your repo and
   `publish.yml`.
7. `cutver init`, push, and never do steps 3–5 again.
