import { describe, expect, test } from 'bun:test'
import { withStage } from '../plan'
import {
  CHANNELS,
  versionFromBranch,
  withChannel,
  type Channel,
} from '../version-from-commits'
import { matchBranch } from './match'
import { DEFAULT_CONFIG } from './schema'

/**
 * The branch rules exactly as they stood before the config existed, kept here
 * as an oracle.
 *
 * These two functions used to live in `plan.ts`. They are copied verbatim
 * rather than imported because production code should not carry a second
 * implementation of a thing it no longer uses — but deleting them outright
 * would delete the only independent statement of what the behaviour *was*.
 * Here they are a fixture: the thing `DEFAULT_CONFIG` has to agree with.
 */
const ALIASES: Record<string, Channel> = { prerelease: 'rc' }

function canonicalBranch(branch: string): string {
  const name = branch.trim()
  for (const [alias, channel] of Object.entries(ALIASES)) {
    const re = new RegExp(`(^|[/-])${alias}$`)
    if (re.test(name))
      return name.replace(re, (_, sep: string) => `${sep}${channel}`)
  }
  return name
}

function channelFromBranch(branch: string): Channel | null {
  const name = canonicalBranch(branch).replace(/^release\//, '')
  return CHANNELS.includes(name as Channel) ? (name as Channel) : null
}

/**
 * The proof that a config file changes nothing for a repository without one.
 *
 * `DEFAULT_CONFIG` claims to be today's hard-coded rules written out as data.
 * This drives the old functions and the new table over the same branch names
 * and asserts they agree — so the claim is checked rather than asserted, and
 * it keeps being checked after the old functions are deleted, because this file
 * is the last thing that imports them.
 *
 * Every name below is one the current suite already cares about. The awkward
 * ones are the point: `beta-two`, `my-beta` and `feat/beta-ui` must stay
 * ordinary branches, and `vbeta` must not become a channel just because
 * `v1.3.0-beta` does.
 */
const NAMES = [
  // ordinary
  'main',
  'master',
  'develop',
  'feat/x',
  'feat/beta-ui',
  'beta-two',
  'my-beta',
  'betas',
  'alpha/x',
  'vbeta',
  'prereleases',
  'my-prerelease',
  'prerelease/x',
  '',
  // bare channels
  'alpha',
  'beta',
  'rc',
  'prerelease',
  'release/beta',
  'release/prerelease',
  // declaring
  '1.3.0-beta',
  'v1.3.0-beta',
  'release/1.3.0-beta',
  'release/v1.3.0-beta',
  '1.3.0-alpha',
  '1.0.1-rc',
  '1.2.1-prerelease',
  // near misses that must stay ordinary
  '1.2.0',
  '1.2.0-fix',
  '1.2-beta',
  '1.3.0-beta.3',
]

/** What the hard-coded rules say today, in the shape `matchBranch` returns. */
function today(branch: string): {
  channel: string | null
  declared: string | null
} {
  const declared = versionFromBranch(canonicalBranch(branch))
  if (declared) return { channel: declared.channel, declared: declared.base }
  return { channel: channelFromBranch(branch), declared: null }
}

describe('DEFAULT_CONFIG reproduces the hard-coded rules', () => {
  test('agrees on the channel for every branch shape', () => {
    for (const name of NAMES) {
      const before = today(name)
      const after = matchBranch(name, DEFAULT_CONFIG)

      const channel = after.kind === 'channel' ? after.channel : null
      expect(channel, `channel for '${name}'`).toBe(before.channel)
    }
  })

  test('agrees on the declared base, including that most names declare none', () => {
    for (const name of NAMES) {
      const before = today(name)
      const after = matchBranch(name, DEFAULT_CONFIG)
      const declared = after.kind === 'channel' ? after.declared : null

      expect(declared, `declared base for '${name}'`).toBe(before.declared)
    }
  })

  test('`prerelease` resolves to rc in both shapes, without an alias table', () => {
    // The two independent alias tables are what this replaces: one entry in
    // the rc channel now covers the branch name, the `release/` form, and the
    // versioned form.
    for (const name of [
      'prerelease',
      'release/prerelease',
      '1.2.1-prerelease',
    ]) {
      const m = matchBranch(name, DEFAULT_CONFIG)
      expect(m.kind, name).toBe('channel')
      if (m.kind === 'channel') expect(m.channel, name).toBe('rc')
    }
  })

  test('a declaring pattern wins over a glob for the same branch', () => {
    // `*-beta` and `{version}-beta` both match `1.3.0-beta`. Declaring has to
    // win, or the base would be computed instead of read off the branch and
    // the "branch declares a lower version" refusal would silently stop firing.
    const config = {
      ...DEFAULT_CONFIG,
      channels: {
        ...DEFAULT_CONFIG.channels,
        beta: ['*-beta', '{version}-beta'],
      },
    }
    const m = matchBranch('1.3.0-beta', config)

    expect(m.kind).toBe('channel')
    if (m.kind === 'channel') {
      expect(m.shape).toBe('declaring')
      expect(m.declared).toBe('1.3.0')
    }
  })

  test('every ordinary branch falls through to a stable release, as today', () => {
    // `release: ['**']` is the default precisely so that upgrading cutver does
    // not start refusing releases on branches that work now.
    for (const name of ['main', 'develop', 'feat/x', 'beta-two']) {
      expect(matchBranch(name, DEFAULT_CONFIG).kind, name).toBe('release')
    }
  })
})

/**
 * The other half of the substitution: the counter.
 *
 * `plan.ts` needed a regex that can read a kebab-case identifier, which the
 * ported `PRERELEASE` cannot. Rather than widening the ported file, the rule is
 * restated in five lines and the original is kept as its oracle — so the copy
 * has to agree with it everywhere the original applies, which is a stronger
 * guarantee than a cast that silently would not.
 */
describe('withStage reproduces the ported counter', () => {
  const BASES = ['0.1.0', '1.2.3', '1.3.0', '2.0.0']
  const CURRENTS = [
    '1.2.3',
    '1.3.0-beta.0',
    '1.3.0-beta.9',
    '1.3.0-beta.10',
    '1.3.0-alpha.4',
    '2.0.0-rc.0',
    '1.3.0-my-prefix.3',
    'not-a-version',
    '',
  ]

  test('byte-identical for every channel the ported regex can read', () => {
    for (const base of BASES) {
      for (const channel of CHANNELS) {
        for (const current of CURRENTS) {
          expect(
            withStage(base, channel, current),
            `${base} / ${channel} / ${current}`,
          ).toBe(withChannel(base, channel, current))
        }
      }
    }
  })

  test('and continues a kebab-case counter the ported one freezes', () => {
    // The reason the copy exists. `PRERELEASE` reads `[a-z]+`, so it never
    // matches `my-prefix` and restarts at .0 forever — which then equals the
    // current version and reports "nothing to release" for good.
    expect(
      withChannel('1.3.0', 'my-prefix' as never, '1.3.0-my-prefix.3'),
    ).toBe('1.3.0-my-prefix.0')
    expect(withStage('1.3.0', 'my-prefix', '1.3.0-my-prefix.3')).toBe(
      '1.3.0-my-prefix.4',
    )
  })

  test('the counter keeps its own dot, so .9 sorts below .10', () => {
    // The hazard is a hyphen *before* the counter, not inside the identifier.
    const nine = withStage('1.3.0', 'my-prefix', '1.3.0-my-prefix.8')
    const ten = withStage('1.3.0', 'my-prefix', nine)
    expect([nine, ten]).toEqual(['1.3.0-my-prefix.9', '1.3.0-my-prefix.10'])
    expect(Bun.semver.order(nine, ten)).toBe(-1)
  })

  test('a base or channel change restarts it, exactly as before', () => {
    expect(withStage('2.0.0', 'my-prefix', '1.3.0-my-prefix.7')).toBe(
      '2.0.0-my-prefix.0',
    )
    expect(withStage('1.3.0', 'other-name', '1.3.0-my-prefix.7')).toBe(
      '1.3.0-other-name.0',
    )
  })
})
