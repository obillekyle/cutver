import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ECOSYSTEMS, init, initFiles, pinFor, type Ecosystem } from './init'
import { run } from './run'

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
        // `cutver.yml` is a config file, not a workflow — match on the path.
        if (!file.path.startsWith('.github/workflows/')) continue
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
      // Both branch shapes, and the bare names are the ones easily lost:
      // `*-beta` does not match `beta`, so omitting them leaves a release
      // branch that silently never fires.
      expect(version.on.push.branches, eco).toContain('*-beta')
      expect(version.on.push.branches, eco).toContain('beta')
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
    const results = await init(root, 'bun', { hook: false })

    expect(await Bun.file(`${root}/.github/workflows/version.yml`).exists()).toBe(true)
    expect(await Bun.file(`${root}/.github/workflows/publish.yml`).exists()).toBe(true)
    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toContain('## [Unreleased]')
    expect(results.filter(r => r.path.endsWith('.yml')).every(r => r.state === 'written')).toBe(
      true,
    )
  })

  test('refuses to clobber a workflow someone has been editing', async () => {
    const root = await fixture({ '.github/workflows/version.yml': 'name: mine\n' })
    const results = await init(root, 'node', { hook: false })

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
    const results = await init(root, 'cargo', { force: true, hook: false })

    expect(results.find(r => r.path.endsWith('version.yml'))?.state).toBe('written')
    expect(await Bun.file(`${root}/.github/workflows/version.yml`).text()).toContain('cargo test')
    expect(results.find(r => r.path === 'CHANGELOG.md')?.state).toBe('skipped')
    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toContain('- real notes')
  })

  test('a dry run reports the same thing and writes none of it', async () => {
    const root = await fixture()
    const results = await init(root, 'bun', { dryRun: true, hook: false })

    expect(results.filter(r => r.path.endsWith('.yml')).every(r => r.state === 'written')).toBe(
      true,
    )
    expect(await Bun.file(`${root}/.github/workflows/version.yml`).exists()).toBe(false)
  })

  test('every ecosystem produces the same files', async () => {
    for (const eco of ECOSYSTEMS as readonly Ecosystem[]) {
      const root = await fixture()
      expect(
        (await init(root, eco, { hook: false })).map(r => r.path).filter(p => p !== 'package.json'),
      ).toEqual([
        '.github/workflows/version.yml',
        '.github/workflows/publish.yml',
        'CHANGELOG.md',
        'cutver.yml',
      ])
    }
  })

  test('the scaffolded config is never overwritten, even with --force', async () => {
    // A config already in the tree is the repository's release policy.
    // Replacing it would change version numbers with no commit to blame.
    const root = await fixture({ 'cutver.yml': 'schema: 1\nchannels:\n  beta: [mine]\n' })
    const results = await init(root, 'bun', { hook: false, force: true })

    expect(results.find(r => r.path === 'cutver.yml')?.state).toBe('skipped')
    expect(await Bun.file(`${root}/cutver.yml`).text()).toContain('mine')
  })
})

describe('what init sets up beyond the files', () => {
  const manifest = (o: unknown) => ({ 'package.json': `${JSON.stringify(o, null, 2)}\n` })

  test('pins cutver, so the tool that picks your versions does not float', async () => {
    // Without a pin both the workflow and the hook reach for `bunx cutver`,
    // which resolves `latest` on every run — so a cutver release could change
    // this repository's version numbers with no commit in it.
    const root = await fixture(manifest({ name: 'demo', version: '1.0.0' }))
    const results = await init(root, 'bun', { hook: false, version: '1.4.2' })

    expect(results.find(r => r.path === 'package.json')).toMatchObject({ state: 'written' })
    const json = JSON.parse(await Bun.file(`${root}/package.json`).text())
    expect(json.devDependencies).toEqual({ cutver: '^1.4.2' })
  })

  test('a prerelease pins exactly rather than with a caret', async () => {
    // `^0.1.0-beta.6` reads as a range and behaves as a pin — it matches only
    // later prereleases of that same 0.1.0. Being explicit beats being subtly
    // narrow.
    expect(pinFor('0.1.0-beta.6')).toBe('0.1.0-beta.6')
    expect(pinFor('1.4.2')).toBe('^1.4.2')
  })

  test('never overwrites a range someone already chose', async () => {
    const root = await fixture(
      manifest({ name: 'demo', version: '1.0.0', devDependencies: { cutver: '0.9.0' } }),
    )
    await init(root, 'bun', { hook: false, version: '1.4.2' })

    const json = JSON.parse(await Bun.file(`${root}/package.json`).text())
    expect(json.devDependencies.cutver).toBe('0.9.0')
  })

  test('running from source pins nothing, and says so', async () => {
    const root = await fixture(manifest({ name: 'demo', version: '1.0.0' }))
    const results = await init(root, 'bun', { hook: false, version: 'dev' })

    expect(results.find(r => r.path === 'package.json')).toMatchObject({ state: 'skipped' })
    expect(JSON.parse(await Bun.file(`${root}/package.json`).text()).devDependencies).toBeUndefined()
  })

  test('cargo gets no devDependency — there is no manifest to put one in', async () => {
    const root = await fixture()
    const results = await init(root, 'cargo', { hook: false, version: '1.4.2' })
    expect(results.find(r => r.path === 'package.json')).toBeUndefined()
  })

  test('installs the pre-push guard by default, and skips it on request', async () => {
    const root = await fixture()
    await run(['git', 'init', '-q', '-b', 'main'], root)

    expect((await init(root, 'cargo')).find(r => r.path.includes('pre-push'))).toMatchObject({
      state: 'written',
    })
    expect(await Bun.file(`${root}/.git/hooks/pre-push`).exists()).toBe(true)

    const other = await fixture()
    await run(['git', 'init', '-q', '-b', 'main'], other)
    await init(other, 'cargo', { hook: false })
    expect(await Bun.file(`${other}/.git/hooks/pre-push`).exists()).toBe(false)
  })
})
