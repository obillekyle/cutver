import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { compileReleases } from './compile'
import { write } from '../runtime'

/**
 * Which releases get a heading, and which are folded into the next one.
 *
 * **`prereleases: false` has to mean the same thing at every moment.** The tag
 * filter and the release being cut are two separate paths to the same list,
 * and only one of them used to be filtered — so a beta got a heading when it
 * was cut and lost it on the next regeneration, when the same version arrived
 * as a tag. Its span made it worse than cosmetic: a pending prerelease
 * measures from the last *stable* tag, so it listed every commit the eventual
 * stable release would list again.
 */
const SECTIONS = ['breaking', 'feat', 'fix', 'perf', 'refactor', 'docs']
const roots: string[] = []

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A repository with one stable tag, one prerelease tag, and a commit since. */
async function repo(): Promise<string> {
  const dir = mkdtempSync(`${tmpdir()}/cutver-compile-`).replaceAll('\\', '/')
  roots.push(dir)

  const git = (...args: string[]) =>
    Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      .exited

  await git('init', '-q')
  await git('config', 'user.email', 'a@b.c')
  await git('config', 'user.name', 't')

  await write(`${dir}/a.txt`, '1')
  await git('add', '-A')
  await git('commit', '-qm', 'feat: the first thing')
  await git('tag', 'v1.0.0')

  await write(`${dir}/b.txt`, '2')
  await git('add', '-A')
  await git('commit', '-qm', 'fix: something in the beta')
  await git('tag', 'v1.1.0-beta.1')

  await write(`${dir}/c.txt`, '3')
  await git('add', '-A')
  await git('commit', '-qm', 'fix: something after it')
  return dir
}

describe('compileReleases with prereleases off', () => {
  test('a prerelease tag gets no heading', async () => {
    const found = await compileReleases(await repo(), null, SECTIONS, false)
    expect(found.map(r => r.version)).toEqual(['1.0.0'])
  })

  test('the prerelease being cut gets no heading either', async () => {
    // The half that was missing. Regenerating filtered the tag; cutting the
    // same version did not, so the entry existed only between one release and
    // the next regeneration.
    const found = await compileReleases(
      await repo(),
      { version: '1.1.0-beta.2', date: '2026-08-17' },
      SECTIONS,
      false,
    )

    expect(found.map(r => r.version)).toEqual(['1.0.0'])
  })

  test('a stable release being cut still gets one', async () => {
    const found = await compileReleases(
      await repo(),
      { version: '1.1.0', date: '2026-08-17' },
      SECTIONS,
      false,
    )

    expect(found.map(r => r.version)).toEqual(['1.1.0', '1.0.0'])
  })

  test('the stable release absorbs the beta series', async () => {
    // Dropping the headings alone would delete those commits from the file.
    // The span widens instead, so the fix made during the beta is listed under
    // the stable version that shipped it.
    const found = await compileReleases(
      await repo(),
      { version: '1.1.0', date: '2026-08-17' },
      SECTIONS,
      false,
    )
    const body = found[0]?.notes ?? ''

    expect(body).toContain('something in the beta')
    expect(body).toContain('something after it')
  })
})

describe('compileReleases with prereleases on', () => {
  test('both the tag and the pending prerelease get headings', async () => {
    const found = await compileReleases(
      await repo(),
      { version: '1.1.0-beta.2', date: '2026-08-17' },
      SECTIONS,
      true,
    )

    expect(found.map(r => r.version)).toEqual([
      '1.1.0-beta.2',
      '1.1.0-beta.1',
      '1.0.0',
    ])
  })
})
