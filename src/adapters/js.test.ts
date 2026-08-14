import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { jsAdapter, workspaceDirs } from './js'

const made: string[] = []

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = (await mkdtemp(`${tmpdir()}/cutver-js-`)).replaceAll('\\', '/')
  made.push(dir)
  for (const [rel, body] of Object.entries(files)) await Bun.write(`${dir}/${rel}`, body)
  return dir
}

afterEach(async () => {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true })
})

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`

/** A workspace shaped like the one this was extracted from, in miniature. */
async function workspace(): Promise<string> {
  return fixture({
    'package.json': json({
      name: 'monorepo',
      version: '1.2.3',
      private: true,
      workspaces: ['packages/*', 'apps/*'],
    }),
    'packages/core/package.json': json({ name: '@scope/core', version: '1.2.3' }),
    'packages/cli/package.json': json({ name: '@scope/cli', version: '1.2.3' }),
    'apps/example/package.json': json({ name: 'example', version: '4.0.0', private: true }),
    'bun.lock': `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "monorepo",
    },
    "apps/example": {
      "name": "example",
      "version": "4.0.0",
    },
    "packages/cli": {
      "name": "@scope/cli",
      "version": "1.2.3",
    },
    "packages/core": {
      "name": "@scope/core",
      "version": "1.2.3",
    },
  },
  "packages": {
    "@scope/core": ["@scope/core@1.2.3", "", {}, "sha512-xxx"],
  },
}
`,
  })
}

describe('workspaceDirs', () => {
  test('expands the workspace globs, sorted', async () => {
    expect(await workspaceDirs(await workspace())).toEqual([
      'apps/example',
      'packages/cli',
      'packages/core',
    ])
  })

  test('empty for a single-package repository', async () => {
    const root = await fixture({ 'package.json': json({ name: 'solo', version: '1.0.0' }) })
    expect(await workspaceDirs(root)).toEqual([])
  })

  test('never walks into node_modules', async () => {
    const root = await fixture({
      'package.json': json({ name: 'root', version: '1.0.0', workspaces: ['packages/**'] }),
      'packages/a/package.json': json({ name: 'a', version: '1.0.0' }),
      'packages/a/node_modules/vendored/package.json': json({ name: 'vendored', version: '9.9.9' }),
    })
    expect(await workspaceDirs(root)).toEqual(['packages/a'])
  })
})

describe('setVersion', () => {
  test('bumps the publishable packages and the root, leaves private ones', async () => {
    const root = await workspace()
    const changes = await jsAdapter.setVersion({ root, version: '1.3.0', dryRun: false })

    expect(await jsAdapter.readVersion(root)).toBe('1.3.0')
    expect(JSON.parse(await Bun.file(`${root}/packages/core/package.json`).text()).version).toBe(
      '1.3.0',
    )
    // The example app is private: nobody resolves a range against it, and
    // dragging it along makes the diff of a release larger than the release.
    expect(JSON.parse(await Bun.file(`${root}/apps/example/package.json`).text()).version).toBe(
      '4.0.0',
    )
    expect(changes.find(c => c.file === 'apps/example/package.json')?.state).toBe('unchanged')
  })

  test('carries the version into bun.lock — the whole reason this exists', async () => {
    // `bun pm pack` expands `workspace:^` from the *lockfile*, so a lock left
    // at 1.2.3 publishes packages depending on a version that is not the one
    // being released. Seven packages went out that way once.
    const root = await workspace()
    await jsAdapter.setVersion({ root, version: '1.3.0', dryRun: false })
    const lock = await Bun.file(`${root}/bun.lock`).text()

    expect(lock).toContain('"@scope/core",\n      "version": "1.3.0"')
    expect(lock).toContain('"@scope/cli",\n      "version": "1.3.0"')
    // The private workspace is not bumped, so its lock entry must not move.
    expect(lock).toContain('"version": "4.0.0"')
    // And the resolved-dependency section below is a different thing entirely
    // that happens to mention the same name. It must not be rewritten.
    expect(lock).toContain('"@scope/core@1.2.3"')
  })

  test('refuses a lockfile that has no entry for a package it just bumped', async () => {
    // A stale lock in the one form that would otherwise pass silently.
    const root = await fixture({
      'package.json': json({ name: 'root', version: '1.0.0', workspaces: ['packages/*'] }),
      'packages/a/package.json': json({ name: 'a', version: '1.0.0' }),
      'bun.lock': '{\n  "workspaces": {\n    "": {\n      "name": "root",\n    },\n  },\n}\n',
    })
    expect(jsAdapter.setVersion({ root, version: '1.1.0', dryRun: false })).rejects.toThrow(
      /no workspace entry for packages\/a/,
    )
  })

  test('a missing lockfile is reported, not fatal', async () => {
    const root = await fixture({
      'package.json': json({ name: 'root', version: '1.0.0', workspaces: ['packages/*'] }),
      'packages/a/package.json': json({ name: 'a', version: '1.0.0' }),
    })
    const changes = await jsAdapter.setVersion({ root, version: '1.1.0', dryRun: false })
    expect(changes.find(c => c.file === 'bun.lock')?.state).toBe('absent')
  })

  test('a dry run reports every change and writes none of them', async () => {
    const root = await workspace()
    const before = await Bun.file(`${root}/bun.lock`).text()
    const changes = await jsAdapter.setVersion({ root, version: '1.3.0', dryRun: true })

    expect(changes.filter(c => c.state === 'updated').map(c => c.file).sort()).toEqual([
      'bun.lock',
      'package.json',
      'packages/cli/package.json',
      'packages/core/package.json',
    ])
    expect(await jsAdapter.readVersion(root)).toBe('1.2.3')
    expect(await Bun.file(`${root}/bun.lock`).text()).toBe(before)
  })

  test('keeps the manifest formatted the way it found it', async () => {
    // A version bump whose diff is the whole file buries the one line that
    // matters. Tabs and CRLF both survive.
    const root = await fixture({
      'package.json': '{\r\n\t"name": "tabbed",\r\n\t"version": "1.0.0"\r\n}\r\n',
    })
    await jsAdapter.setVersion({ root, version: '1.0.1', dryRun: false })
    const after = await Bun.file(`${root}/package.json`).text()

    expect(after).toBe('{\r\n\t"name": "tabbed",\r\n\t"version": "1.0.1"\r\n}\r\n')
  })
})

describe('publishTargets', () => {
  test('names what would reach the registry, and nothing private', async () => {
    expect(await jsAdapter.publishTargets(await workspace())).toEqual([
      { name: '@scope/cli', dir: 'packages/cli', registry: 'npm', repository: null },
      { name: '@scope/core', dir: 'packages/core', registry: 'npm', repository: null },
    ])
  })

  test('a single-package repository publishes its root', async () => {
    const root = await fixture({ 'package.json': json({ name: 'solo', version: '1.0.0' }) })
    expect(await jsAdapter.publishTargets(root)).toEqual([
      { name: 'solo', dir: '.', registry: 'npm', repository: null },
    ])
  })
})
