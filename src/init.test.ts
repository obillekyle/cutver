import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ECOSYSTEMS, init, initFiles, type Ecosystem } from './init'

const made: string[] = []

afterEach(async () => {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true })
})

async function fixture(files: Record<string, string> = {}): Promise<string> {
  const dir = (await mkdtemp(`${tmpdir()}/cutver-init-`)).replaceAll('\\', '/')
  made.push(dir)
  for (const [rel, body] of Object.entries(files)) await Bun.write(`${dir}/${rel}`, body)
  return dir
}

describe('the generated workflows', () => {
  test('are valid YAML with the jobs and triggers they claim', async () => {
    // Generated YAML is string concatenation, which is exactly the thing that
    // produces a file GitHub rejects while looking fine in a diff. Parsed here
    // for every ecosystem rather than eyeballed for one.
    for (const eco of ECOSYSTEMS) {
      for (const file of initFiles(eco)) {
        if (!file.path.endsWith('.yml')) continue
        const doc = Bun.YAML.parse(file.contents) as Record<string, any>
        expect(doc.name, `${eco} ${file.path}`).toBeString()
        expect(Object.keys(doc.jobs).length, `${eco} ${file.path}`).toBe(1)
      }
    }
  })

  test('keep the split: version tags, publish only ever fires on a tag', () => {
    for (const eco of ECOSYSTEMS) {
      const [version, publish] = initFiles(eco).map(f => Bun.YAML.parse(f.contents) as any)

      // The version workflow must never touch a registry, and the publish one
      // must not fire on a branch push. That is the entire safety model, and
      // it is one careless template edit away from being lost.
      expect(version.on.push.branches, eco).toContain('main')
      expect(version.on.push.tags, eco).toBeUndefined()
      expect(publish.on.push.tags, eco).toEqual(['v*'])
      expect(publish.on.push.branches, eco).toBeUndefined()
      expect(publish.on.workflow_dispatch, eco).toBeTruthy()
    }
  })

  test('the version job can dispatch the publish one', () => {
    // A tag pushed with the default GITHUB_TOKEN cannot start a workflow, so
    // without `actions: write` and the explicit dispatch the tag lands and
    // nothing publishes — silently.
    for (const eco of ECOSYSTEMS) {
      const version = Bun.YAML.parse(initFiles(eco)[0]?.contents as string) as any
      expect(version.permissions.actions, eco).toBe('write')
      expect(JSON.stringify(version.jobs), eco).toContain('gh workflow run publish.yml')
    }
  })

  test('npm publishes ask for an OIDC token; cargo does not', () => {
    const npm = Bun.YAML.parse(initFiles('bun')[1]?.contents as string) as any
    expect(npm.permissions['id-token']).toBe('write')

    const cargo = Bun.YAML.parse(initFiles('cargo')[1]?.contents as string) as any
    expect(cargo.permissions['id-token']).toBeUndefined()
    expect(JSON.stringify(cargo.jobs)).toContain('cargo publish')
  })

  test('a prerelease never publishes without a dist-tag', () => {
    // npm's default makes it `latest`, silently, and every plain install in
    // the world then resolves to a beta.
    for (const eco of ['bun', 'node'] as const) {
      const publish = JSON.stringify(Bun.YAML.parse(initFiles(eco)[1]?.contents as string))
      expect(publish, eco).toContain('--tag')
      expect(publish, eco).toContain('unrecognised prerelease')
    }
  })

  test('cargo fetches the executable instead of a JavaScript runtime', () => {
    const version = initFiles('cargo')[0]?.contents as string
    expect(version).toContain('releases/latest/download/cutver-linux-x64')
    expect(version).not.toContain('setup-bun')
    expect(version).not.toContain('setup-node')
  })
})

describe('init', () => {
  test('writes both workflows and a changelog into an empty tree', async () => {
    const root = await fixture()
    const results = await init(root, 'bun')

    expect(results.every(r => r.state === 'written')).toBe(true)
    expect(await Bun.file(`${root}/.github/workflows/version.yml`).exists()).toBe(true)
    expect(await Bun.file(`${root}/.github/workflows/publish.yml`).exists()).toBe(true)
    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toContain('## [Unreleased]')
  })

  test('refuses to clobber a workflow someone has been editing', async () => {
    const root = await fixture({ '.github/workflows/version.yml': 'name: mine\n' })
    const results = await init(root, 'node')

    expect(results.find(r => r.path.endsWith('version.yml'))?.state).toBe('skipped')
    expect(await Bun.file(`${root}/.github/workflows/version.yml`).text()).toBe('name: mine\n')
    // The other file is still written: a partial adoption is the normal case.
    expect(results.find(r => r.path.endsWith('publish.yml'))?.state).toBe('written')
  })

  test('--force replaces a workflow but never a changelog', async () => {
    // A changelog holds prose someone wrote. Nothing here is entitled to
    // overwrite that, flag or no flag.
    const root = await fixture({
      '.github/workflows/version.yml': 'name: mine\n',
      'CHANGELOG.md': '# mine\n\n## [Unreleased]\n\n- real notes\n',
    })
    const results = await init(root, 'cargo', { force: true })

    expect(results.find(r => r.path.endsWith('version.yml'))?.state).toBe('written')
    expect(await Bun.file(`${root}/.github/workflows/version.yml`).text()).toContain('cargo test')
    expect(results.find(r => r.path === 'CHANGELOG.md')?.state).toBe('skipped')
    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toContain('- real notes')
  })

  test('a dry run reports the same thing and writes none of it', async () => {
    const root = await fixture()
    const results = await init(root, 'bun', { dryRun: true })

    expect(results.every(r => r.state === 'written')).toBe(true)
    expect(await Bun.file(`${root}/.github/workflows/version.yml`).exists()).toBe(false)
  })

  test('every ecosystem produces the same three files', async () => {
    for (const eco of ECOSYSTEMS as readonly Ecosystem[]) {
      const root = await fixture()
      expect((await init(root, eco)).map(r => r.path)).toEqual([
        '.github/workflows/version.yml',
        '.github/workflows/publish.yml',
        'CHANGELOG.md',
      ])
    }
  })
})
