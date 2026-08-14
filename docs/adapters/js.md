# npm and Bun

Selected when there is a `package.json`. Forceable with `--adapter js`.

```
files
  = apps/example/package.json                  private — left alone
  ↑ packages/cli/package.json                  2.0.0-alpha.6 -> 2.0.0-alpha.7
  ↑ packages/core/package.json                 2.0.0-alpha.6 -> 2.0.0-alpha.7
  ↑ package.json                               2.0.0-alpha.6 -> 2.0.0-alpha.7
  ↑ bun.lock                                   8 workspace entries
  ↑ CHANGELOG.md                               new heading [2.0.0-alpha.7]
```

## What gets bumped

**Every non-private workspace package, plus the root.**

Workspaces come from the root manifest's `workspaces` field — the array form or
the `{ packages: [...] }` form, whichever you use — expanded against the
filesystem. `node_modules` is never walked into, however permissive your globs
are.

A package with `private: true` is left alone and reported. Nobody resolves a
range against it, it will never reach a registry, and dragging it along makes
the diff of a release larger than the release. The same goes for a package with
no `version` field at all.

**The root is bumped even when it is private**, because it is the version of
record — the number your tag is cut from. Letting it drift away from the
packages it contains is how a monorepo ends up with two answers to "what
version is this".

Nothing else is a workspace? Then it is just the root manifest, which is the
shape most packages ship in.

## `bun.lock` is not optional

This is the part that makes the adapter more than a JSON edit, and it is the
part that shipped broken once.

**`bun pm pack` expands `workspace:^` using the version recorded in the
lockfile**, not the one in the sibling manifest. CI installs with
`--frozen-lockfile`, so the lock stays at the old version indefinitely — a
plain `bun install` will not update it either, because Bun rewrites the lock
when the dependency *graph* changes and a version bump is not a graph change.

The result: seven packages published at `2.0.0-alpha.2` while every one of them
declared a dependency on `@scope/core@^1.2.3`. Installing anything from the
alpha channel resolved a *stable* core — the one version the alpha plugins
could not run against. The channel was dead on the registry while every gate in
the repository was green.

cutver rewrites those lines in place:

```
  ↑ bun.lock  8 workspace entries
```

Anchored to the workspace key, so it cannot wander into the resolved-packages
section below where a same-named entry means something completely different.

> **Do not "simplify" this to delete-the-lock-and-reinstall.** That works, and
> it re-resolves every external dependency *after* your gates have already run
> — publishing a tree that nothing tested. Only these lines may move, so only
> these lines are touched.

If a package cutver just bumped has no lockfile entry, it refuses:

```
cutver: bun.lock has no workspace entry for packages/new-thing
```

That means the lock predates the package — the same stale-lock condition, in a
form that would otherwise pass silently. Run `bun install` and try again.

A missing `bun.lock` entirely is fine and reported: a checkout that has never
installed has nothing to keep in sync, and the next install writes the current
versions anyway.

## Other lockfiles

`package-lock.json`, `pnpm-lock.yaml` and `yarn.lock` are **named in the output
and not touched**:

```
  = package-lock.json  not maintained by cutver — reinstall to refresh it
```

They record workspace versions too, so the bug above has a shape in each of
them. Rewriting three more lockfile formats in place is not a promise worth
making, so the honest move is to name the file and say who has to deal with it:
reinstall before you publish.

## Your formatting survives

The manifest is written back with the indentation and line endings it arrived
with — tabs stay tabs, four spaces stay four spaces, CRLF stays CRLF.

`JSON.stringify(json, null, 2)` is the obvious implementation and it is fine
right up until it meets somebody else's tab-indented manifest, at which point a
one-line version bump produces a diff of the entire file and the actual change
becomes the hardest thing to find in the review.

## Publishing

cutver stops before this. The workflow [`cutver init`](../getting-started/ci.md)
writes does it, and one detail in it is load-bearing:

**Bun packs, npm publishes.** `workspace:^` is a protocol npm does not
understand — Bun rewrites it to a real range when it builds a tarball, and npm
does not. Measured on the same package:

```
npm pack     -> "@scope/core": "workspace:^"   (broken)
bun pm pack  -> "@scope/core": "^1.0.0"        (correct)
```

So publishing straight from the working tree with npm ships manifests no
consumer can resolve, permanently. Packing with Bun and handing npm a finished
tarball keeps the rewriting *and* gets OIDC, because npm publishes the bytes it
is given.

## Monorepos

Everything above already is the monorepo behaviour — one version across every
publishable package, in lockstep.

If you want independent versions per package, cutver is the wrong tool and will
stay the wrong tool. Lockstep is what makes "the tag is the record" true: one
number, one tag, one thing to check.

For the publish loop across many packages, make it **resumable**. Eight
publishes are eight chances to fail partway, and the first real run of one did
exactly that — six succeeded, the seventh failed, and the naive retry died on
the first already-published package before reaching the one that needed it.
Skip a package whose exact version is already on the registry and keep going.
