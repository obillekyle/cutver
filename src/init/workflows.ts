/**
 * The two workflow files themselves, as templates.
 *
 * **Every comment in the generated YAML is load-bearing and deliberate.** These
 * files are handed to someone who did not write them and will edit them for
 * years, so the reasons travel with the lines they explain — a tag pushed with
 * the default `GITHUB_TOKEN` starting no workflow, the version-moved signal,
 * the blank gate blocks that are the reader's to fill in. Folklore that lives
 * only in a docs page is folklore that gets deleted by the first person tidying
 * up.
 *
 * Kept apart from `index.ts` because they are text, not logic: nearly six
 * hundred lines of YAML in template literals, next to eighty lines that decide
 * which of them to write and where.
 */
import { ADAPTER_FOR } from '../adapters'
import {
  AUTO,
  AUTO_DIRS,
  producesArtifacts,
  publishesToRegistry,
  type Config,
  type Ecosystem,
} from '../config/schema'
import { downloadBase } from '../hook'
import { branchTriggers, distTagArms } from './triggers'

/** YAML needs a quote around anything starting with `*`, which is an alias there. */
function yamlBranch(name: string): string {
  return /^[*?]/.test(name) ? `'${name}'` : name
}

/**
 * How each ecosystem gets hold of cutver in CI.
 *
 * `cargo` downloads the executable rather than installing a JavaScript runtime
 * to run a version bump. That is the whole reason the binary is built: a Rust
 * workspace should not need a package manager from another ecosystem to cut a
 * release.
 */
function runners(
  version?: string,
): Record<Ecosystem, { setup: string; cutver: string }> {
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
      // **Pinned to a tag when the version is known.**
      // `releases/latest/download` follows GitHub's idea of latest, which skips
      // prereleases — so against a project that has only ever shipped betas,
      // that URL is a 404.
      //
      // **`--retry`, because this is the one step with no second chance.**
      // Every other download in a release job is a package manager that retries
      // on its own. This is a bare curl, and it failed a real release on
      // `curl: (35) Recv failure: Connection reset by peer` — the asset
      // answered 200 thirty seconds later. A blip reaching GitHub is not a
      // reason to leave a repository unreleased.
      setup: `      - name: Fetch cutver
        run: |
          curl -fsSL --retry 3 --retry-connrefused --retry-delay 2 \\
            -o /usr/local/bin/cutver \\
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

export function versionWorkflow(
  eco: Ecosystem,
  config: Config,
  version?: string,
): string {
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
        run: ${RUN[eco].cutver} stage --if-needed --branch '\${{ github.ref_name }}'

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
  publishesToRegistry(ADAPTER_FOR[eco], config) ||
  producesArtifacts(ADAPTER_FOR[eco], config)
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
 * The runners the generated cargo matrix starts with.
 *
 * Data rather than three lines inside a template literal, because `init` probes
 * each of these against the real dependency graph before it writes anything —
 * see `platforms.ts`. A row nobody can build is worth saying out loud while the
 * file is being created, not after a tag is public.
 */
export const CARGO_RUNNERS: readonly { os: string; target: string }[] = [
  { os: 'ubuntu-latest', target: 'x86_64-unknown-linux-gnu' },
  { os: 'macos-latest', target: 'aarch64-apple-darwin' },
  { os: 'windows-latest', target: 'x86_64-pc-windows-msvc' },
]

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
 *
 * **The three runners are a starting point, not a promise.** cutver knows which
 * binaries a workspace declares; it cannot know what they link against. A crate
 * pulling `fuser` under `cfg(unix)` builds on Linux and fails on macOS, because
 * `cfg(unix)` is true there and libfuse is not — measured, on a real release.
 * Windows crates that read an SDK at build time need it installed first. Both
 * are for the caller to add or to delete the row, the same way the gates are:
 * a generated file that guessed would ship a binary nobody tested.
 */
/**
 * Where the collect-and-upload step is spliced into the JavaScript jobs.
 *
 * The two of them differ only in their runner setup, so the part that reads the
 * config is written once and substituted rather than repeated — the previous
 * pair of hard-coded `path: dist/*` blocks is exactly how they came to differ
 * from each other in the first place.
 */
const UPLOAD_PLACEHOLDER = '@@UPLOAD@@'

/**
 * The collect step, from `artifacts:` in the config.
 *
 * **Folders are archived and files are not, which is the whole reason both keys
 * exist.** A release page carrying two hundred loose assets out of one `dist/`
 * helps nobody, so a folder becomes one `.tar.gz` named after it; a file is
 * attached as itself, under its own name.
 *
 * With no `artifacts:` block this is the behaviour that was hard-coded before
 * it existed — build into `dist/`, upload what is there — so a repository that
 * says nothing keeps exactly the release it had.
 */
function collectStep(config: Config): string {
  const artifacts = config.artifacts

  // **`auto` is resolved here, into a shell loop, rather than at `init` time.**
  // Nothing has been built when the workflow is written, so a generated file
  // cannot know whether this project emits `dist/` or `out/`. The loop probes
  // for them after the build has run, which is the one moment the answer exists
  // — and a directory that is not there is skipped rather than failing.
  const spec = artifacts === false ? null : artifacts
  const folders =
    spec?.folders === AUTO ? [...AUTO_DIRS] : (spec?.folders ?? [])
  const files =
    spec?.files === AUTO
      ? AUTO_DIRS.map(d => `${d}/*`)
      : (spec?.files ?? (spec ? [] : ['dist/*']))

  const lines: string[] = []
  if (folders.length) {
    lines.push(
      '          # One archive per matching directory, named after it. `-C` so the',
      '          # tar holds the folder rather than the path to it.',
      '          for dir in ' + folders.join(' ') + '; do',
      '            [ -d "$dir" ] || continue',
      'tar -czf "staged/$(basename "$dir").tar.gz" -C "$(dirname "$dir")" ' +
        '"$(basename "$dir")"',
      '          done',
    )
  }
  if (files.length) {
    lines.push(
      '          # `if` rather than `[ -f … ] && cp`, which returns 1 when the',
      '          # file is absent — and GitHub runs this under `bash -e`, so a',
      '          # missing last entry would fail the step rather than skip it.',
      '          for file in ' + files.join(' ') + '; do',
      '            if [ -f "$file" ]; then cp "$file" staged/; fi',
      '          done',
    )
  }

  return `      # Everything named by \`artifacts:\` in cutver.json / cutver.yml, gathered
      # into one directory so the release job has a single thing to download.
      - name: Collect what goes on the release
        run: |
          mkdir -p staged
${lines.join('\n')}
          ls -la staged

      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: staged/*`
}

const ARTIFACT_JOB: Record<Ecosystem, string> = {
  cargo: `  artifacts:
    name: \${{ matrix.target }}
    strategy:
      fail-fast: false
      matrix:
        include:
${CARGO_RUNNERS.map(r => `          - { os: ${`${r.os},`.padEnd(15)} target: ${r.target} }`).join('\n')}
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
      #
      # **\`tr -d '\\r'\` is load-bearing.** On a Windows runner \`shell: bash\` is
      # Git Bash, jq writes CRLF there, and \`read -r\` keeps the carriage
      # return — so a crate whose binary is \`app\` yields \`app\\r\`, and the copy
      # fails with \`cannot stat 'target/release/app'$'\\r''.exe'\` while the file
      # sits right there. Measured on a real release, after the tag was public.
      - name: Collect the binaries
        shell: bash
        run: |
          mkdir -p dist
          ext=""
          [ "\${{ runner.os }}" = "Windows" ] && ext=".exe"
          cargo metadata --format-version 1 --no-deps \\
            | jq -r '.packages[].targets[] | select(.kind[] == "bin") | .name' \\
            | tr -d '\\r' \\
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
      # a build artifact. Produce whatever belongs on the release here — a
      # \`bun build --compile\` executable, a tarball, a folder of assets — and
      # name it under \`artifacts:\` in your config.
      - run: bun run build

${UPLOAD_PLACEHOLDER}`,
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

      # **Yours to write, like the gates.** Produce whatever belongs on the
      # release here, and name it under \`artifacts:\` in your config.
      - run: npm run build

${UPLOAD_PLACEHOLDER}`,
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
/**
 * The GitHub release, which every tag gets — with or without binaries to hang
 * on it.
 *
 * **It used to be written only for `artifacts`, and that was the wrong seam.**
 * A package publishing to npm and nothing else got no release page at all,
 * which meant `cutver notes` never ran for it, which meant
 * `changelog.summarize` and every `summarizer:` setting were dead config in the
 * most common kind of repository there is. Binaries are a reason to *upload*
 * something; they were never the reason to have a release.
 *
 * @param artifacts whether an `artifacts` job ran and left files to attach.
 *                  Decides what this waits on, and whether there is anything to
 *                  download and upload.
 */
function releaseJob(
  eco: Ecosystem,
  version: string | undefined,
  artifacts: boolean,
): string {
  const RUN = runners(version)
  return `  release:
    needs: ${artifacts ? 'artifacts' : 'publish'}
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      # Checked out for one file: the changelog. The release body comes from the
      # section this tag already has, so the notes people read on GitHub are the
      # same words as the ones in the repository rather than a second telling
      # that drifts from it.
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.tag || github.ref_name }}

${
  artifacts
    ? `      - uses: actions/download-artifact@v4
        with:
          path: staged
          merge-multiple: true

`
    : ''
}${RUN[eco].setup}

      # The changelog section for this tag, and — if \`changelog.summarize\` is
      # set — rewritten by that command. Both live in cutver rather than in this
      # file on purpose: **anything written here is frozen at \`init\` time for
      # every repository that already ran it**, so improving it later would mean
      # asking everyone to regenerate a workflow they have since hand-edited.
      # One line here, the logic in a tool that upgrades on its own.
      #
      # It always exits 0. No changelog, no section for this version, a
      # summariser that died — each prints why on stderr and releases without a
      # body, because the binaries are the point of this job.
      #
      # \`timeout-minutes\` is the only guard a hanging summariser needs, and it
      # belongs here rather than inside cutver: GitHub enforces it, and a model
      # that never returns would otherwise hold a runner until the job timeout.
      - name: Release notes
        timeout-minutes: 15
        continue-on-error: true
        env:
          # The summariser command, when \`changelog.summarize\` is on. **Here and
          # not in cutver.yml**: a command in a tracked file is a command a fork
          # can put there, and \`gh pr checkout\` brings a fork's tracked files
          # into a maintainer's working tree. A workflow env is set by whoever
          # controls this repository.
          #
          # Anything that reads markdown on stdin and writes markdown on stdout:
          # a model on the runner, a curl to an endpoint, a script. Whatever it
          # needs, install it in a step above. Unset is fine — the notes go out
          # as written.
          CUTVER_SUMMARIZE: ''
          # The other route, and the one \`summarizer:\` in cutver.yml uses. That
          # block names a provider and a model; it deliberately holds no key,
          # because the config file is committed and shipped inside a published
          # tarball. So the key arrives here, from a repository secret.
          #
          # Unset is not a failure. cutver says which variables it looked in and
          # publishes the compiled notes — the same fallback as every other way
          # this step can go wrong.
          CUTVER_SUMMARIZE_KEY: \${{ secrets.CUTVER_SUMMARIZE_KEY }}
        run: ${RUN[eco].cutver} notes "$TAG" > notes.md

      # A prerelease is **marked** as one, which matters more than it sounds:
      # \`releases/latest/download/…\` follows GitHub's idea of latest and skips
      # prereleases, so an unmarked beta becomes the thing every install script
      # in the world downloads.
      - name: ${artifacts ? 'Attach them to the release' : 'Create the release'}
        env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
        run: |
          case "$TAG" in
            *-*) pre=--prerelease ;;
            *)   pre= ;;
          esac
          # An empty body is worse than a mechanical one — it reads as though
          # nothing changed. \`notes\` always exits 0, so this is about the file
          # being empty rather than about it having failed.
          [ -s notes.md ] || echo "_No release notes._" > notes.md
          gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes-file notes.md $pre \\
            || echo "release $TAG already exists — updating its notes"
          # The notes are set either way: a re-run after a failed leg must not
          # leave the body from a half-finished attempt.
          gh release edit "$TAG" --repo "$REPO" --notes-file notes.md${
            artifacts
              ? `
          # \`--clobber\` so a re-run replaces a partially uploaded asset rather
          # than failing on it.
          gh release upload "$TAG" --repo "$REPO" --clobber staged/*`
              : ''
          }`
}

/** The publish step, which is the only part that genuinely differs per registry. */
const PUBLISH_STEP: Record<Ecosystem, string> = {
  bun: `      # **Bun packs, npm publishes, and the split is load-bearing.**
      # \`workspace:^\` is a protocol npm does not understand; Bun rewrites it to
      # a real range when it builds a tarball and npm does not. Packing with
      # Bun and handing npm a finished tarball keeps that rewriting *and* gets
      # OIDC, because npm publishes the bytes it is given.
      - name: Publish
        if: steps.exists.outputs.value != 'true'
        env:
          DIST_TAG: \${{ steps.disttag.outputs.value }}
        run: |
          bun pm pack --destination "$GITHUB_WORKSPACE/dist"
          npm publish "$GITHUB_WORKSPACE"/dist/*.tgz --tag "$DIST_TAG"`,
  node: `      - name: Publish
        if: steps.exists.outputs.value != 'true'
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
      # No "already published?" guard here, unlike npm. crates.io has no
      # equivalent of a single-package existence probe across a whole workspace,
      # and \`cargo publish --workspace\` already refuses a version it has seen —
      # which is the same protection, arriving as a red run rather than a green
      # skip.
      - name: Publish
        env:
          CARGO_REGISTRY_TOKEN: \${{ secrets.CARGO_REGISTRY_TOKEN }}
        run: cargo publish --workspace`,
}

export function publishWorkflow(
  eco: Ecosystem,
  config: Config,
  version?: string,
  registry: boolean = publishesToRegistry(ADAPTER_FOR[eco], config),
  artifacts: boolean = producesArtifacts(ADAPTER_FOR[eco], config),
): string {
  const RUN = runners(version)
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
${
  npm
    ? `      # **Idempotent on purpose.** A package's first release goes out by hand —
      # trusted publishing cannot create a package that does not exist — and the
      # tag for it is pushed afterwards, which does fire this workflow. The
      # registry would refuse the duplicate anyway; refusing it here keeps the
      # run green, and a workflow that is red for a known-fine reason is one
      # nobody reads.
      - name: Already on the registry?
        id: exists
        run: |
          name=$(bun -e 'console.log(require("./package.json").name)')
          version="\${TAG#v}"
          if curl -fsS -o /dev/null "https://registry.npmjs.org/$name/$version"; then
            echo "value=true" >> "$GITHUB_OUTPUT"
            echo "$name@$version is already published — skipping the publish"
          else
            echo "value=false" >> "$GITHUB_OUTPUT"
          fi

`
    : ''
}${PUBLISH_STEP[eco]}`
    : ''
}${artifacts ? `${registry ? '\n\n' : ''}${ARTIFACT_JOB[eco].replace(UPLOAD_PLACEHOLDER, collectStep(config))}` : ''}${
    // **Every tag gets a release page, whatever it produces.** Previously this
    // was written only alongside binaries, so an npm-only package had nowhere
    // for `cutver notes` to run and its `summarizer:` config did nothing.
    registry || artifacts ? `\n\n${releaseJob(eco, version, artifacts)}` : ''
  }
`
}
