/**
 * The config file `cutver init` scaffolds.
 *
 * Hand-written, never serialised. A YAML serialiser emits flow style and drops
 * comments, and in this codebase the comments *are* the artifact — a config
 * whose keys nobody can explain is a config nobody edits with confidence.
 *
 * YAML rather than JSON for the same reason, though both are read. Anyone who
 * prefers JSON renames the file and deletes the `#` lines.
 *
 * **What it scaffolds is deliberately stricter than the default.** With no
 * config at all, any branch may cut a stable release — that is today's
 * behaviour and it has to stay, or upgrading cutver would silently stop
 * releases on `develop` for everyone already using it. A repository that runs
 * `init` is choosing the stricter shape, which is a different thing from
 * having it imposed.
 *
 * `publishes` comes from the manifest — see `detectPublishes`. A `package.json`
 * marked `"private": true` gets the same commented-out treatment cargo has
 * always had, for the same reason: publishing is not a side effect of wanting
 * version numbers, and here the repository has already said so out loud.
 */
import type { Ecosystem } from './schema'

export function configTemplate(eco: Ecosystem, publishes = true): string {
  return `# cutver.yml — which branches release what.
# Docs: https://cutver.okyle.dev/#/reference/config
schema: 1

# The ecosystem this repository releases. Removes the need for --adapter when
# a package.json and a Cargo.toml both exist.
target: ${eco}

# Whether a tag publishes to ${eco === 'cargo' ? 'crates.io' : 'npm'}. \`false\` is a real answer: tag and stop.
#
# What a tag *attaches* is a separate question — see \`artifacts:\` in the docs.
${
  eco === 'cargo'
    ? `#
# Left off here, and commented so the choice stays visible. **\`cargo publish\`
# reserves the crate name permanently**, for every member of the workspace —
# that is not something a generated workflow should do as a side effect of
# wanting version numbers. Uncomment to publish as well.
#
# publish: true`
    : publishes
      ? `publish: true`
      : `#
# **Written out rather than left off, because for npm the default is \`true\`.**
# Cargo can comment this line and mean it; here silence means publish, so an
# application would still get a workflow carrying \`npm publish\` and
# \`id-token: write\` — a permission nobody asked for, to do a thing npm would
# refuse anyway.
#
# \`false\` because this \`package.json\` says \`"private": true\`, which is npm's
# own refusal to publish. Tags, version numbers and changelogs all still
# happen. Set it to \`true\` if the package stops being private.
publish: false`
}

# Compile changelog sections from the commits in each release. Off by default:
# the version is mechanical, the prose is the work, and a list of subject lines
# is a worse copy of \`git log\`.
#
# What makes it worth turning on is the commit *body* — each entry is the
# subject plus the first paragraph of its body.
#
# **Turning this on hands cutver the file.** It is rewritten whole on every
# release, there is no \`## [Unreleased]\`, and edits do not survive. That is what
# lets it never parse the file, so a mangled changelog cannot break a release.
#
# changelog: true
# changelog:
#   sections: [breaking, feat, fix, perf, refactor, docs]
#   keep: 10
#
# A summariser can rewrite the GitHub release body — see the docs. It is not
# scaffolded here on purpose: it needs a key and a model that are yours to
# choose, and a commented-out block naming neither is an invitation to paste a
# key into a tracked file.

# Keyed by what the branch produces; the key is the prerelease identifier and
# the registry dist-tag. A branch matching nothing here releases nothing —
# which is the point: an accidental \`cutver\` on a feature branch cuts nothing.
channels:
  # Stable releases. Nothing else in this file may claim these branches.
  release:
    - main

  # \`{version}-beta\` matches a branch like \`1.3.0-beta\`, which declares the
  # base it is building towards; cutver refuses to cut from it once the commits
  # imply something higher. A bare \`beta\` declares only the channel and lets
  # the base move on its own — no renaming when a feat! lands.
  beta:
    - beta
    - "{version}-beta"

  alpha:
    - alpha
    - "{version}-alpha"

  # \`prerelease\` is accepted as a spelling of \`rc\`; the version it cuts is
  # still \`-rc.N\`, because the dist-tag is derived from the version.
  rc:
    - rc
    - prerelease
    - "{version}-rc"

  # Any other name is a channel too — add a key and it exists. Names are
  # kebab-case, and camelCase or snake_case is converted for you.
  # Registries are fine with it: react publishes \`canary\`, typescript \`dev\`.
  #
  # canary:
  #   - canary
  #   - "nightly/*"
`
}
