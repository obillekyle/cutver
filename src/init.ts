/**
 * `cutver init <cargo|node|bun>` — write the release workflows into a
 * repository that does not have them.
 *
 * **The split is the thing being scaffolded, not the convenience.** Two
 * workflows, always: one that computes a version and pushes a tag, one that
 * publishes and only ever fires on a tag. Handing someone a single
 * "release.yml" that does both would be easier to generate and would throw
 * away the one property that matters — publishing is irreversible, so it gets
 * its own trigger and its own credentials.
 *
 * Both files carry the two gotchas that cost real releases to learn, as
 * comments rather than as folklore:
 *
 *   - A tag pushed with the default `GITHUB_TOKEN` cannot start another
 *     workflow. GitHub blocks it to prevent recursion, so the tagging job has
 *     to dispatch the publishing one explicitly.
 *   - The signal for "a release happened" is whether the version moved, never
 *     whether the tree is dirty.
 *
 * Nothing here is overwritten without `--force`. An `init` that clobbers a
 * workflow someone has been editing for a year is not a helper.
 */

import { addDevDependency } from './adapters/js'
import { downloadBase, HOOK_NAME, installHook } from './hook'

export const ECOSYSTEMS = ['cargo', 'node', 'bun'] as const
export type Ecosystem = (typeof ECOSYSTEMS)[number]

export interface InitFile {
  /** Repo-relative path. */
  path: string
  contents: string
  /** Only written when absent — a changelog with real notes in it is not ours. */
  onlyIfAbsent?: boolean
}

/**
 * How each ecosystem gets hold of cutver in CI.
 *
 * `cargo` downloads the executable rather than installing a JavaScript runtime
 * to run a version bump. That is the whole reason the binary is built: a Rust
 * workspace should not need a package manager from another ecosystem to cut a
 * release.
 */
function runners(version?: string): Record<Ecosystem, { setup: string; cutver: string }> {
  return {
    bun: {
      setup: `      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile`,
      cutver: 'bunx cutver',
    },
    node: {
      setup: `      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm ci`,
      cutver: 'npx --yes cutver',
    },
    cargo: {
      // The executable, not a JavaScript runtime. A Rust workspace should not
      // need another ecosystem's package manager to cut a version.
      //
      // **Pinned to a tag when the version is known.** `releases/latest/download`
      // follows GitHub's idea of latest, which skips prereleases — so against a
      // project that has only ever shipped betas, that URL is a 404.
      setup: `      - name: Fetch cutver
        run: |
          curl -fsSL -o /usr/local/bin/cutver \\
            ${downloadBase(version)}/cutver-linux-x64
          chmod +x /usr/local/bin/cutver
          cutver --version`,
      cutver: 'cutver',
    },
  }
}

/** The gates each ecosystem runs before a version is written. Edit to taste — that is the point of them. */
const GATES: Record<Ecosystem, string> = {
  bun: `      # cutver does not run your gates: it cannot know what they are. They go
      # here, before anything is written, so a release cannot be cut from a
      # tree that does not pass.
      - run: bun test`,
  node: `      # cutver does not run your gates: it cannot know what they are. They go
      # here, before anything is written, so a release cannot be cut from a
      # tree that does not pass.
      - run: npm test`,
  cargo: `      # cutver does not run your gates: it cannot know what they are. They go
      # here, before anything is written, so a release cannot be cut from a
      # tree that does not pass.
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo test --workspace`,
}

const MANIFEST: Record<Ecosystem, string> = {
  bun: 'package.json',
  node: 'package.json',
  cargo: 'Cargo.toml',
}

/** Reading the current version back out, to decide whether a release happened. */
const READ_VERSION: Record<Ecosystem, string> = {
  bun: `bun -e 'console.log(require("./package.json").version)'`,
  node: `node -p "require('./package.json').version"`,
  cargo: `sed -n 's/^version *= *"\\(.*\\)"/\\1/p' Cargo.toml | head -1`,
}

function versionWorkflow(eco: Ecosystem, version?: string): string {
  const RUN = runners(version)
  return `name: Version

# Computes the next version from the commit messages, commits the bump, and
# pushes a tag. **It does not publish** — publish.yml does, and only when a
# \`v*\` tag appears. That split is the whole safety model: a registry never
# allows a version number to be reused, so the irreversible step gets its own
# trigger rather than happening because someone merged a PR.
on:
  push:
    branches:
      - main
      # Branch-declared versions: a branch called \`1.2.0-beta\` publishes betas
      # towards 1.2.0. These globs only decide which pushes are worth waking
      # the workflow for.
      - '*-alpha'
      - '*-beta'
      - '*-rc'

concurrency:
  # Never two releases at once on the same ref: both would compute the same
  # number from the same commits and the second push would be rejected.
  group: version-\${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: write
  # To dispatch publish.yml. **A tag pushed with the default GITHUB_TOKEN
  # cannot start a workflow** — GitHub blocks that to prevent recursion — so
  # the tag alone is not enough and this has to ask explicitly.
  actions: write

jobs:
  version:
    name: compute + tag
    runs-on: ubuntu-latest

    # The bump commit is itself a push to this branch, which would re-trigger
    # this workflow. Skipped by its own subject line.
    if: "!startsWith(github.event.head_commit.message, 'chore(release):')"

    steps:
      - uses: actions/checkout@v4
        with:
          # Full history and every tag. cutver measures commits since the last
          # *stable* tag; a shallow clone has neither.
          fetch-depth: 0

${RUN[eco].setup}

${GATES[eco]}

      - name: Note the version before
        id: before
        run: echo "value=$(${READ_VERSION[eco]})" >> "$GITHUB_OUTPUT"

      # \`--if-needed\` because most pushes are docs or chores and warrant no
      # release. Without it every ordinary merge ends in a red cross, and a
      # workflow that is usually red is a workflow nobody reads.
      #
      # \`--branch\` because CI checks out a detached HEAD, where git answers
      # the literal string 'HEAD' and the real branch is only in the payload.
      - name: Compute the version and bump ${MANIFEST[eco]}
        run: ${RUN[eco].cutver} --if-needed --branch '\${{ github.ref_name }}'

      # **Whether the version moved is the signal — not whether the tree is
      # dirty.** \`git status\` reports an unrelated formatter edit as "a
      # release happened", and the run then fails creating a tag that exists.
      - name: Did the version move?
        id: check
        env:
          BEFORE: \${{ steps.before.outputs.value }}
        run: |
          after=$(${READ_VERSION[eco]})
          if [ "$after" != "$BEFORE" ]; then
            echo "released=true" >> "$GITHUB_OUTPUT"
            echo "value=$after" >> "$GITHUB_OUTPUT"
            echo "$BEFORE -> $after"
          else
            echo "released=false" >> "$GITHUB_OUTPUT"
            echo "still $after — no release warranted by these commits"
          fi

      - name: Commit and tag
        if: steps.check.outputs.released == 'true'
        env:
          VERSION: \${{ steps.check.outputs.value }}
        run: |
          git config user.name  'github-actions[bot]'
          git config user.email 'github-actions[bot]@users.noreply.github.com'
          git add -A
          git commit -m "chore(release): v$VERSION"
          git tag -a "v$VERSION" -m "v$VERSION"
          # Commit first, tag second. If the push of the commit is rejected the
          # tag never goes out, and publish.yml never fires for a version that
          # is not on the branch.
          git push origin HEAD
          git push origin "v$VERSION"

      # The tag is pushed above, but a tag pushed by GITHUB_TOKEN does not
      # trigger \`push: tags\` anywhere. \`workflow_dispatch\` is one of the two
      # documented exemptions, so publish.yml is asked directly.
      - name: Hand off to publish.yml
        if: steps.check.outputs.released == 'true'
        env:
          GH_TOKEN: \${{ github.token }}
          VERSION: \${{ steps.check.outputs.value }}
        run: gh workflow run publish.yml -f tag="v$VERSION"
`
}

/** The publish step, which is the only part that genuinely differs per registry. */
const PUBLISH_STEP: Record<Ecosystem, string> = {
  bun: `      # **Bun packs, npm publishes, and the split is load-bearing.**
      # \`workspace:^\` is a protocol npm does not understand; Bun rewrites it to
      # a real range when it builds a tarball and npm does not. Packing with
      # Bun and handing npm a finished tarball keeps that rewriting *and* gets
      # OIDC, because npm publishes the bytes it is given.
      - name: Publish
        env:
          DIST_TAG: \${{ steps.disttag.outputs.value }}
        run: |
          bun pm pack --destination "$GITHUB_WORKSPACE/dist"
          npm publish "$GITHUB_WORKSPACE"/dist/*.tgz --tag "$DIST_TAG"`,
  node: `      - name: Publish
        env:
          DIST_TAG: \${{ steps.disttag.outputs.value }}
        run: npm publish --tag "$DIST_TAG"`,
  cargo: `      # \`--workspace\` publishes every member in dependency order (cargo 1.90+).
      # crates.io validates that a dependency exists before its dependent, so
      # the order is not cosmetic.
      #
      # Authenticated with a token here because it always works. crates.io also
      # supports trusted publishing, which removes the secret entirely — worth
      # switching to, and worth checking the current action version rather than
      # trusting a generated file for it.
      - name: Publish
        env:
          CARGO_REGISTRY_TOKEN: \${{ secrets.CARGO_REGISTRY_TOKEN }}
        run: cargo publish --workspace`,
}

function publishWorkflow(eco: Ecosystem, version?: string): string {
  const RUN = runners(version)
  const npm = eco !== 'cargo'
  return `name: Publish

# The only thing here that touches the registry, and the only one that cannot
# be undone: a version number can never be reused, by anyone, ever. So it fires
# on a tag rather than on a push — version.yml creates the tag, and a human can
# also create one by hand.
${
  npm
    ? `#
# Authentication is **npm Trusted Publishing (OIDC)**: no long-lived token
# exists anywhere. Two consequences worth knowing before editing this file:
#
#   - Trusted publishing is configured **per package** on npmjs.com, and it
#     names *this file*. Renaming publish.yml breaks the trust relationship.
#   - **It cannot perform a package's first publish** — npm has nowhere to
#     attach the trusted publisher until the package exists. Release one goes
#     out by hand with a token. cutver refuses to cut a release for a package
#     the registry has never heard of, so this is enforced rather than
#     remembered.
#   - Trusted publishing signs a provenance statement naming this repository,
#     and npm rejects a tarball whose manifest does not name it back. Set
#     \`repository\` in package.json before the first automated release.`
    : `#
# Authenticated with CARGO_REGISTRY_TOKEN. crates.io reserves a crate name on
# its first publish, so release one goes out by hand — cutver refuses to cut a
# release for a crate the registry has never heard of.`
}
#
# **A tag pushed by version.yml cannot start this workflow.** GitHub refuses to
# create runs from events made with the default GITHUB_TOKEN, to prevent
# recursion, so \`push: tags\` only ever fires for a tag a human pushes.
# \`workflow_dispatch\` is one of the two documented exemptions.
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      tag:
        description: 'Tag to publish, e.g. v1.2.3'
        required: true
        type: string

concurrency:
  group: publish-\${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read${npm ? `\n  # Without this the runner cannot mint the OIDC token and npm falls back to\n  # looking for a credential that does not exist — failing with an error about\n  # credentials rather than about permissions.\n  id-token: write` : ''}

jobs:
  publish:
    runs-on: ubuntu-latest

    # One name for the tag whichever trigger fired. On a tag push \`ref_name\` is
    # the tag; on a dispatch it is the branch, so the input has to win.
    env:
      TAG: \${{ inputs.tag || github.ref_name }}

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # Explicit, because a dispatched run would otherwise check out the
          # branch and publish whatever is on it rather than what was tagged.
          ref: \${{ inputs.tag || github.ref_name }}

${RUN[eco].setup}
${
  npm
    ? `
      # The runner's bundled npm predates OIDC support often enough that
      # pinning is cheaper than debugging a 401 that claims to be about
      # permissions.
      - name: Use an npm that speaks OIDC
        run: npm install -g npm@latest
`
    : ''
}
      # A tag can be created by hand, and by hand it can be put on the wrong
      # commit. Publishing then ships whatever the manifest says under a tag
      # claiming something else — and both are permanent.
      - name: Refuse if the tag and the manifest disagree
        run: |
          manifest=$(${READ_VERSION[eco]})
          if [ "v$manifest" != "$TAG" ]; then
            echo "tag $TAG does not match the manifest version $manifest" >&2
            exit 1
          fi

      # Run again rather than trusted from the tagged commit's earlier run: a
      # tag can be moved, a branch force-pushed. Last point anything stops.
${GATES[eco]}
${
  npm
    ? `
      # **A prerelease published without a dist-tag becomes \`latest\`**, and then
      # every plain install in the world resolves to a beta — silently, and only
      # fixable by re-tagging after people have installed it. An unrecognised
      # prerelease is refused rather than defaulted.
      - name: Work out the dist-tag
        id: disttag
        run: |
          version="\${TAG#v}"
          case "$version" in
            *-alpha.*) tag=alpha ;;
            *-beta.*)  tag=beta ;;
            *-rc.*)    tag=rc ;;
            *-*)       echo "unrecognised prerelease in $version" >&2; exit 1 ;;
            *)         tag=latest ;;
          esac
          echo "value=$tag" >> "$GITHUB_OUTPUT"
`
    : ''
}
${PUBLISH_STEP[eco]}
`
}

const CHANGELOG = `# Changelog

## [Unreleased]
`

/** Everything \`init\` would write, without touching the disk. */
export function initFiles(eco: Ecosystem, version?: string): InitFile[] {
  return [
    { path: '.github/workflows/version.yml', contents: versionWorkflow(eco, version) },
    { path: '.github/workflows/publish.yml', contents: publishWorkflow(eco, version) },
    // Only if absent, and never with content: a changelog is prose someone
    // writes. cutver opens the heading and fills in nothing.
    { path: 'CHANGELOG.md', contents: CHANGELOG, onlyIfAbsent: true },
  ]
}

export interface InitResult {
  path: string
  state: 'written' | 'skipped'
  detail: string
}

/**
 * The range to pin cutver at.
 *
 * Exact for a prerelease, caret for a stable release. `^0.1.0-beta.6` is not
 * the range anyone means — a caret on a 0.x prerelease matches only later
 * prereleases of that same 0.1.0, which reads as a range and behaves as a pin.
 * Being explicit about it beats being subtly narrow.
 */
export function pinFor(version: string): string {
  return version.includes('-') ? version : `^${version}`
}

export interface InitOptions {
  force?: boolean
  dryRun?: boolean
  /** Install the pre-push guard too. On by default: it is part of "set this up". */
  hook?: boolean
  /**
   * The running cutver's version, pinned into the manifest so the tool that
   * computes your version numbers does not float. `dev` (running from source)
   * pins nothing — there is no published version to name.
   */
  version?: string
}

export async function init(
  root: string,
  eco: Ecosystem,
  { force = false, dryRun = false, hook = true, version }: InitOptions = {},
): Promise<InitResult[]> {
  const out: InitResult[] = []

  for (const file of initFiles(eco, version)) {
    const full = `${root}/${file.path}`
    const exists = await Bun.file(full).exists()

    if (exists && (file.onlyIfAbsent || !force)) {
      out.push({
        path: file.path,
        state: 'skipped',
        detail: file.onlyIfAbsent ? 'already exists' : 'already exists — --force to replace',
      })
      continue
    }

    if (!dryRun) await Bun.write(full, file.contents)
    out.push({
      path: file.path,
      state: 'written',
      detail: exists ? 'replaced' : 'created',
    })
  }

  // **The workflows and the hook both need a cutver to run, so pin one.**
  // Without this both reach for `bunx cutver`, which resolves `latest` from
  // the registry on every run — so the tool that decides your version numbers
  // floats, and a cutver release could change them without a commit in your
  // repository. A devDependency also makes `bunx`/`npx` prefer the local copy,
  // so nothing has to be re-fetched per run.
  //
  // Cargo repositories get no say here: there is no JavaScript manifest to pin
  // into, which is why the executable exists and why `init cargo` downloads it.
  if (eco !== 'cargo') {
    if (!version || version === 'dev') {
      out.push({
        path: 'package.json',
        state: 'skipped',
        detail: 'cutver is running from source — nothing to pin',
      })
    } else {
      const range = pinFor(version)
      const result = await addDevDependency(root, 'cutver', range, dryRun)
      out.push({
        path: 'package.json',
        state: result === 'added' ? 'written' : 'skipped',
        detail:
          result === 'added'
            ? `devDependency cutver@${range}`
            : 'already declares cutver — left alone',
      })
    }
  }

  if (hook) {
    // `init` deliberately works in a tree that is not a repository yet —
    // scaffolding before `git init` is a reasonable order to do things in —
    // so a missing hooks directory is reported rather than thrown. The
    // workflows are the valuable half and they have already been written by
    // this point; failing here would abort a command that mostly succeeded.
    const installed = await installHook(root, { force, dryRun, version }).catch((e: Error) => ({
      state: 'skipped' as const,
      detail: `not installed — ${e.message}`,
    }))

    out.push({
      path: `${HOOK_NAME} (git hook)`,
      state: installed.state,
      detail: installed.detail,
    })
  }

  return out
}
