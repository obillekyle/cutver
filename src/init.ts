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
import { shapeOf } from './config/match'
import {
  DEFAULT_CONFIG,
  ECOSYSTEMS,
  RELEASE,
  publishTo,
  type Config,
  type Ecosystem,
  type PublishTarget,
} from './config/schema'
import { ADAPTER_FOR } from './adapters'
import { parseConfig } from './config/load'
import { configTemplate } from './config/template'

// Declared once, in `config/schema.ts`, because `target:` in the config names
// the same set. Two copies type-checked only because the unions happened to be
// identical — the day one gained an entry the other did not, the error would
// have surfaced somewhere unrelated to either.
export { ECOSYSTEMS, type Ecosystem }

export interface InitFile {
  /** Repo-relative path. */
  path: string
  contents: string
  /** Only written when absent — a changelog with real notes in it is not ours. */
  onlyIfAbsent?: boolean
}

/**
 * The workflow's `on.push.branches` list, derived from the config.
 *
 * Nine hard-coded literals used to live here, which meant adding a channel took
 * a code change *and* a workflow regeneration. Now the config is the one place.
 *
 * **cutver globs reach GitHub verbatim**, because the two agree: `*` does not
 * cross a `/` in either, and `**` does in both. A translation layer here would
 * be a second place to be wrong about the same thing.
 *
 * A catch-all is dropped **only when there is no config file**, and the
 * distinction is provenance rather than the text. `release: ['**']` is the
 * built-in default meaning "no branch gating configured"; turning that into a
 * trigger would wake CI on every branch in the repository, so `main` stands in.
 * But a repository that *wrote* `['**']` down meant it, and overruling a written
 * rule with a branch that may not even exist is the opposite of what this
 * function is for. Testing the literal text conflated the two, and it silently
 * dropped a `canary: ['**']` as well.
 */
export function branchTriggers(config: Config): string[] {
  const globs = new Set<string>()
  const literals = new Set<string>()
  const stable: string[] = []
  const configured = config.source !== null

  for (const [channel, entries] of Object.entries(config.channels)) {
    for (const entry of entries) {
      // A branch that declares its own version triggers on the shape, since
      // the version part is different every time.
      const value = shapeOf(entry) === 'declaring' ? entry.replace('{version}', '*') : entry
      if (!configured && (value === '**' || value === '*')) continue

      if (channel === RELEASE) stable.push(value)
      else if (/[*?]/.test(value)) globs.add(value)
      else literals.add(value)
    }
  }

  const release = stable.length ? stable : ['main']
  return [...release, ...[...globs].sort(), ...[...literals].sort()]
}

/** YAML needs a quote around anything starting with `*`, which is an alias there. */
function yamlBranch(name: string): string {
  return /^[*?]/.test(name) ? `'${name}'` : name
}

/**
 * The publish workflow's dist-tag `case`, derived from the same config.
 *
 * Hard-coded arms are what make a configured channel fail *after* its tag and
 * bump commit are already public — the run gets all the way to the last step
 * and hits the catch-all. The catch-all itself stays: refusing an unrecognised
 * prerelease is better than defaulting it to `latest`.
 */
export function distTagArms(config: Config): string[] {
  return Object.keys(config.channels)
    .filter(c => c !== RELEASE)
    .map(c => `            *-${c}.*)${' '.repeat(Math.max(1, 10 - c.length))}tag=${c} ;;`)
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

/**
 * The note above the gates, written once.
 *
 * It is the highest-traffic comment in the generated file — the one telling the
 * reader this is the block they are meant to edit — and it was previously
 * spelled out in all three arms, so changing the sentence meant changing it
 * three times or letting the ecosystems disagree.
 */
const GATE_NOTE = `      # cutver does not run your gates: it cannot know what they are. They go
      # here, before anything is written, so a release cannot be cut from a
      # tree that does not pass.
`

/** The gates each ecosystem runs before a version is written. Edit to taste — that is the point of them. */
const GATES: Record<Ecosystem, string> = {
  bun: `${GATE_NOTE}      - run: bun test`,
  node: `${GATE_NOTE}      - run: npm test`,
  cargo: `${GATE_NOTE}      - uses: dtolnay/rust-toolchain@stable
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

function versionWorkflow(eco: Ecosystem, config: Config, version?: string): string {
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
      # Derived from cutver.json / cutver.yml — every branch any channel
      # claims, plus the stable ones. Re-run \`cutver init --force\` after adding
      # a channel, or the new branch quietly never triggers anything.
${branchTriggers(config)
  .map(b => `      - ${yamlBranch(b)}`)
  .join('\n')}

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

${
    publishTo(ADAPTER_FOR[eco], config).length
      ? `
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
      : `
      # No handoff: \`publish\` in cutver.yml names nothing a tag produces, so
      # there is no publish.yml to dispatch. The tag above is the release.
`
  }`
}

/**
 * Building executables and attaching them to the GitHub release.
 *
 * **Native builds on three runners, not cross-compilation.** Adding a target is
 * a decision with a toolchain attached, and a generated file that quietly
 * cross-compiles is a generated file that quietly ships a broken binary — which
 * is not hypothetical here. cutver published a segfaulting
 * `cutver-windows-x64.exe` for five releases because CI cross-compiled every
 * target on Linux and `--bytecode` produces a broken executable for the Windows
 * target. Three native runners cannot fail that way.
 *
 * **The binaries are discovered, never named.** `cargo metadata` lists the bin
 * targets the workspace actually declares, so adding a binary needs no edit
 * here and a renamed one cannot leave the workflow uploading nothing.
 */
const ARTIFACT_JOB: Record<Ecosystem, string> = {
  cargo: `  artifacts:
    name: \${{ matrix.target }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: ubuntu-latest,  target: x86_64-unknown-linux-gnu }
          - { os: macos-latest,   target: aarch64-apple-darwin }
          - { os: windows-latest, target: x86_64-pc-windows-msvc }
    runs-on: \${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.tag || github.ref_name }}
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2

      - run: cargo build --workspace --release

      # Every \`[[bin]]\` the workspace declares, asked of cargo rather than
      # written down. \`--no-deps\` keeps it to this workspace's own crates.
      - name: Collect the binaries
        shell: bash
        run: |
          mkdir -p dist
          ext=""
          [ "\${{ runner.os }}" = "Windows" ] && ext=".exe"
          cargo metadata --format-version 1 --no-deps \\
            | jq -r '.packages[].targets[] | select(.kind[] == "bin") | .name' \\
            | while read -r bin; do
                cp "target/release/\$bin\$ext" "dist/\$bin-\${{ matrix.target }}\$ext"
              done
          ls -l dist

      - uses: actions/upload-artifact@v4
        with:
          name: \${{ matrix.target }}
          path: dist/*`,
  bun: `  artifacts:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.tag || github.ref_name }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile

      # **Yours to write, like the gates.** cutver knows a Rust workspace's
      # binaries from cargo; it cannot know what a JavaScript project considers
      # a build artifact. Put whatever belongs on the release into dist/ —
      # \`bun build --compile\` executables, a tarball, a zip.
      - run: bun run build

      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/*`,
  node: `  artifacts:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.tag || github.ref_name }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci

      # **Yours to write, like the gates.** Put whatever belongs on the release
      # into dist/.
      - run: npm run build

      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/*`,
}

/**
 * Attaching what the matrix built, and marking a prerelease as one.
 *
 * **\`--prerelease\` is not cosmetic.** \`releases/latest/download/…\` follows
 * GitHub's idea of latest, which skips prereleases — so a beta wrongly marked
 * as a full release becomes the target of every unpinned download URL, and a
 * project that has only published prereleases gets a 404 from that URL rather
 * than an empty result. Both were measured against this project.
 */
const RELEASE_JOB = `  release:
    needs: artifacts
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/download-artifact@v4
        with:
          path: staged
          merge-multiple: true

      - name: Attach them to the release
        env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
        run: |
          case "$TAG" in
            *-*) pre=--prerelease ;;
            *)   pre= ;;
          esac
          gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes "" $pre \\
            || echo "release $TAG already exists — uploading into it"
          gh release upload "$TAG" --repo "$REPO" --clobber staged/*`

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

function publishWorkflow(
  eco: Ecosystem,
  config: Config,
  version?: string,
  targets: PublishTarget[] = publishTo(ADAPTER_FOR[eco], config),
): string {
  const RUN = runners(version)
  const registry = targets.includes('registry')
  const artifacts = targets.includes('artifacts')
  const npm = eco !== 'cargo' && registry
  return `name: Publish

# What a tag produces${
    registry && artifacts
      ? ': a registry publish and the executables on the release'
      : registry
        ? ', and the one thing here that cannot be undone'
        : ': the executables, attached to the GitHub release'
  }.
#
# It fires on a tag rather than on a push — version.yml creates the tag, and a
# human can also create one by hand.${
    registry
      ? `
#
# **A version number can never be reused, by anyone, ever.** That is why the
# irreversible half lives behind its own trigger rather than happening because
# someone merged a pull request.`
      : `
#
# **Nothing here touches a registry.** \`publish\` in cutver.yml does not name
# one, so a tag builds binaries and stops. Add \`registry\` to that list to
# publish as well — and read what it costs first: crates.io reserves a crate
# name on its first publish, permanently, for every member of the workspace.`
  }${
    npm
      ? `
#
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
      : registry
        ? `
#
# Authenticated with CARGO_REGISTRY_TOKEN. crates.io reserves a crate name on
# its first publish, so release one goes out by hand — cutver refuses to cut a
# release for a crate the registry has never heard of.`
        : ''
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

# One name for the tag whichever trigger fired, at workflow level so every job
# below reads the same one. On a tag push \`ref_name\` is the tag; on a dispatch
# it is the branch, so the input has to win.
env:
  TAG: \${{ inputs.tag || github.ref_name }}

jobs:
${
  registry
    ? `  publish:
    runs-on: ubuntu-latest

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
${distTagArms(config).join('\n')}
            *-*)       echo "unrecognised prerelease in $version" >&2; exit 1 ;;
            *)         tag=latest ;;
          esac
          echo "value=$tag" >> "$GITHUB_OUTPUT"
`
    : ''
}
${PUBLISH_STEP[eco]}`
    : ''
}${artifacts ? `${registry ? '\n\n' : ''}${ARTIFACT_JOB[eco]}\n\n${RELEASE_JOB}` : ''}
`
}

const CHANGELOG = `# Changelog

## [Unreleased]
`

/** Everything \`init\` would write, without touching the disk. */
export function initFiles(
  eco: Ecosystem,
  version?: string,
  config: Config = DEFAULT_CONFIG,
): InitFile[] {
  // A tag that produces nothing needs no workflow to produce it. Writing an
  // empty publish.yml would leave a file whose whole job is to be misread as
  // broken; `version.yml`'s handoff step is skipped to match.
  const targets = publishTo(ADAPTER_FOR[eco], config)

  return [
    { path: '.github/workflows/version.yml', contents: versionWorkflow(eco, config, version) },
    ...(targets.length
      ? [
          {
            path: '.github/workflows/publish.yml',
            contents: publishWorkflow(eco, config, version, targets),
          },
        ]
      : []),
    // Only if absent, and never with content: a changelog is prose someone
    // writes. cutver opens the heading and fills in nothing.
    { path: 'CHANGELOG.md', contents: CHANGELOG, onlyIfAbsent: true },
    // Also only if absent. A config already in the tree is the repository's
    // release policy; replacing it would change version numbers with no commit
    // to blame, which is the one thing this whole tool is arranged against.
    { path: 'cutver.yml', contents: configTemplate(eco), onlyIfAbsent: true },
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
  /**
   * The repository's rules, so the generated triggers and dist-tag arms match
   * the config that is actually there rather than the defaults.
   */
  config?: Config
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
  { force = false, dryRun = false, hook = true, version, config = DEFAULT_CONFIG }: InitOptions = {},
): Promise<InitResult[]> {
  const out: InitResult[] = []

  // **The workflows must match the config this run is about to write**, not
  // the built-in defaults. Without this, `init` on a fresh repository writes a
  // `cutver.yml` saying one thing and an `on.push.branches` list derived from
  // another — and the disagreement is invisible until a branch silently fails
  // to trigger. When a config already exists it wins, because it is the
  // repository's actual policy.
  const effective = config.source ? config : parseConfig(Bun.YAML.parse(configTemplate(eco)), 'cutver.yml')

  for (const file of initFiles(eco, version, effective)) {
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
