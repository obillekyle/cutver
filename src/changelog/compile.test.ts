import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { compileReleases, sectionOrCompile } from './compile'
import { write } from '../runtime'

/**
 * A git identity for every fixture here.
 *
 * **Passed to each spawn, not assigned to `process.env`.** `Bun.spawn`
 * snapshots the environment at startup and does not see later mutations —
 * measured — while `node:child_process` does. Assigning to `process.env`
 * therefore worked in the files that spawn through `run()` and silently did
 * nothing here: it passed locally, where this machine has a global git
 * identity to fall back on, and failed on CI, which has none.
 *
 * The commits never landed and nothing said so — the fixtures ignored every
 * exit code, so an empty history arrived at the assertions as "no user-facing
 * changes". `git()` throws now, which is the half that made this expensive.
 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}

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

  const git = async (...args: string[]) => {
    const p = Bun.spawn(['git', ...args], {
      cwd: dir,
      env: GIT_ENV,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await p.exited
    if (code !== 0) {
      const why = (await new Response(p.stderr).text()).trim()
      throw new Error(`git ${args.join(' ')} exited ${code}: ${why}`)
    }
  }

  await git('init', '-q')

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

/**
 * What a release measures from, when the changelog has no section for it.
 *
 * `sectionOrCompile` falls back to compiling a tag's own range, and that range
 * used to start at the neighbour by `creatordate` whatever channel it belonged
 * to. Promoting a channel is where it fell over.
 */
describe('the range a tag compiles from', () => {
  /** A repository, built commit by commit, so each fixture states its history. */
  async function build(
    steps: [subject: string, tag?: string][],
    branches?: (git: (...a: string[]) => Promise<void>) => Promise<void>,
  ): Promise<{ dir: string; git: (...a: string[]) => Promise<void> }> {
    const dir = mkdtempSync(`${tmpdir()}/cutver-span-`).replaceAll('\\', '/')
    roots.push(dir)

    const git = async (...args: string[]) => {
      const p = Bun.spawn(['git', ...args], {
        cwd: dir,
        env: GIT_ENV,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if ((await p.exited) !== 0) {
        throw new Error(
          `git ${args.join(' ')}: ${await new Response(p.stderr).text()}`,
        )
      }
    }

    await git('init', '-q', '-b', 'main')
    await write(`${dir}/package.json`, '{"name":"p","version":"0.0.0"}')

    for (const [subject, tag] of steps) {
      await write(`${dir}/f.txt`, subject)
      await git('add', '-A')
      await git('commit', '-qm', subject)
      if (tag) await git('tag', tag)
    }

    if (branches) await branches(git)
    return { dir, git }
  }

  const config = { changelog: { sections: SECTIONS } } as never

  test('a stable release measures from the last stable, not the last alpha', async () => {
    // The reported bug. An alpha is cut on its own branch, merged to main, and
    // the stable cut after it — so by date the tag before 1.0.0 is the alpha,
    // and the range collapsed to whatever landed after the merge.
    const { dir, git } = await build([['feat: base', 'v0.7.0']])

    await git('checkout', '-qb', 'alpha')
    for (const s of ['feat(a): first alpha', 'fix(b): alpha fix']) {
      await write(`${dir}/f.txt`, s)
      await git('add', '-A')
      await git('commit', '-qm', s)
    }
    await git('tag', 'v1.0.0-alpha.0')

    await git('checkout', '-q', 'main')
    await git('merge', '-q', '--no-ff', '-m', 'Merge alpha', 'alpha')
    await write(`${dir}/z.txt`, 'z')
    await git('add', '-A')
    await git('commit', '-qm', 'fix(d): after the merge')
    await git('tag', 'v1.0.0')

    const notes = await sectionOrCompile(dir, 'v1.0.0', config)

    // Everything the stable ships, including what the alpha shipped first.
    expect(notes).toContain('first alpha')
    expect(notes).toContain('alpha fix')
    expect(notes).toContain('after the merge')
  })

  test('a prerelease measures from the last tag in its own channel', async () => {
    // A beta cut between two alphas must not truncate the second alpha.
    const { dir } = await build([
      ['feat: base', 'v1.0.0'],
      ['feat(one): first', 'v1.1.0-alpha.0'],
      ['feat(two): a beta thing', 'v1.1.0-beta.0'],
      ['feat(three): back on alpha', 'v1.1.0-alpha.1'],
    ])

    const notes = await sectionOrCompile(dir, 'v1.1.0-alpha.1', config)

    expect(notes).toContain('back on alpha')
    // Between the two alphas, so it belongs to this range.
    expect(notes).toContain('a beta thing')
    // Before the previous alpha, so it does not.
    expect(notes).not.toContain('first')
  })

  test('the first release of a channel falls back to whatever came last', async () => {
    const { dir } = await build([
      ['feat: base', 'v1.0.0'],
      ['feat(one): after the stable', 'v1.1.0-alpha.0'],
    ])

    const notes = await sectionOrCompile(dir, 'v1.1.0-alpha.0', config)
    expect(notes).toContain('after the stable')
    expect(notes).not.toContain('base')
  })

  test('the first release of all measures from the root commit', async () => {
    // Two commits, because `root..tag` excludes the root itself — a repository
    // whose only commit carries the tag has an empty range by definition.
    const { dir } = await build([
      ['chore: repository created'],
      ['feat: the very first thing', 'v0.1.0'],
    ])

    const notes = await sectionOrCompile(dir, 'v0.1.0', config)
    expect(notes).toContain('the very first thing')
  })
})
