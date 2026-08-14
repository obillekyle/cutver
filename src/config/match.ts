/**
 * Which channel does this branch belong to, and why.
 *
 * Replaces two hard-coded functions with one table-driven one:
 * `channelFromBranch` (exact channel names) and `versionFromBranch` (names that
 * declare their own base). Both behaviours survive as *shapes* of a config
 * entry rather than as separate code paths, which is what lets a repository add
 * `develop` to the beta channel without a code change.
 *
 * The `via` field on every result is not decoration. With branch matching
 * configurable, "why did my branch not release" stops being obvious, and `via`
 * is what turns that from a bisect into one line of `cutver explain`.
 */
import { ConfigError, RELEASE, type Config } from './schema'

export type MatchShape = 'declaring' | 'literal' | 'glob'

export type Match =
  | {
      kind: 'channel'
      /** The channel name — the prerelease identifier and the npm dist-tag. */
      channel: string
      /** The config entry that fired. */
      via: string
      shape: MatchShape
      /** The base the branch declared, when a `{version}` pattern fired. */
      declared: string | null
    }
  | { kind: 'release'; via: string; shape: MatchShape }
  | { kind: 'none' }

/** What shape an entry is, inferred from its text — no extra syntax to learn. */
export function shapeOf(entry: string): MatchShape {
  if (entry.includes('{version}')) return 'declaring'
  return /[*?[\]]/.test(entry) ? 'glob' : 'literal'
}

/**
 * Declaring patterns compile to a regex with the base captured.
 *
 * `{version}-beta` becomes `/^(\d+\.\d+\.\d+)-beta$/`. Everything around the
 * placeholder is escaped, so a config entry cannot smuggle a regex in.
 */
function declaringRegex(entry: string): RegExp {
  const escaped = entry
    .split('{version}')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(\\d+\\.\\d+\\.\\d+)')
  return new RegExp(`^${escaped}$`)
}

/**
 * Try one entry against an already-normalised branch name.
 *
 * Returns the declared base (or `null` for a match that declares nothing), or
 * `undefined` for no match — distinct from `null`, because "matched and
 * declared nothing" and "did not match" are different answers.
 */
function tryEntry(entry: string, name: string): string | null | undefined {
  switch (shapeOf(entry)) {
    case 'declaring': {
      // A leading `v` is stripped for declaring patterns only, reproducing
      // `versionFromBranch`. Literals and globs do not get this, so `vbeta`
      // stays an ordinary branch exactly as it does today.
      const re = declaringRegex(entry)
      const m = re.exec(name) ?? re.exec(name.replace(/^v/, ''))
      return m?.[1] ?? undefined
    }
    case 'literal':
      return entry === name ? null : undefined
    case 'glob':
      // Bun.Glob and GitHub Actions agree: `*` does not cross `/`, `**` does.
      // That is why config globs reach `on.push.branches` verbatim rather than
      // being translated — a translation is a second place to be wrong.
      return new Bun.Glob(entry).match(name) ? null : undefined
  }
}

/** Declaring beats literal beats glob, so `*-beta` cannot swallow `1.3.0-beta`. */
const RANK: Record<MatchShape, number> = { declaring: 3, literal: 2, glob: 1 }

interface Hit {
  via: string
  shape: MatchShape
  declared: string | null
}

/** The best entry within one channel, or `null` if none matched. */
function bestIn(entries: string[], name: string): Hit | null {
  let best: Hit | null = null
  for (const entry of entries) {
    const declared = tryEntry(entry, name)
    if (declared === undefined) continue

    const shape = shapeOf(entry)
    // Declaring must win over a glob, or `*-beta` matching `1.3.0-beta` would
    // quietly disable the branch-declares-a-lower-version refusal.
    if (!best || RANK[shape] > RANK[best.shape]) best = { via: entry, shape, declared }
  }
  return best
}

/**
 * Which rule claims this branch.
 *
 * Channels are evaluated before `release`, because the default `release: ['**']`
 * matches everything and would otherwise collide with every channel on every
 * repository.
 *
 * **Two channels matching one branch is refused, never resolved.** The
 * difference between them is which prerelease identifier gets published — and
 * picking the first, or the most specific, would be cutver quietly deciding
 * something the repository did not.
 */
export function matchBranch(branch: string, config: Config): Match {
  // `release/` is stripped unconditionally, once, exactly as both of the
  // functions this replaces do.
  const name = branch.trim().replace(/^release\//, '')

  const hits: { channel: string; hit: Hit }[] = []
  for (const [channel, entries] of Object.entries(config.channels)) {
    if (channel === RELEASE) continue
    const hit = bestIn(entries, name)
    if (hit) hits.push({ channel, hit })
  }

  if (hits.length > 1) {
    const named = hits.map(h => `\`${h.channel}\` via "${h.hit.via}"`).join(' and ')
    throw new ConfigError(
      `branch '${branch}' matches two channels — ${named}.\n` +
        '        A branch can only be in one channel; remove it from one of them.',
    )
  }

  const only = hits[0]
  if (only) {
    return {
      kind: 'channel',
      channel: only.channel,
      via: only.hit.via,
      shape: only.hit.shape,
      declared: only.hit.declared,
    }
  }

  const stable = bestIn(config.channels[RELEASE] ?? [], name)
  if (stable) return { kind: 'release', via: stable.via, shape: stable.shape }

  return { kind: 'none' }
}

/**
 * Every entry that was tried and did not fire, for `explain`.
 *
 * The useful half of a "nothing matched" answer is the list of things that were
 * checked — otherwise the only way to find a typo in a branch pattern is to
 * edit it and push again.
 */
export function triedEntries(config: Config): { channel: string; entries: string[] }[] {
  return Object.entries(config.channels).map(([channel, entries]) => ({ channel, entries }))
}
