/**
 * The config file `cutver init` scaffolds.
 *
 * Hand-written, never serialised. `Bun.YAML.stringify` emits flow style and
 * drops comments, and in this codebase the comments *are* the artifact — a
 * config whose keys nobody can explain is a config nobody edits with
 * confidence.
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
 */
import type { Ecosystem } from './schema'

export function configTemplate(eco: Ecosystem): string {
  return `# cutver.yml — which branches release what.
# Docs: https://cutver.okyle.dev/#/reference/config
schema: 1

# The ecosystem this repository releases. Removes the need for --adapter when
# a package.json and a Cargo.toml both exist.
target: ${eco}

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

  # Any other lowercase name is a channel too — add a key and it exists.
  # Registries are fine with it: react publishes \`canary\`, typescript \`dev\`.
  #
  # canary:
  #   - canary
  #   - "nightly/*"
`
}
