import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { rollChangelog, writeChangelog } from './index'
import { detectEol, detectIndent, withEol } from '../text'

const made: string[] = []

afterEach(async () => {
  while (made.length)
    await rm(made.pop() as string, { recursive: true, force: true })
})

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = (await mkdtemp(`${tmpdir()}/cutver-log-`)).replaceAll('\\', '/')
  made.push(dir)
  for (const [rel, body] of Object.entries(files))
    await Bun.write(`${dir}/${rel}`, body)
  return dir
}

const roll = (root: string, dryRun = false) =>
  rollChangelog({ root, version: '1.3.0', dryRun, today: '2026-08-14' })

describe('rollChangelog', () => {
  test('opens a dated heading and keeps Unreleased above it', async () => {
    const root = await fixture({
      'CHANGELOG.md':
        '# Changelog\n\n## [Unreleased]\n\n- something\n\n## [1.2.0] — ' +
        '2026-01-01\n',
    })
    expect(await roll(root)).toMatchObject({ state: 'updated' })

    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toBe(
      '# Changelog\n\n## [Unreleased]\n\n## [1.3.0] — 2026-08-14\n\n- ' +
        'something\n\n## [1.2.0] — 2026-01-01\n',
    )
  })

  test('no changelog at all is not an error', async () => {
    // A repository that keeps its notes on a releases page is a normal
    // repository. Refusing to cut a version for it would be this tool
    // inventing a requirement.
    expect(await roll(await fixture({}))).toBeNull()
  })

  test('a changelog with no Unreleased heading is left alone, and said out loud', async () => {
    // Dying would block a release over a formatting convention the repository
    // never agreed to; silence would hide that notes someone wants were not
    // rolled.
    const root = await fixture({ 'CHANGELOG.md': '# Changelog\n\n## 1.2.0\n' })
    expect(await roll(root)).toMatchObject({ state: 'unchanged' })
    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toBe(
      '# Changelog\n\n## 1.2.0\n',
    )
  })

  test('a CRLF changelog stays CRLF', async () => {
    const root = await fixture({
      'CHANGELOG.md': '# Changelog\r\n\r\n## [Unreleased]\r\n',
    })
    await roll(root)
    const after = await Bun.file(`${root}/CHANGELOG.md`).text()

    expect(after).toBe(
      '# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [1.3.0] — 2026-08-14\r\n',
    )
    expect(after).not.toMatch(/[^\r]\n/)
  })

  test('a dry run reports the heading it would add and writes nothing', async () => {
    const root = await fixture({ 'CHANGELOG.md': '## [Unreleased]\n' })
    expect(await roll(root, true)).toMatchObject({ state: 'updated' })
    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toBe(
      '## [Unreleased]\n',
    )
  })
})

describe('writeChangelog', () => {
  const section = (version: string, notes = '### Fixes\n\n- a bug') => ({
    version,
    date: '2026-08-14',
    notes,
  })

  test('rewrites the file without reading what was there', async () => {
    // The whole safety argument for this mode. A malformed, truncated or
    // hand-mangled changelog costs nothing, because it is never parsed —
    // parsing is what makes a file nobody has read in a year able to break a
    // release.
    const root = await fixture({
      'CHANGELOG.md': 'not markdown at all\x00\x00 ## [broken',
    })

    expect(
      await writeChangelog({
        root,
        dryRun: false,
        keep: null,
        releases: [section('1.3.0')],
      }),
    ).toMatchObject({ state: 'updated' })

    const text = await Bun.file(`${root}/CHANGELOG.md`).text()
    expect(text).not.toContain('not markdown at all')
    expect(text).toContain('## [1.3.0] — 2026-08-14')
    expect(text).not.toContain('## [Unreleased]')
  })

  test('writes a changelog into a repository that had none', async () => {
    const root = await fixture({})
    await writeChangelog({
      root,
      dryRun: false,
      keep: null,
      releases: [section('1.3.0')],
    })
    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toContain(
      '## [1.3.0]',
    )
  })

  test('keeps the newest N and points at where the rest went', async () => {
    const root = await fixture({})
    const releases = ['1.5.0', '1.4.0', '1.3.0', '1.2.0', '1.1.0'].map(v =>
      section(v),
    )

    const result = await writeChangelog({
      root,
      dryRun: false,
      keep: 2,
      releases,
    })
    expect(result.detail).toContain('2 releases of 5')

    const text = await Bun.file(`${root}/CHANGELOG.md`).text()
    expect(text).toContain('## [1.5.0]')
    expect(text).toContain('## [1.4.0]')
    expect(text).not.toContain('## [1.3.0]')
    // A truncation nobody explained is indistinguishable from history lost to
    // a bad merge.
    expect(text).toContain('Older releases')
  })

  test('a release with no user-facing commits keeps its heading', async () => {
    // Dropping it would leave a gap in the version sequence, which a reader
    // takes for a mistake rather than for a quiet release.
    const root = await fixture({})
    await writeChangelog({
      root,
      dryRun: false,
      keep: null,
      releases: [section('1.3.0', '_No user-facing changes._')],
    })

    const text = await Bun.file(`${root}/CHANGELOG.md`).text()
    expect(text).toContain('## [1.3.0]')
    expect(text).toContain('_No user-facing changes._')
  })

  test('a dry run reports what it would write and writes nothing', async () => {
    const root = await fixture({ 'CHANGELOG.md': 'untouched\n' })
    expect(
      await writeChangelog({
        root,
        dryRun: true,
        keep: null,
        releases: [section('1.3.0')],
      }),
    ).toMatchObject({ state: 'updated' })
    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toBe('untouched\n')
  })
})

describe('text helpers', () => {
  test('detectEol treats any CRLF as CRLF', () => {
    expect(detectEol('a\nb\n')).toBe('\n')
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n')
    expect(detectEol('a\r\nb\n')).toBe('\r\n')
    expect(detectEol('no endings at all')).toBe('\n')
  })

  test('withEol re-lines without doubling an existing \\r', () => {
    expect(withEol('a\nb', '\r\n')).toBe('a\r\nb')
    expect(withEol('a\r\nb', '\r\n')).toBe('a\r\nb')
    expect(withEol('a\r\nb', '\n')).toBe('a\nb')
  })

  test('detectIndent reads the file rather than assuming two spaces', () => {
    expect(detectIndent('{\n  "a": 1\n}')).toBe(2)
    expect(detectIndent('{\n    "a": 1\n}')).toBe(4)
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t')
    expect(detectIndent('{}')).toBe(2)
  })
})
