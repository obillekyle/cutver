# Changelog

Notes are written by hand. `cutver` opens the heading and never fills it in —
see the README on why generating release notes from commit subjects is a
downgrade from prose that explains itself.

## [Unreleased]

## [0.1.0-beta.3] — 2026-08-14

## [0.1.0-beta.2] — 2026-08-14

## [0.1.0-beta.1] — 2026-08-14

## [0.1.0-beta.0] — 2026-08-14

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
