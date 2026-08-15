/**
 * What a `cutver.json` / `cutver.yml` means, as types and defaults.
 *
 * **The default is not a scatter of `??` fallbacks — it is a real `Config`.**
 * `DEFAULT_CONFIG` below is today's hard-coded behaviour written out, so a
 * repository with no config file and one with a config file take exactly the
 * same code path. That is what makes "zero config behaves as it always did"
 * something a test can prove rather than something a reviewer has to trust.
 */

export const SCHEMA_VERSION = 1

/** Anything wrong with the config itself: unreadable, unknown key, bad channel name. */
export class ConfigError extends Error {}

export const ECOSYSTEMS = ['cargo', 'node', 'bun'] as const
export type Ecosystem = (typeof ECOSYSTEMS)[number]

/**
 * What a tag produces. A list, because these are not alternatives.
 *
 * cutver's own release does both: `cutver@1.0.1` is on npm *and* every tag
 * carries five standalone executables, because a repository with no JavaScript
 * runtime still needs a way to run a version bump. Modelling this as an enum
 * would have made its own release shape unrepresentable.
 *
 * - `registry` — publish to the ecosystem's registry (npm, crates.io).
 * - `artifacts` — build executables and attach them to the GitHub release.
 *
 * An empty list is a real answer: tag and stop. That is the right shape for a
 * private service, and it is what stops the registry preflight refusing a
 * release for ten crates nobody intends to publish.
 */
export const PUBLISH_TARGETS = ['registry', 'artifacts'] as const
export type PublishTarget = (typeof PUBLISH_TARGETS)[number]

/**
 * The default when the config says nothing, keyed by adapter rather than
 * ecosystem because that is what every caller already has.
 *
 * **cargo defaults to artifacts, and js to the registry**, which is not
 * symmetry for its own sake. Publishing to crates.io *reserves the crate name
 * permanently* — ten members means ten names claimed by a workflow the author
 * ran to get version numbers. A Rust workspace is also far more often an
 * application than a library. npm has no reservation semantics of that kind and
 * a package.json almost always exists to be installed, so the safe default
 * differs by ecosystem the same way the risk does.
 */
export const DEFAULT_PUBLISH: Record<'js' | 'cargo', PublishTarget[]> = {
  js: ['registry'],
  cargo: ['artifacts'],
}

/**
 * The reserved channel key: branches that cut a *stable* release.
 *
 * It lives in the same map as the prerelease channels because it is the same
 * question — "which branches mean this" — and because a separate top-level key
 * would let a branch appear in both without anything noticing.
 */
export const RELEASE = 'release'

/**
 * A channel name that is not the channel's name.
 *
 * `prerelease` reads as a category rather than a channel and plenty of projects
 * name the branch that; it resolved to `rc` in the branch-name rules from
 * 0.1.0-beta.9, and it resolves to `rc` as a config key too. Declaring both is
 * refused rather than merged — see `load.ts`.
 */
export const KEY_ALIASES: Record<string, string> = { prerelease: 'rc' }

/**
 * Channel names are kebab-case: lowercase words joined by single hyphens.
 *
 * A hyphen *inside* the identifier is safe, and that is worth stating because
 * the neighbouring rule looks like it forbids one. Measured on Bun 1.3.14:
 *
 *     1.2.0-my-prefix.9  <  1.2.0-my-prefix.10     correct
 *     1.2.0-rc-9         >  1.2.0-rc-10            INVERTED
 *
 * The difference is *where* the hyphen is. `my-prefix` is one alphanumeric
 * identifier and the counter is still its own dot-separated numeric one, so
 * precedence works. `rc-9` fuses the counter into the text, and then ten sorts
 * below nine. So the constraint is not "no hyphens" — it is "the counter keeps
 * its dot", which is a property of the format and not of the name.
 *
 * Digits are still out. They are legal semver, but they buy nothing here and
 * an all-digit identifier has leading-zero rules that would need their own
 * test; a name is not the place to spend that.
 */
export const CHANNEL_NAME = /^[a-z]+(?:-[a-z]+)*$/

/**
 * Normalise a channel key to kebab-case.
 *
 * `myPrefix`, `MyPrefix`, `my_prefix` and `my prefix` all name the same thing
 * as far as anyone reading the config is concerned, so they resolve to the same
 * channel rather than three of them being errors and one working. Normalising
 * once here is what keeps the version string, the git tag, the dist-tag and the
 * generated workflow arm from ever disagreeing about spelling.
 *
 * Two keys that normalise to the same channel are refused, not merged — see
 * `load.ts`. Silently merging two rules is how a branch ends up in a channel
 * nobody declared.
 */
export function toKebab(name: string): string {
  return name
    .trim()
    // camelCase and PascalCase, including runs of capitals: `HTTPServer` has
    // to break as `http-server`, not `h-t-t-p-server`.
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export interface Config {
  /** Config schema version — not the project's. */
  schema: number
  /** Which ecosystem this repository releases; `null` means "detect, as today". */
  target: Ecosystem | null
  /** Branch patterns keyed by what they produce. Includes `release`. */
  channels: Record<string, string[]>
  /** What a tag produces. `null` means "the default for this adapter". */
  publish: PublishTarget[] | null
  /** Where it was loaded from, for `explain`. `null` when nothing was found. */
  source: string | null
}

/**
 * What a tag produces here, with the adapter default applied.
 *
 * `null` and `[]` are deliberately different: `null` is "nothing was said, use
 * the default", `[]` is "say it explicitly — tag and stop". Collapsing them
 * would make opting out of publishing impossible to express.
 */
export function publishTo(adapter: 'js' | 'cargo', config: Config): PublishTarget[] {
  return config.publish ?? DEFAULT_PUBLISH[adapter]
}

/**
 * Today's behaviour, written out.
 *
 * Every entry here reproduces something the hard-coded rules already do:
 *
 * - `release: ['**']` — **any** branch may cut a stable release, which is the
 *   current behaviour and must stay it. Writing a `release` list is the opt-in
 *   to strictness; if this were `[main, master]` then upgrading cutver would
 *   silently stop releases on `develop` for everyone already using it.
 * - the bare channel names reproduce `channelFromBranch`,
 * - the `{version}-…` patterns reproduce `versionFromBranch`,
 * - `prerelease` under `rc` is where both alias tables went.
 *
 * `release/` is stripped from a branch before matching, so there are no
 * `release/beta` entries here — that prefix is handled once, in `match.ts`.
 */
export const DEFAULT_CONFIG: Config = {
  schema: SCHEMA_VERSION,
  target: null,
  channels: {
    [RELEASE]: ['**'],
    alpha: ['alpha', '{version}-alpha'],
    beta: ['beta', '{version}-beta'],
    rc: ['rc', 'prerelease', '{version}-rc', '{version}-prerelease'],
  },
  publish: null,
  source: null,
}

/** The prerelease channels, in the order they should be reported. `release` excluded. */
export function channelNames(config: Config): string[] {
  return Object.keys(config.channels).filter(c => c !== RELEASE)
}
