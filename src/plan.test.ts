import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { plan } from './plan'
import { run } from './run'

const made: string[] = []

afterEach(async () => {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true })
})

/**
 * A throwaway repository with a real history.
 *
 * Real git rather than a stubbed log, because the thing under test is
 * partly *which* commits git is asked for — the range, the tag filter, the
 * `--merged HEAD`. A fake log would agree with whatever the code asked for.
 *
 * `entries` are `subject` or `subject@tag`: the tag is applied after that
 * commit lands.
 */
async function repo(entries: string[]): Promise<string> {
  const dir = (await mkdtemp(`${tmpdir()}/cutver-plan-`)).replaceAll('\\', '/')
  made.push(dir)

  await run(['git', 'init', '-q', '-b', 'main'], dir)
  // Local to the fixture. CI runners have no identity configured and `git
  // commit` refuses without one.
  await run(['git', 'config', 'user.email', 'fixture@example.invalid'], dir)
  await run(['git', 'config', 'user.name', 'fixture'], dir)

  for (const [i, entry] of entries.entries()) {
    const [subject = '', tag] = entry.split('@')
    await Bun.write(`${dir}/f${i}.txt`, `${i}\n`)
    await run(['git', 'add', '-A'], dir)
    await run(['git', 'commit', '-q', '-m', subject], dir)
    if (tag) await run(['git', 'tag', tag], dir)
  }

  return dir
}

const at = (root: string, current: string, branch = 'main') =>
  plan({ root, current, branch, channel: null })

describe('with no tags at all', () => {
  test('measures from the manifest, not from 0.0.0', async () => {
    // **The deviation from the script this was extracted from, and why.** That
    // repository has been tagged since its first release, so its `0.0.0`
    // fallback never ran. Pointed at a repository with zero tags — which is
    // exactly the case this tool was extracted to serve — `0.0.0` computes
    // `0.1.0` for a minor: the version the manifest already says, so the tool
    // reports "nothing to release" across the entire history.
    const root = await repo(['chore: init', 'feat: sync engine', 'fix: a race'])
    expect(await at(root, '0.1.0')).toMatchObject({ kind: 'release', version: '0.2.0' })
  })

  test('a patch does not go backwards', async () => {
    // The same fallback in its uglier direction: from 0.0.0 a patch computes
    // 0.0.1, which is *lower* than the version in the manifest and which the
    // semver check would happily accept.
    const root = await repo(['chore: init', 'fix: a race'])
    expect(await at(root, '0.1.0')).toMatchObject({ kind: 'release', version: '0.1.1' })
  })

  test('reports the range it measured as the first commit', async () => {
    const root = await repo(['feat: one', 'feat: two'])
    const p = await at(root, '1.0.0')
    expect(p.survey).toMatchObject({ since: 'the first commit', total: 2 })
  })
})

describe('with a stable tag', () => {
  test('measures from the tag, not from the manifest', async () => {
    const root = await repo(['feat: one@v1.0.0', 'fix: two'])
    expect(await at(root, '1.0.0')).toMatchObject({ kind: 'release', version: '1.0.1' })
  })

  test('ignores prerelease tags when choosing the baseline', async () => {
    // `git describe --abbrev=0` would hand back v1.1.0-beta.0 here, and
    // measuring the breaking commit from there ships it as a minor.
    const root = await repo([
      'feat: one@v1.0.0',
      'feat: two@v1.1.0-beta.0',
      'refactor!: rip out the old API',
    ])
    const p = await at(root, '1.1.0-beta.0')
    expect(p).toMatchObject({ kind: 'release', version: '2.0.0' })
    expect(p.survey?.since).toBe('v1.0.0')
  })

  test('nothing to release when the range holds only housekeeping', async () => {
    const root = await repo(['feat: one@v1.0.0', 'docs: notes', 'chore: tidy'])
    expect(await at(root, '1.0.0')).toMatchObject({ kind: 'nothing' })
  })

  test('nothing to release when the computed version is the one already written', async () => {
    // The CI race this guards: a bump commit is itself a push, so the workflow
    // re-triggers, recomputes the same number from the same commits, and would
    // otherwise "release" a version that is already in the manifests — then
    // fail trying to create a tag that exists. Guarding on the version rather
    // than on a clean tree also makes it immune to unrelated dirt, which is
    // what CI was really tripping over.
    const root = await repo(['feat: one@v1.0.0', 'feat: two'])
    expect(await at(root, '1.1.0')).toMatchObject({
      kind: 'nothing',
      why: '1.1.0 is already the current version',
    })
  })
})

describe('branch-declared versions', () => {
  test('a release branch names the base and the channel', async () => {
    const root = await repo(['feat: one@v1.0.0', 'feat: two'])
    expect(await at(root, '1.0.0', '1.1.0-beta')).toMatchObject({
      kind: 'release',
      version: '1.1.0-beta.0',
    })
  })

  test('the counter continues from the manifest, not from the branch name', async () => {
    const root = await repo(['feat: one@v1.0.0', 'feat: two'])
    expect(await at(root, '1.1.0-beta.2', '1.1.0-beta')).toMatchObject({
      version: '1.1.0-beta.3',
    })
  })

  test('refuses when the commits imply a higher base than the branch declares', async () => {
    // Publishing 1.1.0 here would ship a breaking change as a minor. A warning
    // would scroll past in a CI log and the wrong version would go out anyway.
    const root = await repo(['feat: one@v1.0.0', 'feat!: the world moved'])
    expect(at(root, '1.1.0-beta.0', '1.1.0-beta')).rejects.toThrow(/declares 1\.1\.0.*2\.0\.0/s)
  })
})

describe('an explicit version', () => {
  test('wins over the computation, without consulting git', async () => {
    const root = await repo(['docs: nothing releasable'])
    expect(
      await plan({ root, current: '1.0.0', branch: 'main', channel: null, explicit: '3.0.0' }),
    ).toMatchObject({ kind: 'release', version: '3.0.0', why: 'given explicitly' })
  })

  test('except when it is the version already in the manifests', async () => {
    const root = await repo(['feat: one'])
    expect(
      await plan({ root, current: '1.0.0', branch: 'main', channel: null, explicit: '1.0.0' }),
    ).toMatchObject({ kind: 'nothing' })
  })
})
