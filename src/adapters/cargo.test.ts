import { describe, expect, test } from 'bun:test'
import { cargoVersion, members, replaceCargoVersion } from './cargo'

/** The same document twice, differing only in line endings. */
const lf = `[workspace]
resolver = "2"
members = [
    "crates/alloyfs-proto",
    "crates/alloyfs-cli",
]

[workspace.package]
version = "0.1.0"
edition = "2021"
license = "MIT"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
`

const crlf = lf.replace(/\n/g, '\r\n')

describe('cargoVersion', () => {
  test('reads the workspace version', () => {
    expect(cargoVersion(lf)).toMatchObject({
      value: '0.1.0',
      section: 'workspace.package',
    })
  })

  test('a CRLF file yields the same version, with no carriage return on it', () => {
    // **The bug this pins.** A parser that takes the rest of the line and
    // strips quotes hands back `0.1.0\r`, which reads correctly everywhere it
    // is printed and then names a directory `alloyfs-0.1.0\r` — a name Windows
    // will not create. Reading from between the quotes makes it structurally
    // impossible rather than trimmed away after the fact.
    const found = cargoVersion(crlf)
    expect(found?.value).toBe('0.1.0')
    expect(found?.value).not.toContain('\r')
    expect(found?.section).toBe('workspace.package')
  })

  test('does not take a version from the wrong table', () => {
    // `[workspace.dependencies]` is full of `version = "1"`. Picking the first
    // `version =` in the file finds `serde` about as often as the real one.
    const reordered = `[workspace.dependencies]
serde = "1"
version = "9.9.9"

[workspace.package]
version = "0.1.0"
`
    expect(cargoVersion(reordered)?.value).toBe('0.1.0')
  })

  test('falls back to [package] for a single-crate repository', () => {
    const single = `[package]
name = "solo"
version = "2.3.4"
edition = "2021"
`
    expect(cargoVersion(single)).toMatchObject({
      value: '2.3.4',
      section: 'package',
    })
  })

  test('prefers [workspace.package] over a root [package]', () => {
    // A workspace root that is also a crate. The members inherit the former.
    const both = `[package]
name = "root-crate"
version = "9.9.9"

[workspace.package]
version = "0.4.0"
`
    expect(cargoVersion(both)?.value).toBe('0.4.0')
  })

  test('null when nothing declares a literal version', () => {
    expect(
      cargoVersion('[package]\nname = "x"\nversion.workspace = true\n'),
    ).toBeNull()
    expect(cargoVersion('')).toBeNull()
  })
})

describe('replaceCargoVersion', () => {
  test('changes the version and nothing else', () => {
    const at = cargoVersion(lf)
    if (!at) throw new Error('fixture has no version')
    const out = replaceCargoVersion(lf, at, '0.2.0')

    expect(out).toContain('version = "0.2.0"')
    expect(out).not.toContain('version = "0.1.0"')
    // Every other byte survives: comments, key order, the dependency table.
    expect(out.replace('0.2.0', '0.1.0')).toBe(lf)
  })

  test('leaves CRLF endings alone', () => {
    const at = cargoVersion(crlf)
    if (!at) throw new Error('fixture has no version')
    const out = replaceCargoVersion(crlf, at, '1.0.0')

    expect(out).toContain('version = "1.0.0"')
    expect(out.split('\n').length - 1).toBe(out.split('\r\n').length - 1)
    expect(out.replace('1.0.0', '0.1.0')).toBe(crlf)
  })

  test('a longer version does not overrun the quotes', () => {
    // The splice is offset-based, so an off-by-one here would eat the closing
    // quote and produce a file cargo cannot parse.
    const at = cargoVersion(lf)
    if (!at) throw new Error('fixture has no version')
    expect(replaceCargoVersion(lf, at, '10.20.30-alpha.11')).toContain(
      'version = "10.20.30-alpha.11"\n',
    )
  })
})

describe('members', () => {
  test('reads the member list, LF or CRLF', () => {
    expect(members(lf)).toEqual(['crates/alloyfs-proto', 'crates/alloyfs-cli'])
    expect(members(crlf)).toEqual([
      'crates/alloyfs-proto',
      'crates/alloyfs-cli',
    ])
  })

  test('empty for a repository with no workspace table', () => {
    expect(members('[package]\nname = "solo"\n')).toEqual([])
  })
})
