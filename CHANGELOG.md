# Changelog

Notes are written by hand. `cutver` opens the heading and never fills it in —
see the README on why generating release notes from commit subjects is a
downgrade from prose that explains itself.

## [Unreleased]

## [0.1.0-beta.8] — 2026-08-14

## [0.1.0-beta.7] — 2026-08-14

## [0.1.0-beta.6] — 2026-08-14

## [0.1.0-beta.5] — 2026-08-14

### Fixed

- **A docs commit no longer spends a beta number.** "Is there anything to
  release?" and "what is the base?" are two questions, and answering both from
  one range breaks one of them whichever range you pick. Both from the last
  *stable* tag — what it did until now — means a long-lived `1.2.0-beta` branch
  cuts a new beta on every push forever, because that range still holds every
  `feat:` the branch was opened for and a docs-only commit is indistinguishable
  from new work. beta.4 below is exactly that: a release published for a commit
  that changed nothing but markdown.

  Both from the last *tag* would bring back the bug the whole design exists to
  avoid — a `feat!` landing during a beta measured against `1.3.0-beta.2` and
  shipped as `1.3.0`. So: whether, from the last release of any kind; base,
  from the last stable tag, always.

- `lastAnyTag` sorts in JavaScript rather than with `git tag
  --sort=-v:refname`. Git's version sort places a prerelease *after* its own
  release unless `versionsort.suffix` is configured, and nobody configures it —
  `v1.1.0-beta.0` would have read as newer than `v1.1.0`.

### Changed

- The commit count is now measured from the last release of any kind, so
  `since` names a prerelease tag on a release branch. When the base came from
  an earlier stable tag, a `base` line says so — otherwise the output shows one
  `fix:` and then announces a major with nothing on screen explaining it.

## [0.1.0-beta.4] — 2026-08-14

### Added

- Documentation, at [cutver.okyle.dev](https://cutver.okyle.dev). Ten pages and
  one `index.html` that renders them — no build step, no generator, no CDN, so
  the markdown stays the single source of truth and stays inside the reach of a
  test. `docs.test.ts` checks that every internal link resolves, every
  `#anchor` names a heading that exists, every YAML block parses, and the CLI
  reference lists exactly the flags `--help` lists, in both directions.

Nothing else. This release contains one markdown commit and should not have
been a release at all — see beta.5.

## [0.1.0-beta.3] — 2026-08-14

### Added

- **`cutver init <cargo|node|bun>`** writes `version.yml`, `publish.yml` and a
  `CHANGELOG.md` stub. Two workflows, never one that does both: the split is
  the thing being scaffolded, because publishing is irreversible and deserves
  its own trigger and its own credentials. Both files carry the hard-won parts
  as comments, since that is the form in which they survive. `cargo` downloads
  the executable rather than installing a JavaScript runtime to run a version
  bump, which is why that binary is built.
- **A `repository` check in the preflight.** Trusted publishing signs a
  provenance statement naming the repository that built the tarball, and npm
  rejects one whose manifest disagrees. Compared against the git remote before
  anything is written.

  Reported, never written. Filling the field in from `git remote get-url
  origin` writes the *fork's* URL on a fork, where it passes locally and fails
  identically upstream — and it cannot fix the other half, a `repository` that
  is present and stale.

## [0.1.0-beta.2] — 2026-08-14

### Fixed

- **`repository` in this package's own manifest**, without which its first
  automated publish could not complete. The publish got all the way through —
  OIDC token minted, tarball built, provenance signed and written to the
  sigstore transparency log — and was then refused:

  ```
  422 Error verifying sigstore provenance bundle: Failed to validate repository
  information: package.json: "repository.url" is "", expected to match
  "https://github.com/obillekyle/cutver" from provenance
  ```

  npm normalises a missing field to `""`, which is why the error reads like a
  mismatch rather than a missing key. Worth knowing alongside the first-publish
  rule: trusted publishing brings provenance with it, and provenance adds a
  manifest requirement a token-authenticated publish never had. The
  hand-published beta.0 sailed past it; the first automated one could not.

- `publish.yml` is safe to re-run. Release one is published by hand, so its tag
  is pushed *after* the version is already on the registry — and a
  human-pushed tag does fire the workflow. The publish is skipped when that
  exact version is already there, and the GitHub release is uploaded to rather
  than created, so a partial run finishes by being run again.

## [0.1.0-beta.1] — 2026-08-14

**Never published.** Its tag was created and deleted: the tree at that commit
had no `repository` field, so it was permanently unpublishable for the reason
in beta.2. A tag is a promise that a version exists on a registry, and that one
could never have been kept.

### Fixed

- **The branch-declared guard needs a stable tag to mean anything.** cutver
  refused its own first CI build:

  ```
  branch '0.1.0-beta' declares 0.1.0, but the commits since the first commit
  imply 0.2.0 (minor). Rename the branch to 0.2.0-beta.
  ```

  Following that advice would have skipped 0.1.0 entirely. The refusal was
  comparing against a fiction: with no tag the baseline is inferred from the
  manifest, and on a release branch the manifest is a *prerelease of the base
  the branch declares*, so the very commits that justify 0.1.0 were counted a
  second time on top of it. Every push to a release branch would have failed
  that way until a stable tag existed — which, on a branch whose job is to
  reach the first stable release, is never.

  The check now requires a stable tag. It protects people who have already
  installed a stable release; where none has been published there is nobody to
  protect, and the branch name is the only real evidence available.

## [0.1.0-beta.0] — 2026-08-14

Published by hand with a token, because a trusted publisher cannot create a
package that does not exist yet. `--tag beta` was passed and npm pinned
`latest` to it anyway — a package's first publish always sets `latest`, since
every package must have one.

### Added

- The version arithmetic, extracted verbatim from
  the `bakery` monorepo's `version-from-commits.ts`
  along with its 27 tests. Conventional-commit classification, both breaking
  markers, `release:` as a major, prerelease channels with a counter that
  restarts when the base or the channel moves, and branch-declared versions.
- A manifest-adapter interface — read a version, write a version, name every
  file touched, name every package a release is a promise about.
- The `js` adapter: root `package.json`, every non-private workspace package,
  and `bun.lock`'s workspace entries. That last one is what makes published
  dependency ranges correct.
- The `cargo` adapter: `[workspace.package] version`, then `cargo update -w`.
  Parsed by offset and rewritten by splice, so comments, key order and CRLF
  survive.
- A registry preflight that refuses to cut a release for a package that has
  never been published, because a first publish cannot go through a trusted
  publisher — and OIDC detection, which catches a workflow missing
  `permissions: id-token: write`.
- `CHANGELOG.md` rolling, when there is one with an `## [Unreleased]` heading.
- A standalone executable (`bun run build`), so a repository with no package
  manager does not need one to cut a version.

### Changed from the original

- **With no tags at all, the baseline is the manifest rather than `0.0.0`.**
  bakery has been tagged since its first release so its `0.0.0` fallback never
  ran; against a repository with zero tags it computes a version *below* the
  one already declared.
- Gates are the caller's. The original ran `bun run typecheck` and `bun run
  test`; a general tool cannot know what a repository's gates are, so they
  belong in the job that runs cutver.
