import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectCi,
  detectEcosystem,
  ECOSYSTEMS,
  init,
  initFiles,
  pinFor,
  type Ecosystem,
} from './index'
import {
  DEFAULT_CONFIG,
  producesArtifacts,
  publishesToRegistry,
  RELEASE,
} from '../config/schema'
import { parseConfig } from '../config/load'
import { run } from '../run'

const made: string[] = []

afterEach(async () => {
  while (made.length)
    await rm(made.pop() as string, { recursive: true, force: true })
})

async function fixture(files: Record<string, string> = {}): Promise<string> {
  const dir = (await mkdtemp(`${tmpdir()}/cutver-init-`)).replaceAll('\\', '/')
  made.push(dir)
  for (const [rel, body] of Object.entries(files))
    await Bun.write(`${dir}/${rel}`, body)
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
        expect(
          Object.keys(doc.jobs).length,
          `${eco} ${file.path}`,
        ).toBeGreaterThan(0)
      }
    }
  })

  test('keep the split: version tags, publish only ever fires on a tag', () => {
    for (const eco of ECOSYSTEMS) {
      const [version, publish] = initFiles(eco).map(
        f => Bun.YAML.parse(f.contents) as any,
      )

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
      const version = Bun.YAML.parse(
        initFiles(eco)[0]?.contents as string,
      ) as any
      expect(version.permissions.actions, eco).toBe('write')
      expect(JSON.stringify(version.jobs), eco).toContain(
        'gh workflow run publish.yml',
      )
    }
  })

  test('npm publishes ask for an OIDC token', () => {
    const npm = Bun.YAML.parse(initFiles('bun')[1]?.contents as string) as any
    expect(npm.permissions['id-token']).toBe('write')
    expect(JSON.stringify(npm.jobs)).toContain('npm publish')
  })

  test('a cargo tag builds executables rather than claiming ten crate names', () => {
    // The default that costs the least to be wrong about. `cargo publish`
    // **reserves the crate name permanently**, for every workspace member, and
    // a Rust workspace is far more often an application than a library — so a
    // generated file must not publish one as a side effect of wanting version
    // numbers. Opting in is a line of config; opting out afterwards is not
    // possible at all.
    const cargo = Bun.YAML.parse(
      initFiles('cargo')[1]?.contents as string,
    ) as any
    const jobs = JSON.stringify(cargo.jobs)

    expect(Object.keys(cargo.jobs)).toEqual(['artifacts', 'release'])
    expect(jobs).not.toContain('cargo publish')
    expect(jobs).not.toContain('CARGO_REGISTRY_TOKEN')
    expect(cargo.permissions['id-token']).toBeUndefined()

    // Discovered from cargo, never written down: a renamed binary must not
    // leave the workflow silently uploading nothing.
    expect(jobs).toContain('cargo metadata')
    expect(cargo.jobs.release.permissions.contents).toBe('write')
  })

  test('the collect step survives a Windows runner', () => {
    // `shell: bash` on Windows is Git Bash, where jq writes CRLF and `read -r`
    // keeps the carriage return. Without the strip, a crate whose binary is
    // `app` yields `app\r` and the copy fails with
    // `cannot stat 'target/release/app'$'\r''.exe'` while the file is right
    // there. Cost a real release a run, after the tag was already public.
    const cargo = initFiles('cargo')[1]?.contents as string
    const collect = cargo.slice(cargo.indexOf('Collect the binaries'))

    // **Presence before order.** `indexOf` answers -1 for something absent,
    // and -1 is less than every real position — so an ordering assertion passes
    // when the thing it is ordering simply is not there. Measured: deleting
    // `jq -r` from `init.ts` left all 26 tests in this file green.
    for (const needle of ['jq -r', "tr -d '\\r'", 'while read -r bin']) {
      expect(collect).toContain(needle)
    }
    // Order matters: after jq, before the loop that builds paths from it.
    expect(collect.indexOf('jq -r')).toBeLessThan(
      collect.indexOf("tr -d '\\r'"),
    )
    expect(collect.indexOf("tr -d '\\r'")).toBeLessThan(
      collect.indexOf('while read -r bin'),
    )
  })

  test('the release body is one call to cutver, not logic baked into the file', () => {
    // **The whole point of the subcommand.** Anything written into this file is
    // frozen at `init` time for every repository that already ran it, so an
    // improvement later would mean asking everyone to regenerate a workflow
    // they have since hand-edited. One line here; the logic upgrades itself.
    const cargo = Bun.YAML.parse(
      initFiles('cargo')[1]?.contents as string,
    ) as any
    const steps = cargo.jobs.release.steps
    const notes = steps.find((s: any) => s.name === 'Release notes')

    expect(notes.run).toBe('cutver notes "$TAG" > notes.md')
    // No extraction logic left behind in the workflow.
    expect(JSON.stringify(steps)).not.toContain('awk')
    expect(JSON.stringify(steps)).not.toContain('PROMPT')

    // A hanging summariser is guarded where the mechanism exists, and a failed
    // one must not fail a job whose binaries are already built.
    expect(notes['timeout-minutes']).toBe(15)
    expect(notes['continue-on-error']).toBe(true)

    expect(JSON.stringify(steps)).toContain('--notes-file notes.md')
    expect(JSON.stringify(steps)).not.toContain('--notes ""')
  })

  test('the release job can reach cutver, and the changelog', () => {
    // It reads CHANGELOG.md, so it needs a checkout; it runs `cutver notes`, so
    // it needs cutver. The job otherwise only downloads artifacts, and either
    // omission fails after the tag is public.
    for (const eco of ECOSYSTEMS as readonly Ecosystem[]) {
      const config = {
        ...DEFAULT_CONFIG,
        artifacts: { folders: [], files: 'auto' as const },
      }
      const doc = Bun.YAML.parse(
        initFiles(eco, undefined, config)[1]?.contents as string,
      ) as any
      const steps = doc.jobs.release.steps

      expect(steps[0]?.uses, eco).toBe('actions/checkout@v4')
      const names = steps.map((s: any) => s.name ?? s.uses)
      // Both present before either is ordered — a missing step indexes to -1,
      // which sorts before everything and proves nothing.
      expect(names, eco).toContain('Release notes')
      expect(names, eco).toContain('Attach them to the release')
      expect(names.indexOf('Release notes'), eco).toBeLessThan(
        names.indexOf('Attach them to the release'),
      )
    }
  })

  test('a prerelease tag is marked as one on the GitHub release', () => {
    // `releases/latest/download/…` follows GitHub's idea of latest, which skips
    // prereleases. A beta published as a full release becomes the target of
    // every unpinned download URL in the world — measured against this project,
    // which also measured the 404 in the other direction.
    const cargo = initFiles('cargo')[1]?.contents as string
    expect(cargo).toContain('--prerelease')
  })

  test('publish: false, artifacts: false writes no publish workflow and no handoff to one', () => {
    // A tag that produces nothing needs no workflow, and version.yml must not
    // dispatch a file that is not there — that fails the release run *after*
    // the tag is already public.
    const config = {
      ...DEFAULT_CONFIG,
      publish: false,
      artifacts: false as const,
    }
    const files = initFiles('cargo', undefined, config)

    expect(files.map(f => f.path)).not.toContain(
      '.github/workflows/publish.yml',
    )
    const version = Bun.YAML.parse(files[0]?.contents as string) as any
    expect(JSON.stringify(version.jobs)).not.toContain(
      'gh workflow run publish.yml',
    )
  })

  test('publish plus artifacts does both, which is cutver own shape', () => {
    const config = {
      ...DEFAULT_CONFIG,
      publish: true,
      artifacts: { folders: [], files: 'auto' as const },
    }
    const doc = Bun.YAML.parse(
      initFiles('bun', undefined, config)[1]?.contents as string,
    ) as any

    expect(Object.keys(doc.jobs)).toEqual(['publish', 'artifacts', 'release'])
    expect(JSON.stringify(doc.jobs)).toContain('npm publish')
    expect(doc.permissions['id-token']).toBe('write')
  })

  test('a prerelease never publishes without a dist-tag', () => {
    // npm's default makes it `latest`, silently, and every plain install in
    // the world then resolves to a beta.
    for (const eco of ['bun', 'node'] as const) {
      const publish = JSON.stringify(
        Bun.YAML.parse(initFiles(eco)[1]?.contents as string),
      )
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

    expect(
      await Bun.file(`${root}/.github/workflows/version.yml`).exists(),
    ).toBe(true)
    expect(
      await Bun.file(`${root}/.github/workflows/publish.yml`).exists(),
    ).toBe(true)
    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toContain(
      '## [Unreleased]',
    )
    expect(
      results
        .filter(r => r.path.endsWith('.yml'))
        .every(r => r.state === 'written'),
    ).toBe(true)
  })

  test('refuses to clobber a workflow someone has been editing', async () => {
    const root = await fixture({
      '.github/workflows/version.yml': 'name: mine\n',
    })
    const results = await init(root, 'node', { hook: false })

    expect(results.find(r => r.path.endsWith('version.yml'))?.state).toBe(
      'skipped',
    )
    expect(await Bun.file(`${root}/.github/workflows/version.yml`).text()).toBe(
      'name: mine\n',
    )
    // The other file is still written: a partial adoption is the normal case.
    expect(results.find(r => r.path.endsWith('publish.yml'))?.state).toBe(
      'written',
    )
  })

  test('--force replaces a workflow but never a changelog', async () => {
    // A changelog holds prose someone wrote. Nothing here is entitled to
    // overwrite that, flag or no flag.
    const root = await fixture({
      '.github/workflows/version.yml': 'name: mine\n',
      'CHANGELOG.md': '# mine\n\n## [Unreleased]\n\n- real notes\n',
    })
    const results = await init(root, 'cargo', { force: true, hook: false })

    expect(results.find(r => r.path.endsWith('version.yml'))?.state).toBe(
      'written',
    )
    expect(
      await Bun.file(`${root}/.github/workflows/version.yml`).text(),
    ).toContain('cargo test')
    expect(results.find(r => r.path === 'CHANGELOG.md')?.state).toBe('skipped')
    expect(await Bun.file(`${root}/CHANGELOG.md`).text()).toContain(
      '- real notes',
    )
  })

  test('a dry run reports the same thing and writes none of it', async () => {
    const root = await fixture()
    const results = await init(root, 'bun', { dryRun: true, hook: false })

    expect(
      results
        .filter(r => r.path.endsWith('.yml'))
        .every(r => r.state === 'written'),
    ).toBe(true)
    expect(
      await Bun.file(`${root}/.github/workflows/version.yml`).exists(),
    ).toBe(false)
  })

  test('every ecosystem produces the same files', async () => {
    for (const eco of ECOSYSTEMS as readonly Ecosystem[]) {
      const root = await fixture()
      expect(
        (await init(root, eco, { hook: false }))
          .map(r => r.path)
          .filter(p => p !== 'package.json'),
      ).toEqual([
        '.github/workflows/version.yml',
        '.github/workflows/publish.yml',
        'CHANGELOG.md',
        'cutver.yml',
      ])
    }
  })

  test('the scaffolded config is one cutver itself accepts', () => {
    // It is hand-written YAML — `Bun.YAML.stringify` drops the comments, and in
    // this file the comments are the artifact. Hand-written means a typo ships
    // a config that cutver refuses on the first run after `init`, which is the
    // worst possible moment to find out.
    for (const eco of ECOSYSTEMS as readonly Ecosystem[]) {
      const yml = initFiles(eco).find(f => f.path === 'cutver.yml')
        ?.contents as string
      const config = parseConfig(Bun.YAML.parse(yml), `${eco} cutver.yml`)

      expect(config.target, eco).toBe(eco)
      expect(config.channels[RELEASE], eco).toEqual(['main'])

      // cargo leaves `publish` commented out, so the adapter default applies
      // and a scaffolded Rust workspace does not claim ten crate names on its
      // first tag. Everything else says `registry` outright.
      const adapter = eco === 'cargo' ? 'cargo' : 'js'
      expect(publishesToRegistry(adapter, config), eco).toBe(eco !== 'cargo')
      expect(producesArtifacts(adapter, config), eco).toBe(eco === 'cargo')
    }
  })

  test('the scaffolded config is never overwritten, even with --force', async () => {
    // A config already in the tree is the repository's release policy.
    // Replacing it would change version numbers with no commit to blame.
    const root = await fixture({
      'cutver.yml': 'schema: 1\nchannels:\n  beta: [mine]\n',
    })
    const results = await init(root, 'bun', { hook: false, force: true })

    expect(results.find(r => r.path === 'cutver.yml')?.state).toBe('skipped')
    expect(await Bun.file(`${root}/cutver.yml`).text()).toContain('mine')
  })
})

describe('what init sets up beyond the files', () => {
  const manifest = (o: unknown) => ({
    'package.json': `${JSON.stringify(o, null, 2)}\n`,
  })

  test('pins cutver, so the tool that picks your versions does not float', async () => {
    // Without a pin both the workflow and the hook reach for `bunx cutver`,
    // which resolves `latest` on every run — so a cutver release could change
    // this repository's version numbers with no commit in it.
    const root = await fixture(manifest({ name: 'demo', version: '1.0.0' }))
    const results = await init(root, 'bun', { hook: false, version: '1.4.2' })

    expect(results.find(r => r.path === 'package.json')).toMatchObject({
      state: 'written',
    })
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
      manifest({
        name: 'demo',
        version: '1.0.0',
        devDependencies: { cutver: '0.9.0' },
      }),
    )
    await init(root, 'bun', { hook: false, version: '1.4.2' })

    const json = JSON.parse(await Bun.file(`${root}/package.json`).text())
    expect(json.devDependencies.cutver).toBe('0.9.0')
  })

  test('running from source pins nothing, and says so', async () => {
    const root = await fixture(manifest({ name: 'demo', version: '1.0.0' }))
    const results = await init(root, 'bun', { hook: false, version: 'dev' })

    expect(results.find(r => r.path === 'package.json')).toMatchObject({
      state: 'skipped',
    })
    expect(
      JSON.parse(await Bun.file(`${root}/package.json`).text()).devDependencies,
    ).toBeUndefined()
  })

  test('cargo gets no devDependency — there is no manifest to put one in', async () => {
    const root = await fixture()
    const results = await init(root, 'cargo', { hook: false, version: '1.4.2' })
    expect(results.find(r => r.path === 'package.json')).toBeUndefined()
  })

  test('installs the pre-push guard by default, and skips it on request', async () => {
    const root = await fixture()
    await run(['git', 'init', '-q', '-b', 'main'], root)

    expect(
      (await init(root, 'cargo')).find(r => r.path.includes('pre-push')),
    ).toMatchObject({
      state: 'written',
    })
    expect(await Bun.file(`${root}/.git/hooks/pre-push`).exists()).toBe(true)

    const other = await fixture()
    await run(['git', 'init', '-q', '-b', 'main'], other)
    await init(other, 'cargo', { hook: false })
    expect(await Bun.file(`${other}/.git/hooks/pre-push`).exists()).toBe(false)
  })
})

describe('detecting what a repository already is', () => {
  const tmp = async () => mkdtemp(join(tmpdir(), 'cutver-detect-'))

  test('cargo and package.json together refuse to be guessed at', async () => {
    // The case the positional argument still exists for. Guessing here bumps
    // the wrong manifest, and a version number on a tag cannot be taken back.
    const dir = await tmp()
    await Bun.write(`${dir}/Cargo.toml`, '[package]\n')
    await Bun.write(`${dir}/package.json`, '{}')
    expect(await detectEcosystem(dir)).toBeNull()
    await rm(dir, { recursive: true, force: true })
  })

  test('the lockfile is what separates bun from node', async () => {
    // They share a manifest, so nothing else can. `node` is the safer default:
    // a Node runner installs a Bun project's dependencies, and a Bun runner in
    // a repository that has never seen Bun is a surprise in someone else's CI.
    const dir = await tmp()
    await Bun.write(`${dir}/package.json`, '{}')
    expect(await detectEcosystem(dir)).toBe('node')

    await Bun.write(`${dir}/bun.lock`, '')
    expect(await detectEcosystem(dir)).toBe('bun')
    await rm(dir, { recursive: true, force: true })
  })

  test('an empty tree detects nothing rather than guessing', async () => {
    const dir = await tmp()
    expect(await detectEcosystem(dir)).toBeNull()
    expect(await detectCi(dir)).toBeNull()
    await rm(dir, { recursive: true, force: true })
  })

  test('a non-GitHub provider is named, and GitHub wins when both are there', async () => {
    // Named so `init` can refuse by name instead of writing two workflow files
    // into a directory that system never reads.
    const dir = await tmp()
    await Bun.write(`${dir}/.gitlab-ci.yml`, 'stages: [build]\n')
    expect((await detectCi(dir))?.id).toBe('gitlab')

    // A repository carrying both is usually mirrored rather than undecided, and
    // GitHub is the one cutver can actually generate for.
    await Bun.write(`${dir}/.github/workflows/ci.yml`, 'on: push\n')
    expect((await detectCi(dir))?.id).toBe('github')
    await rm(dir, { recursive: true, force: true })
  })
})
