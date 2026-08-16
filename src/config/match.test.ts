import { describe, expect, test } from 'bun:test'
import { matchBranch, shapeOf } from './match'
import { ConfigError, DEFAULT_CONFIG, type Config } from './schema'

const config = (channels: Record<string, string[]>): Config => ({
  ...DEFAULT_CONFIG,
  channels: { release: ['**'], ...channels },
})

describe('shapeOf', () => {
  test('infers the shape from the text, with no extra syntax', () => {
    expect(shapeOf('beta')).toBe('literal')
    expect(shapeOf('develop')).toBe('literal')
    expect(shapeOf('*-beta')).toBe('glob')
    expect(shapeOf('nightly/*')).toBe('glob')
    expect(shapeOf('{version}-beta')).toBe('declaring')
  })
})

describe('matching', () => {
  test('a literal puts an arbitrary branch in a channel — the actual ask', () => {
    const m = matchBranch('develop', config({ beta: ['beta', 'develop'] }))
    expect(m).toMatchObject({
      kind: 'channel',
      channel: 'beta',
      via: 'develop',
      declared: null,
    })
  })

  test('globs match whole branch names, and `*` does not cross a slash', () => {
    // Bun.Glob and GitHub Actions agree on this, which is why config globs
    // reach `on.push.branches` verbatim instead of being translated.
    const c = config({ canary: ['nightly/*'] })
    expect(matchBranch('nightly/2026-08', c).kind).toBe('channel')
    expect(matchBranch('nightly/a/b', c).kind).toBe('release')
  })

  test('`release/` is stripped once, for every shape', () => {
    const c = config({ beta: ['develop', '{version}-beta'] })
    expect(matchBranch('release/develop', c)).toMatchObject({
      kind: 'channel',
      channel: 'beta',
    })
    expect(matchBranch('release/1.3.0-beta', c)).toMatchObject({
      declared: '1.3.0',
    })
  })

  test('a leading `v` is stripped for declaring patterns only', () => {
    // `v1.3.0-beta` declares 1.3.0 — but `vbeta` must stay an ordinary branch,
    // or a `v`-prefixed feature branch would start publishing prereleases.
    const c = config({ beta: ['beta', '{version}-beta'] })
    expect(matchBranch('v1.3.0-beta', c)).toMatchObject({ declared: '1.3.0' })
    expect(matchBranch('vbeta', c).kind).toBe('release')
  })

  test('an entry cannot smuggle a regex in', () => {
    // Everything around `{version}` is escaped, so a dot is a dot.
    const c = config({ beta: ['{version}-be.a'] })
    expect(matchBranch('1.3.0-beXa', c).kind).toBe('release')
    expect(matchBranch('1.3.0-be.a', c)).toMatchObject({ declared: '1.3.0' })
  })

  test('two channels matching one branch is refused, naming both', () => {
    // Which identifier gets published is the highest-consequence choice here.
    // Picking the first, or the most specific, would be cutver deciding
    // something the repository did not.
    const c = config({ beta: ['develop'], canary: ['dev*'] })
    expect(() => matchBranch('develop', c)).toThrow(ConfigError)
    expect(() => matchBranch('develop', c)).toThrow(
      /`beta` via "develop" and `canary` via "dev\*"/,
    )
  })

  test('channels are evaluated before release', () => {
    // The default `release: ['**']` matches everything, so without this order
    // every channel on every repository would be shadowed.
    const c = config({ beta: ['develop'] })
    expect(matchBranch('develop', c)).toMatchObject({
      kind: 'channel',
      channel: 'beta',
    })
    expect(matchBranch('main', c).kind).toBe('release')
  })

  test('a branch matching nothing returns `none`, and does not throw', () => {
    // Load-bearing: `none` becomes a Plan variant, never a refusal. A refusal
    // here would make the pre-push hook block every feature branch push.
    const c = config({ beta: ['beta'] })
    const strict: Config = {
      ...c,
      channels: { ...c.channels, release: ['main'] },
    }

    expect(matchBranch('feat/login', strict)).toEqual({ kind: 'none' })
  })

  test('a custom channel is just another key', () => {
    const c = config({ canary: ['canary'] })
    expect(matchBranch('canary', c)).toMatchObject({
      kind: 'channel',
      channel: 'canary',
    })
  })
})
