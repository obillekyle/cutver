import { describe, expect, test } from 'bun:test'
import { platformAdvice, systemDeps, SEARCHERS } from './platforms'

/**
 * The classification, driven from `cargo metadata`-shaped documents.
 *
 * Pure on purpose: the interesting cases are all about what counts as "needs
 * something installed", and a Rust toolchain in the test suite would buy
 * nothing but minutes. `probeTarget` is the thin shell that runs cargo and
 * hands the parsed document to this.
 *
 * The fixture is modelled on the real graph that cost two release runs —
 * `fuser` declaring `pkg-config` as a build-dependency and **no `links`
 * field**, which is why the obvious detector does not work.
 */

function pkg(name: string, buildDeps: string[] = [], normalDeps: string[] = []) {
  return {
    name,
    links: null,
    dependencies: [
      ...buildDeps.map(n => ({ name: n, kind: 'build' })),
      ...normalDeps.map(n => ({ name: n, kind: null })),
    ],
  }
}

describe('systemDeps', () => {
  test('finds a crate that searches for a preinstalled library', () => {
    const deps = systemDeps({
      packages: [pkg('alloyfs-cli', [], ['fuser']), pkg('fuser', ['pkg-config'])],
    })
    expect(deps).toEqual([{ crate: 'fuser', why: SEARCHERS['pkg-config'] as string }])
  })

  test('ignores `cc`, which is everywhere and usually vendors', () => {
    // The one people expect to be flagged. Flagging it would put a warning on
    // half the ecosystem and teach everyone to skip reading these.
    expect(systemDeps({ packages: [pkg('ring', ['cc'])] })).toEqual([])
  })

  test('ignores a normal dependency that merely shares a name', () => {
    // `kind: null` is a regular dependency. Only build-time searching counts.
    expect(systemDeps({ packages: [pkg('thing', [], ['pkg-config'])] })).toEqual([])
  })

  test('names every crate, not every searcher', () => {
    // Four crates using pkg-config is four problems to solve, and the message
    // is only actionable if it says which.
    const deps = systemDeps({
      packages: [pkg('a-sys', ['pkg-config']), pkg('b-sys', ['pkg-config'])],
    })
    expect(deps.map(d => d.crate)).toEqual(['a-sys', 'b-sys'])
  })

  test('does not depend on `links`, which the real case leaves null', () => {
    // Measured against alloyfs: `fuser` links libfuse and declares no `links`
    // field at all, so a detector built on it reports nothing.
    const doc = { packages: [pkg('fuser', ['pkg-config'])] }
    expect(doc.packages.every(p => p.links === null)).toBe(true)
    expect(systemDeps(doc)).toHaveLength(1)
  })

  test('survives a document that is not the shape it expects', () => {
    // cargo's output is trusted only as far as it parses; a probe that threw
    // would take down the `init` it is decorating.
    for (const junk of [null, undefined, {}, { packages: 'nope' }, { packages: [{}] }]) {
      expect(() => systemDeps(junk)).not.toThrow()
    }
  })
})

describe('platformAdvice', () => {
  test('says nothing when there is nothing to say', () => {
    expect(platformAdvice([])).toEqual([])
  })

  test('names the target and the crate together', () => {
    const lines = platformAdvice([
      { target: 'aarch64-apple-darwin', deps: [{ crate: 'fuser', why: 'searches for x' }] },
    ]).join('\n')

    expect(lines).toContain('aarch64-apple-darwin')
    expect(lines).toContain('fuser')
    // The consequence is the part that makes it worth acting on: one bad row
    // costs the whole release, because the attach job waits on all of them.
    expect(lines).toContain('fails the whole release')
  })
})
