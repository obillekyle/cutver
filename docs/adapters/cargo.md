# Cargo

Selected when there is a `Cargo.toml`. Forceable with `--adapter cargo`.

```
files
  ↑ Cargo.toml  [workspace.package] 0.1.0 -> 0.2.0
  ↑ Cargo.lock  cargo update -w
```

## What gets bumped

**`[workspace.package] version`**, which is the one number every member
inherits with `version.workspace = true`:

```toml
[workspace.package]
version = "0.1.0"
edition = "2021"
license = "MIT"
```

A single-crate repository with no `[workspace]` table at all works too — the
plain `[package] version` is the fallback. Where both exist, `[workspace.package]`
wins, because that is the one the members are reading.

`[workspace.dependencies]` is full of `version = "1"` lines. cutver locates the
table first and reads the version inside it, so picking up `serde`'s version
instead of yours is not a failure mode it has.

## Members that pin their own version

Reported, never rewritten:

```
  = crates/thing/Cargo.toml  pins its own version — left alone
```

A crate with a literal `version = "0.3.1"` in its own `[package]` has opted out
of lockstep on purpose. Quietly dragging it to the workspace number would be
the tool overruling a decision it cannot see the reason for.

Saying so is the useful half. This is the Cargo-shaped version of a manifest
being silently left behind, which in the npm world ran for seven releases
before anyone noticed.

## `Cargo.lock`

Reconciled with `cargo update -w` after the manifest is written.

`-w` and not a bare `cargo update`. The unqualified form re-resolves every
external dependency, which is the same mistake as deleting a lockfile to
refresh it: the tree you release is then not the tree your tests ran against.
`-w` rewrites only the workspace members' own entries, which is exactly what a
version bump invalidated.

If `cargo` is missing or the command fails, cutver says so and does **not**
abort:

```
  = Cargo.lock  `cargo update -w` failed — run it by hand: <first line of the error>
```

The manifest is already written by that point. Exiting there would leave a
half-bumped tree and no advice; the lockfile is one command away from correct,
so it names the command.

## CRLF is expected

Not tolerated grudgingly — expected. `Cargo.toml` files developed on Windows
are CRLF throughout, and cutver is developed on Windows.

Two things follow, and the second one is the one that actually bit:

- Every pattern matches `\r?$` rather than `$`, so a section header followed by
  a carriage return is still a section header.
- **The version is read from between the quotes**, never from the rest of the
  line. A parser that takes the line and strips quotes hands back `0.1.0\r`,
  which prints identically to `0.1.0` everywhere you look at it and then names
  a directory `thing-0.1.0\r` — a name Windows will not create.

That is structural rather than a `.trim()` after the fact, and there is a test
that asserts the parsed version contains no `\r` against a CRLF fixture.

## Nothing else in the file moves

`Cargo.toml` is a file people write by hand and comment heavily. A round trip
through any TOML library reorders keys, normalises strings and drops comments —
so cutver does not do one.

It locates the version's byte offsets and splices the new string in. Comments,
key order, blank lines, indentation and line endings all survive, and the diff
of a release is one line:

```diff
 [workspace.package]
-version = "0.1.0"
+version = "0.2.0"
 edition = "2021"
```

## Publishing

cutver stops before this, same as everywhere else.

The workflow [`cutver init cargo`](../getting-started/ci.md) writes uses
`cargo publish --workspace`, which publishes every member in dependency order —
crates.io validates that a dependency exists before its dependent, so the order
is not cosmetic. It needs a reasonably current cargo (1.90+).

Authentication is `CARGO_REGISTRY_TOKEN`, because that always works. crates.io
also supports trusted publishing, which removes the secret entirely — worth
switching to, and worth checking the current action version yourself rather
than trusting a file a tool generated months ago.

> **crates.io reserves a crate name on its first publish.** So, exactly as on
> npm, release one is a manual act and everything after it can be automated.
> cutver's preflight refuses to cut a release for a crate the registry has
> never heard of; `--allow-first-publish` is how you say you meant it.

## Members that never publish

A member with `publish = false` is left out of the preflight entirely. Asking
crates.io about a crate that can never reach it would report every internal
test fixture as an unpublished first release.
