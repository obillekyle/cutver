import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { compileReleases, sectionOrCompile } from './compile'
import { shortSha } from '../git'
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
  /**
   * A repository, built commit by commit, so each fixture states its history.
   *
   * **A step can carry a date, and a fixture about order needs one.** Tags made
   * in the same day are ordered by version, not by when they were cut (see
   * `releaseTags`), so in an undated fixture a 1.0.1 cut after a 2.0.0 alpha
   * still sorts below it, and a test of "released after" passes whatever the
   * code does. Measured: a variant that finished a line at any stable cut after
   * its last alpha passed all sixteen tests here until the fixture was dated.
   */
  async function build(
    steps: [subject: string, tag?: string, date?: string][],
    branches?: (git: (...a: string[]) => Promise<void>) => Promise<void>,
  ): Promise<{ dir: string; git: (...a: string[]) => Promise<void> }> {
    const dir = mkdtempSync(`${tmpdir()}/cutver-span-`).replaceAll('\\', '/')
    roots.push(dir)

    const spawn = async (env: typeof GIT_ENV, args: string[]) => {
      const p = Bun.spawn(['git', ...args], {
        cwd: dir,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if ((await p.exited) !== 0) {
        throw new Error(
          `git ${args.join(' ')}: ${await new Response(p.stderr).text()}`,
        )
      }
    }
    const git = (...args: string[]) => spawn(GIT_ENV, args)

    await git('init', '-q', '-b', 'main')
    await write(`${dir}/package.json`, '{"name":"p","version":"0.0.0"}')

    for (const [subject, tag, date] of steps) {
      // A lightweight tag is dated by its commit, so dating the commit dates
      // the tag.
      const env = date
        ? { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
        : GIT_ENV
      await write(`${dir}/f.txt`, subject)
      await spawn(env, ['add', '-A'])
      await spawn(env, ['commit', '-qm', subject])
      if (tag) await spawn(env, ['tag', tag])
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

  /**
   * **A channel holds many lines, and a finished one is not the previous
   * release.** bakery's first 2.5.0 alpha measured from v2.0.0-alpha.17, the
   * last alpha in its history, and its page listed 85 commits where 5 were new
   * since v2.4.1. The three tests after this one are its controls: where the
   * line ends, and that an open one still counts.
   */
  test('the first alpha of a new line measures from the stable, not a finished line', async () => {
    const { dir } = await build([
      ['feat: base', 'v1.0.0'],
      ['feat(one): the 2.0 work', 'v2.0.0-alpha.0'],
      ['fix(one): an alpha repair', 'v2.0.0-alpha.1'],
      ['fix(two): shipped in 2.0', 'v2.0.0'],
      ['feat(three): shipped in 2.1', 'v2.1.0'],
      ['fix(four): new on the 2.2 line', 'v2.2.0-alpha.0'],
    ])

    const notes = await sectionOrCompile(dir, 'v2.2.0-alpha.0', config)

    expect(notes).toContain('new on the 2.2 line')
    // Each of these shipped in a stable release already in this history.
    expect(notes).not.toContain('shipped in 2.1')
    expect(notes).not.toContain('shipped in 2.0')
    expect(notes).not.toContain('an alpha repair')
  })

  test('a line is finished by the stable release it graduated to', async () => {
    // The boundary: equal finishes it, so 2.0.0 itself ends the 2.0.0 alphas.
    const { dir } = await build([
      ['feat: base', 'v1.0.0'],
      ['feat(one): the 2.0 work', 'v2.0.0-alpha.0'],
      ['fix(two): finishing 2.0', 'v2.0.0'],
      ['feat(three): the 2.1 line', 'v2.1.0-alpha.0'],
    ])

    const notes = await sectionOrCompile(dir, 'v2.1.0-alpha.0', config)

    expect(notes).toContain('the 2.1 line')
    expect(notes).not.toContain('finishing 2.0')
  })

  test('a stable below the line does not finish it', async () => {
    // A maintenance release on the old major, cut between two alphas, leaves
    // the alpha line open: the second alpha still measures from the first, and
    // the repair is in its range because it landed between them. Dated a day
    // apart, so 1.0.1 is the newer tag of the two below the second alpha.
    const { dir } = await build([
      ['feat: base', 'v1.0.0', '2026-01-01T12:00:00Z'],
      ['feat(one): first alpha', 'v2.0.0-alpha.0', '2026-01-02T12:00:00Z'],
      ['fix(two): a 1.x repair', 'v1.0.1', '2026-01-03T12:00:00Z'],
      ['feat(three): second alpha', 'v2.0.0-alpha.1', '2026-01-04T12:00:00Z'],
    ])

    const notes = await sectionOrCompile(dir, 'v2.0.0-alpha.1', config)

    expect(notes).toContain('second alpha')
    expect(notes).toContain('a 1.x repair')
    expect(notes).not.toContain('first alpha')
  })

  test('an open line still counts when the next alpha is for a higher version', async () => {
    // A breaking change mid-line moves the next alpha from 2.5.0 to 3.0.0. No
    // stable has reached 2.5.0, so that line is open, and its last alpha is
    // what this channel released before. The beta between them is what tells
    // this apart from counting only the alpha's own line, which would find no
    // 3.0.0 alpha and start at the beta instead.
    const { dir } = await build([
      ['feat: base', 'v2.4.1'],
      ['feat(one): in the 2.5 alphas', 'v2.5.0-alpha.0'],
      ['feat(two): a beta thing', 'v2.5.0-beta.0'],
      ['feat(three)!: breaks it', 'v3.0.0-alpha.0'],
    ])

    const notes = await sectionOrCompile(dir, 'v3.0.0-alpha.0', config)

    expect(notes).toContain('breaks it')
    expect(notes).toContain('a beta thing')
    expect(notes).not.toContain('in the 2.5 alphas')
  })

  /**
   * **The root commit belongs to its own release.**
   *
   * This test used to build two commits and explain the second away: "`root..tag`
   * excludes the root itself — a repository whose only commit carries the tag
   * has an empty range by definition." That is a true statement about `A..B`
   * and a false conclusion about releases, and writing it here is what kept the
   * bug alive — the fixture was shaped around the defect until it passed, so
   * every run confirmed the workaround rather than the behaviour.
   *
   * A first release has no lower bound. `AlloyFS/http` — five commits, one
   * `feat:`, and it is the root — is the shape that exposed it.
   */
  test('an annotated tag names its commit, not itself', async () => {
    // Every compare link was built from `rev-parse <tag>`, which for an
    // annotated tag is the tag object, and GitHub's compare 404s on those:
    // 33 of 33 on bakery's pages. Lightweight tags, which every other fixture
    // here uses, hid it.
    const { dir, git } = await build([['feat: first'], ['fix: second']])
    await git('tag', '-a', 'v1.0.0', '-m', 'v1.0.0', 'HEAD~1')
    await git('tag', '-a', 'v1.1.0', '-m', 'v1.1.0')

    const read = async (...args: string[]) => {
      const p = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe' })
      return (await new Response(p.stdout).text()).trim()
    }
    const commit = await read('rev-parse', '--short', 'v1.1.0^{commit}')
    const object = await read('rev-parse', '--short', 'v1.1.0')
    expect(object).not.toBe(commit)

    expect(await shortSha('v1.1.0', dir)).toBe(commit)
    // And a plain commit or HEAD is unchanged by the peel.
    expect(await shortSha('HEAD', dir)).toBe(commit)
  })

  test('the first release of all contains its root commit', async () => {
    const { dir } = await build([['feat: the very first thing', 'v0.1.0']])

    const notes = await sectionOrCompile(dir, 'v0.1.0', config)
    expect(notes).toContain('the very first thing')
  })

  test('a root commit that is user-facing is not dropped from it', async () => {
    const { dir } = await build([
      ['feat: the thing itself', 'v0.1.0'],
      ['feat: everything after', 'v0.2.0'],
    ])

    const notes = await sectionOrCompile(dir, 'v0.1.0', config)
    expect(notes).toContain('the thing itself')
    // The release after it is unaffected — an open span is only the first one.
    const next = await sectionOrCompile(dir, 'v0.2.0', config)
    expect(next).toContain('everything after')
    expect(next).not.toContain('the thing itself')
  })

  test('the oldest section of CHANGELOG.md contains it too', async () => {
    // The same defect, in the other path. `compileReleases` reached for the
    // root commit as the oldest span's start, so the file dropped it as well —
    // and `notes` was the only half anyone reported.
    const { dir } = await build([
      ['feat: the thing itself', 'v0.1.0'],
      ['fix: a later repair', 'v0.2.0'],
    ])

    const found = await compileReleases(dir, null, SECTIONS, false)
    const oldest = found.find(r => r.version === '0.1.0')

    expect(oldest?.notes).toContain('the thing itself')
  })
})
