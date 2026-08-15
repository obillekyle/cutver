# Changelog

Notes are written by hand. `cutver` opens the heading and never fills it in —
see the README on why generating release notes from commit subjects is a
downgrade from prose that explains itself.

## [Unreleased]

## [0.1.0-beta.12] — 2026-08-15

### Added

- `docs/cutver.schema.json`, served at the URL the config reference has been
  telling people to put in `$schema` since beta.10. That URL had been a 404, so
  the one advantage the reference offers for choosing JSON over YAML — editor
  completion — did not exist. Nothing imports the file, so `schema.test.ts`
  compares it against the loader directly: the same ecosystems, the same schema
  ceiling, and the same verdict on sixteen channel names. A schema that
  red-underlines a config which runs is worse than no completion; one that
  blesses a config cutver refuses is worse still.

### Changed

- **`--channel <name>` replaces `--alpha`, `--beta`, `--rc` and
  `--prerelease`.** The flags were enumerable when there were three channels and
  stopped being so the moment a config could name a fourth: `--canary` existed
  only in a repository that declared `canary`, which made the flag set a
  property of the working directory. `--help` could not print it and the
  reference page could not list it, so the two-way parity test between them had
  to be kept clear of channels entirely. One flag taking a value has none of
  that, and an undeclared name now produces an error naming the channels that
  do exist rather than `unknown option`.

  `prerelease` remains a spelling of `rc` and names are still normalised, so
  `--channel RC` and `--channel prerelease` both cut an `-rc.N`.

## [0.1.0-beta.11] — 2026-08-14

### Changed

- **Channel names are kebab-case, and camelCase, PascalCase, snake_case and
  spaces are converted rather than refused.** `myPrefix`, `MyPrefix`,
  `my_prefix` and `my prefix` all name the same channel to anyone reading the
  file, so they resolve to the same one instead of three of them being errors.
  Normalising once, at load, is what keeps the version string, the git tag, the
  dist-tag and the generated workflow arm from ever disagreeing about spelling.
  Two keys that normalise to the same channel are refused naming both — merging
  them silently is how a branch ends up in a channel nobody declared.

  A hyphen *inside* the identifier is safe, which is worth stating because the
  digit rule looks like it forbids one. Measured on Bun 1.3.14:

      1.2.0-my-prefix.9  <  1.2.0-my-prefix.10     correct
      1.2.0-rc-9         >  1.2.0-rc-10            INVERTED

  The difference is where the hyphen is. `my-prefix` is one identifier and the
  counter keeps its own dot; `rc-9` fuses the counter into the text, and then
  ten sorts below nine. So the constraint is not "no hyphens" but "the counter
  keeps its dot", which is a property of the format rather than of the name.
  Digits stay out: legal semver, but an all-digit identifier has leading-zero
  rules that would need their own tests and a channel name is not the place to
  spend that.

## [0.1.0-beta.10] — 2026-08-14

### Added

- **`cutver.json` / `cutver.yml`** — one place to say which branches cut a
  stable release and which cut a prerelease in which channel. The key *is* the
  channel: it is the prerelease identifier in the version and the dist-tag the
  release publishes under, so there is no separate `tag` field to drift out of
  step with it. Add a key and the channel exists — `canary`, `nightly`, `next`.
  Arbitrary dist-tags were never the blocker; react ships four of them today.

  Three shapes match: literal (`develop`), glob (`nightly/*`) and declaring
  (`{version}-beta`), with declaring winning inside a channel — otherwise
  `*-beta` swallows `1.3.0-beta` and silently disables the refusal that branch
  shape exists for. A branch matching two channels is refused naming both.

- **`cutver explain`** — which rule claims this branch and every rule that was
  tried and did not, read-only and offline, always exit 0. It is what makes an
  unmatched branch diagnosable in one command instead of a bisect.

- The generated workflows now derive their branch triggers *and* their dist-tag
  `case` arms from the config. The arms are the mandatory half: hard-coded ones
  plus a `*-*)` hard-fail kill a `canary` publish **after** the tag and the
  `chore(release):` commit are already public.

### Changed

- Branch rules are data. `DEFAULT_CONFIG` is the previous hard-coded behaviour
  written out, so a repository with no config file and one with a config file
  take the same code path — and `equivalence.test.ts` drives the old
  `channelFromBranch`/`canonicalBranch` and the new table over thirty branch
  names and demands the same answer from both. The two old functions moved
  *into* that test rather than being deleted: production code should not carry a
  second implementation of something it no longer uses, but deleting them
  outright would delete the only independent statement of what the behaviour
  was.

- `release: ['**']` is the default, not `[main, master]`. There is no branch
  gating today, and anything else would silently stop releases on `develop` for
  everyone already using cutver. `init` scaffolds the strict list, so gating is
  opted into by new repositories rather than arriving with an upgrade.

- **A branch matching no rule is a `Plan` variant, never a refusal.** `check`
  exits 1 on a refusal and runs from the pre-push hook on every branch of every
  push, so as a refusal this would have blocked every feature-branch push in the
  repository, forever.

### Fixed

- `lastAnyTag` orders by `--sort=-creatordate` with semver as the tiebreak.
  Sorting by semver precedence alone is alphabetical among prerelease
  identifiers, which is correct only because `alpha < beta < rc` happens to be
  both. Add a `canary` and releasing `1.3.0-rc.0` then `1.3.0-canary.6` makes
  the rc look newest, widening the freshness range and bringing back the wasted
  release beta.5 fixed.

## [0.1.0-beta.9] — 2026-08-14

### Added

- **`prerelease` is an accepted spelling of `rc`** — as a bare branch name,
  inside the versioned shape (`1.3.0-prerelease`), and on the command line. It
  reads as a category rather than a channel and plenty of projects name the
  branch that.

  **The version written is always the canonical `-rc.N`.** The dist-tag is
  derived from the version, and a fourth spelling in there would be a channel no
  registry has heard of — `publish.yml` refuses an unrecognised prerelease
  rather than defaulting it to `latest`, so the alias has to resolve before the
  number is written rather than after. Resolved by rewriting the branch name
  once, before either lookup, which keeps the ported file untouched again.

  Anchored to a trailing whole segment: `prereleases` is not a match, and
  `my-prerelease` becomes `my-rc`, which is neither an exact channel nor a
  version and so stays an ordinary branch either way. Messages quote the branch
  as it actually is, never the rewrite.

## [0.1.0-beta.8] — 2026-08-14

### Added

- **A branch named plainly `beta` declares the channel and lets the base move.**
  `1.3.0-beta` promises a specific number, so the moment a `feat!` lands the
  commits have outgrown the name and cutver refuses the push — correctly, but
  the fix is renaming a branch mid-flight, and that chore recurs every time the
  base moves. A bare `beta` promises only the channel: the base is computed from
  the commits every time, a break moves it from 1.3.0 to 2.0.0 on its own, and
  the counter restarts because the base changed. `alpha`, `rc` and
  `release/beta` work the same way.

  Only exact names count. `beta-two`, `my-beta`, `betas` and `feat/beta-ui` stay
  ordinary branches; a tool that guessed otherwise would start publishing
  prereleases off a feature branch. An explicit channel flag still wins over the
  branch, and the output says where the channel came from — a `-beta.0`
  appearing because of a branch name is otherwise the sort of thing you notice
  after publishing it.

  This is a new function in the policy layer rather than a widened
  `versionFromBranch`: that one answers "what version does this name declare",
  and for `beta` the honest answer is still *none*. A test asserts the two
  disagree on `beta` on purpose, rather than leaving it to look like an
  oversight.

- The generated workflow triggers gained the bare channel names. **`*-beta` does
  not match `beta`** — the glob needs the hyphen — and left out, the branch
  silently never releases anything with no error to notice. Now asserted in the
  tests for both shapes.

## [0.1.0-beta.7] — 2026-08-14

### Fixed

- **Every `cutver-windows-x64.exe` published since beta.0 crashed on startup**
  with `panic: Segmentation fault at address 0xDA0`. Not a cutver bug —
  isolated to a one-line program built on Linux for `bun-windows-x64` on Bun
  1.3.14:

      with    --bytecode -> segfault
      without --bytecode -> prints

  Cross-compiling the other way is fine with bytecode, so it is the Windows
  target specifically, and CI builds all five targets on Linux. `--bytecode` is
  dropped for every target rather than just Windows: an artefact that differs
  from the one built locally is a thing nobody tests. It bought about half the
  startup time of a tool that runs once per release, against shipping a binary
  that does not start. The assets on the five existing releases were rebuilt and
  re-uploaded.

- **`releases/latest/download` follows GitHub's idea of latest, which skips
  prereleases.** Measured against this project's own releases: the pinned tag
  returns 200, the `latest` form returns 404. The generated cargo workflow had
  been emitting that 404 URL; `hook install` and `init cargo` now both pin the
  tag they download from.

### Added

- The pre-push hook falls back to the release binary, so a repository with no
  JavaScript runtime can still run the guard. `cutver` on PATH, then `bunx`,
  then `npx`, then a download for `uname -s`/`uname -m` — curl or wget and
  nothing else. The binary lands in `.git/cutver/`, which is never committed and
  needs no gitignore entry, and is fetched once rather than per push; at ~95 MB
  that arrival is announced rather than silent. A failed download removes the
  partial file, because the cache check is `-x` and a truncated-but-executable
  binary would fail every push after it.

## [0.1.0-beta.6] — 2026-08-14

### Added

- **`cutver check` and `cutver hook install|uninstall`** — the branch-declaration
  refusal, moved to before the push. The check itself is not new; what moves is
  when you find out. In CI the refusal arrives after the commit is public and
  everyone has pulled it, and renaming a branch is cheap before a push and
  awkward after one.

  Read-only, offline, and with exit codes aimed at a hook rather than a person:
  exit 0 for "nothing to release", because that is a normal state and must not
  block a push, and exit 1 only for the refusal, which is now a typed
  `PlanRefusal` so a caller can tell it from a crash.

  **It fails open on everything else.** cutver missing, git broken, an
  unparseable manifest, a repository cutver was never set up for — the push goes
  through and the hook says why. A guard that fails closed on its own bug blocks
  every push in the repository, and CI still catches the real thing.
  `git push --no-verify` covers the refusal itself, so nothing here had to
  invent an escape hatch.

  Three details that are easy to get wrong: `--rev`, because a pre-push hook is
  handed a sha per ref and the branch being pushed is not always the one checked
  out; `core.hooksPath` first, because a repository that moved its hooks did it
  on purpose and writing into `.git/hooks` there installs a hook git never runs;
  and `chmod +x`, because `Bun.write` sets no mode and git skips a
  non-executable hook silently. The generated script is checked with `sh -n` in
  the tests — generated shell is only ever read by a person when it misfires.

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
