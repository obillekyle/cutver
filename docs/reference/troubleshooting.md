# Troubleshooting

Every one of these has actually happened, most of them to cutver itself.

## `nothing to release — no feat/fix/perf or breaking commit since v1.2.3`

Working as intended. Nothing in the range justifies a release: the commits are
docs, chores and refactors.

Pass `--if-needed` in CI so this exits 0 — most pushes warrant no release, and
a workflow that is usually red is a workflow nobody reads. Pass a version
explicitly if you want one anyway:

```bash
cutver stage 1.2.4
```

Or check that your commits are conventional. `Feat: capitalised` and
`feat:no-space` are both ignored, deliberately — guessing at unparseable
subjects would turn a typo into a release.

> **On a release branch, `since` names the last prerelease**, not the last
> stable tag — `since v1.2.0-beta.3` rather than `since v1.1.0`. That is the
> range that decides whether anything is new; the base still comes from the
> stable tag. So a docs push on a beta branch correctly cuts nothing.

## `nothing to release — 1.1.0 is already the current version`

The computed number is what the manifests already say, so there is nothing to
do and no registry would accept it twice.

Usually a re-triggered CI run: a bump commit is itself a push. The generated
workflow skips those by subject line (`chore(release):`) and passes
`--if-needed` so it exits green either way.

## `branch '0.1.0-beta' declares 0.1.0, but the commits imply 0.2.0`

The commits since the last stable tag justify a higher base than the branch
name claims. Publishing the declared version would ship a breaking change (or a
feature) under a number that promises less.

Either rename the branch as suggested, or pass the version explicitly if the
branch is right.

**If there is no stable tag at all and you get this anyway, your manifest is
the problem.** With no tag the baseline is inferred from the manifest, and on a
release branch the manifest is a prerelease *of the base the branch declares* —
so `0.1.0-beta.0` infers a baseline of `0.1.0` and the commits justifying
`0.1.0` are counted twice. Set the manifest to `0.0.0` if that version was
never published. cutver hit this on its own first branch build; the fix is in
0.1.0-beta.1 and later, so upgrade if you see it.

## `N package(s) have never been published`

The preflight, doing its job. A trusted publisher cannot perform a package's
first publish — npm has nowhere to attach one until the package exists, and on
crates.io the first publish is what reserves the name.

Publish release one by hand with a token, then automate. Or, if you have read
that and meant it:

```bash
cutver stage --allow-first-publish
```

## `working tree is not clean`

A release would capture edits nobody reviewed. Commit or stash them.

`--dry-run` skips this check, because a dry run captures nothing.

## `bun.lock has no workspace entry for packages/thing`

The lockfile predates the package. That is the stale-lock condition in a form
that would otherwise pass silently — and a stale lock is
[how seven packages shipped with unresolvable dependency ranges](../adapters/js.md#bunlock-is-not-optional).

```bash
bun install
```

## `Cargo.toml declares no version under [workspace.package] or [package]`

A workspace root needs an inheritable version:

```toml
[workspace.package]
version = "0.1.0"
```

with members reading it as `version.workspace = true`.

## `<root> has package.json and Cargo.toml`

A repository with both — a napi-rs binding, a Tauri app, a Rust crate with a
Node wrapper. cutver asks rather than guesses, because guessing wrong means
bumping the wrong manifest:

```bash
cutver stage --adapter cargo
```

---

## After the tag — publishing failures

Everything below happens after cutver has finished and gone home.

## `422 ... "repository.url" is "", expected to match ...`

Trusted publishing signs a provenance statement naming the repository that
built the tarball, and npm rejects one whose manifest disagrees — including one
that says nothing, which npm normalises to `""`.

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/you/yourpkg.git"
  }
}
```

This requirement does not exist for a token-authenticated publish, which is why
the hand-published first release sails past it and the first automated one does
not. cutver's preflight warns about it now — `! repo …` — but only from
0.1.0-beta.3 onward.

## `403` on publish, with trusted publishing configured

Two candidates.

**The package does not exist yet.** Trusted publishing cannot create it. See
above.

**The workflow filename changed.** Trusted publishing is configured per package
on npmjs.com and it *names the file*. Renaming `publish.yml`, or moving the
job, breaks the trust relationship and every publish 403s until the
configuration is updated to match.

## `npm error ... credential` in a workflow that should have OIDC

The job is missing `permissions: id-token: write`. Without it the runner cannot
mint the OIDC token and npm falls back to looking for a credential that does
not exist — so the error is about credentials rather than about permissions,
which sends you hunting for a token you deliberately do not have.

cutver reports this in the preflight when it runs inside Actions:

```
  · oidc  in GitHub Actions but no OIDC token endpoint — the job is missing
          `permissions: id-token: write`
```

## The tag was pushed and nothing published

**A tag pushed with the default `GITHUB_TOKEN` cannot trigger another
workflow.** GitHub blocks it to prevent recursion. No error, no run, nothing in
the log — the tag simply exists and the publish never happens.

The tagging workflow has to dispatch the publishing one explicitly:

```yaml
      - run: gh workflow run publish.yml -f tag="v$VERSION"
```

which needs `permissions: actions: write`. The generated workflow does this.

## `404: workflow publish.yml not found on the default branch`

GitHub indexes a workflow only once an event has matched it, and `publish.yml`
matches tags — which CI cannot push in a way that triggers anything. On a brand
new repository the hand-off fails with this until a **human**-pushed tag
registers the workflow once.

Push a tag yourself:

```bash
git push origin v0.1.0
```

If the tag already exists on the remote, delete and re-push it — the point is
that *you* push it, not the bot:

```bash
git push origin :refs/tags/v0.1.0 && git push origin v0.1.0
```

It only ever happens once per repository.

## A plain install of your package gets the oldest prerelease

npm pins `latest` on a package's *first* publish whatever `--tag` said, because
every package must have a `latest`. A project whose first release was a
prerelease therefore has `latest` stuck on it while the real channel moves on,
and `bunx your-package` keeps handing out that first beta.

cutver did this to itself: `latest` sat on `0.1.0-beta.0` through eleven more
betas. Graduating to a stable version moves it forward on its own, since a
stable publish carries no `--tag` and lands on `latest` by default. Before then,
tell people to name the channel — `bunx your-package@beta` — or move the tag by
hand:

```bash
npm dist-tag add your-package@1.3.0-beta.7 latest
```

## A published package depends on the wrong version

`bun pm pack` expands `workspace:^` from the **lockfile**, not the sibling
manifest. If `bun.lock` was not updated, every package in the release declares
a dependency on whatever version the lock still remembers.

cutver rewrites those entries. If you are publishing without it, check the
tarball before you push:

```bash
tar -xzOf dist/pkg-1.0.0.tgz package/package.json | grep '"workspace:'
```

Anything printed there is a range no consumer can resolve, and it is permanent.

## `npm publish dist/pkg.tgz` fails with `EALLOWGIT`

npm parses a bare `a/b` as a GitHub shorthand, so it tries to fetch
`github:dist/pkg.tgz` and dies with "Fetching packages of type git have been
disabled". It is not a missing-file error, which is what makes it confusing.

Use an absolute path.

## The publish half-succeeded

Six packages published, the seventh failed, and now a plain retry dies on the
first already-published package before it reaches the one that needs it.

Make the loop **resumable**: skip any package whose exact version is already on
the registry and keep going. npm would refuse the duplicate anyway; this just
refuses it earlier and does not stop.

```bash
curl -fsS -o /dev/null "https://registry.npmjs.org/$encoded_name/$version" && continue
```
