import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { buildVersions, VERSIONS_FILE, writeVersions } from './versions'
import { write } from './runtime'

const made: string[] = []

afterEach(async () => {
  while (made.length)
    await rm(made.pop() as string, { recursive: true, force: true })
})

async function repo(existing?: string): Promise<string> {
  const dir = (await mkdtemp(`${tmpdir()}/cutver-versions-`)).replaceAll(
    '\\',
    '/',
  )
  made.push(dir)
  if (existing !== undefined) await write(`${dir}/${VERSIONS_FILE}`, existing)
  return dir
}

describe('buildVersions', () => {
  test('newest first, with a prerelease under the release it precedes', () => {
    // **The ordering `sort -V` and `git --sort=-v:refname` both get wrong.**
    // Both treat the `-beta.1` suffix as making the version larger, so
    // `1.0.0-beta.1` sorts above `1.0.0` — which is exactly backwards, and is
    // why this does not shell out for the list.
    const doc = buildVersions([
      '1.0.0',
      '1.0.0-beta.1',
      '0.9.0',
      '1.0.0-beta.2',
    ])

    expect(doc.versions).toEqual([
      '1.0.0',
      '1.0.0-beta.2',
      '1.0.0-beta.1',
      '0.9.0',
    ])
    expect(doc.latest).toBe('1.0.0')
  })

  test('the counter is numeric, not lexical', () => {
    // `alpha.10` above `alpha.9`, which a string sort inverts — and a project
    // living entirely in prereleases hits this on its tenth one.
    const doc = buildVersions(['2.0.0-alpha.9', '2.0.0-alpha.10'])
    expect(doc.versions).toEqual(['2.0.0-alpha.10', '2.0.0-alpha.9'])
  })

  test('latest is the newest tag, prerelease or not', () => {
    // Not "the newest stable". A project on `2.0.0-alpha.9` should say so
    // rather than showing the release it left behind — the case npm's `latest`
    // gets wrong, being pinned on first publish whatever `--tag` said.
    expect(buildVersions(['2.0.0-alpha.9', '1.4.0']).latest).toBe(
      '2.0.0-alpha.9',
    )
  })

  test('the version being cut is included once, tag or no tag', () => {
    // Its tag does not exist yet when this runs, and on a re-run it does.
    expect(buildVersions(['1.0.0'], '1.1.0').versions).toEqual([
      '1.1.0',
      '1.0.0',
    ])
    expect(buildVersions(['1.1.0', '1.0.0'], '1.1.0').versions).toEqual([
      '1.1.0',
      '1.0.0',
    ])
  })

  test('no tags at all is a shape, not a crash', () => {
    expect(buildVersions([])).toEqual({ latest: null, versions: [] })
  })
})

describe('writeVersions', () => {
  test('a repository without the file is left alone', async () => {
    // **The file's presence is the opt-in.** No config key, so `init` has
    // nothing to scaffold and `drift` has nothing to check — and a repository
    // that never wanted this never learns it exists.
    const root = await repo()
    expect(await writeVersions({ root, version: '1.0.0' })).toBeNull()
  })

  test('an existing file is brought up to date', async () => {
    const root = await repo('[]\n')
    const change = await writeVersions({ root, version: '1.0.0' })

    expect(change).toMatchObject({ file: VERSIONS_FILE, state: 'updated' })
    const doc = await Bun.file(`${root}/${VERSIONS_FILE}`).json()
    // No git repository here, so the tag list is empty and the version being
    // cut is the whole of it — which is the first-release shape.
    expect(doc).toEqual({ latest: '1.0.0', versions: ['1.0.0'] })
  })

  test('a run that changes nothing says so', async () => {
    const root = await repo('[]\n')
    await writeVersions({ root, version: '1.0.0' })
    const again = await writeVersions({ root, version: '1.0.0' })
    expect(again).toMatchObject({ state: 'unchanged' })
  })

  test('a dry run reports the change and writes none of it', async () => {
    const root = await repo('[]\n')
    const change = await writeVersions({
      root,
      version: '1.0.0',
      dryRun: true,
    })

    expect(change).toMatchObject({ state: 'updated' })
    expect(await Bun.file(`${root}/${VERSIONS_FILE}`).text()).toBe('[]\n')
  })
})
