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
 * Channel names must be lowercase letters only, and that is not style.
 *
 * The prerelease counter has exactly one reader — `PRERELEASE` in
 * `version-from-commits.ts` — and it parses the identifier as `[a-z]+`.
 * A channel called `rc2` or `v2-latest` never matches it, so the counter
 * restarts at `.0` on every run; the next version then equals the current one,
 * the idempotency guard fires, and the channel reports "nothing to release"
 * forever. Measured, not feared.
 *
 * Keys are lowercased before this is applied, so `Beta` and `myPrefix` are
 * fixed rather than refused. A digit or a hyphen cannot be fixed.
 */
export const CHANNEL_NAME = /^[a-z]+$/

export interface Config {
  /** Config schema version — not the project's. */
  schema: number
  /** Which ecosystem this repository releases; `null` means "detect, as today". */
  target: Ecosystem | null
  /** Branch patterns keyed by what they produce. Includes `release`. */
  channels: Record<string, string[]>
  /** Where it was loaded from, for `explain`. `null` when nothing was found. */
  source: string | null
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
  source: null,
}

/** The prerelease channels, in the order they should be reported. `release` excluded. */
export function channelNames(config: Config): string[] {
  return Object.keys(config.channels).filter(c => c !== RELEASE)
}
