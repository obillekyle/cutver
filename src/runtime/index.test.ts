import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  exists,
  glob,
  globMatch,
  readText,
  remove,
  semverOrder,
  write,
} from './index'

/**
 * The host layer, checked against Bun's own answers.
 *
 * Three of these functions replace a Bun builtin with a local implementation —
 * globbing, glob matching and semver precedence — because Node has no
 * equivalent. Bun is what the suite runs on, so its builtins are available here
 * as a **reference oracle**: rather than asserting a table of values somebody
 * believed to be right, each case asserts that the local implementation agrees
 * with the thing it replaced.
 *
 * That distinction matters for the semver one especially. It decides which tag
 * a version is measured from when two tags share a commit timestamp, which is
 * every scripted release — and a table would encode the author's reading of the
 * spec rather than the behaviour being preserved.
 */
const roots: string[] = []
function scratch(): string {
  const dir = mkdtempSync(`${tmpdir()}/cutver-rt-`).replaceAll('\\', '/')
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('files', () => {
  test('writes, reads back, and reports existence', async () => {
    const dir = scratch()
    await write(`${dir}/plain.txt`, 'hello')

    expect(await readText(`${dir}/plain.txt`)).toBe('hello')
    expect(await exists(`${dir}/plain.txt`)).toBe(true)
    expect(await exists(`${dir}/nothing.txt`)).toBe(false)
  })

  test('creates parent directories', async () => {
    // What `init` depends on without saying so: it writes
    // `.github/workflows/version.yml` into a tree with neither directory and
    // never calls mkdir. Bare `fs.writeFile` throws ENOENT here.
    const dir = scratch()
    await write(`${dir}/.github/workflows/version.yml`, 'name: Version\n')

    expect(await readText(`${dir}/.github/workflows/version.yml`)).toBe(
      'name: Version\n',
    )
  })

  test('reading a missing file rejects rather than returning empty', () => {
    // Callers distinguish absent from empty — `exists` answers the first. A
    // read resolving to '' would make a truncated config look like a valid one
    // with everything defaulted.
    expect(readText(`${scratch()}/nope.txt`)).rejects.toThrow()
  })

  test('removing is idempotent', async () => {
    // `hook uninstall` runs on repositories that may have no hook at all.
    const dir = scratch()
    await write(`${dir}/a.txt`, 'x')
    await remove(`${dir}/a.txt`)

    expect(await exists(`${dir}/a.txt`)).toBe(false)
    expect(remove(`${dir}/never-existed`)).resolves.toBeUndefined()
  })
})

// **The oracle below is ground truth only for what this corpus asks it.**
//
// The two implementations diverge on one input, deliberately and invisibly: a
// pattern containing a backslash. `segmentRe` and `patternRe` escape it as a
// literal character to match, while Bun reads it as a path separator on
// Windows. Measured on a two-package tree:
//
//     packages/*/package.json     cutver [one, two]   Bun [one, two]
//     packages\*\package.json     cutver []           Bun [one, two]
//
// No pattern below contains one, so the disagreement never shows up — and that
// is the hazard rather than the reassurance. **Adding a backslash pattern here
// would make this test demand cutver reproduce Bun's separator handling, and
// read as cutver being wrong when it is only different.** Mirror the divergence
// into the expectation instead, and say which way is deliberate: an edited
// reference implementation is fine, a silently edited one reads as authority.
//
// The user-facing half is recorded rather than fixed. On Windows a hand-written
// pattern using backslashes matches nothing, so no manifest gets a version and
// nothing says so. Normalising separators has to be platform-conditional — a
// literal backslash is a legal filename character on Linux and impossible on
// Windows — which makes it a decision rather than a cleanup.
describe('glob, against Bun.Glob', () => {
  test('finds the same files, including ** and the root case', async () => {
    const dir = scratch()
    for (const path of [
      'package.json',
      'packages/one/package.json',
      'packages/two/package.json',
      'packages/two/deep/package.json',
      'packages/two/README.md',
      'app.v2/package.json',
    ]) {
      await write(`${dir}/${path}`, '{}')
    }

    for (const pattern of [
      'packages/*/package.json',
      '**/package.json',
      '*/package.json',
      'packages/**/package.json',
      'app.v2/package.json',
      'nothing/*/package.json',
    ]) {
      const expected: string[] = []
      for await (const hit of new Bun.Glob(pattern).scan({
        cwd: dir,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        expected.push(hit.replaceAll('\\', '/'))
      }

      expect((await glob(pattern, dir)).sort(), `pattern ${pattern}`).toEqual(
        expected.sort(),
      )
    }
  })

  test('a dot in a pattern is a dot, not any character', async () => {
    // `app.v2` escaped wrongly also matches a sibling `appxv2`, and the wrong
    // manifest gets the version written into it.
    const dir = scratch()
    await write(`${dir}/app.v2/package.json`, '{}')
    await write(`${dir}/appxv2/package.json`, '{}')

    expect(await glob('app.v2/package.json', dir)).toEqual([
      'app.v2/package.json',
    ])
  })

  test('matching a branch name agrees with Bun.Glob', () => {
    // Config globs reach `on.push.branches` verbatim, so a disagreement means
    // cutver and the workflow it generated claim different branches.
    for (const [pattern, name] of [
      ['*-beta', '1.3.0-beta'],
      ['*-beta', 'beta'],
      ['release/*', 'release/2.0'],
      ['release/*', 'release/2.0/hotfix'],
      ['**', 'anything/at/all'],
      ['docs/**', 'docs'],
      ['docs/**', 'docs/guides/x'],
      ['main', 'main'],
      ['main', 'maintenance'],
      ['v?.0', 'v2.0'],
      ['app.v2', 'appxv2'],
      ['feat/*', 'feat/a/b'],
    ] as [string, string][]) {
      expect(globMatch(pattern, name), `${pattern} vs ${name}`).toBe(
        new Bun.Glob(pattern).match(name),
      )
    }
  })
})

describe('semver order, against Bun.semver', () => {
  const VERSIONS = [
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '2.0.0',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.10',
    '1.0.0-rc.1',
    '0.1.0',
    '10.0.0',
    '1.0.0-rc.9',
    '1.0.0-rc.10',
    '1.0.0+build.1',
  ]

  test('agrees on every pair', () => {
    for (const a of VERSIONS) {
      for (const b of VERSIONS) {
        expect(Math.sign(semverOrder(a, b)), `order(${a}, ${b})`).toBe(
          Math.sign(Bun.semver.order(a, b)),
        )
      }
    }
  })

  test('sorts a realistic tag list the same way', () => {
    // The actual use: same-second tags ordered by precedence. `beta.10` above
    // `beta.9` is the one a string sort gets wrong.
    const tags = [
      '1.0.0-beta.9',
      '1.0.0',
      '1.0.0-beta.10',
      '0.9.9',
      '1.0.0-rc.1',
    ]

    expect([...tags].sort(semverOrder)).toEqual(
      [...tags].sort(Bun.semver.order),
    )
    expect([...tags].sort(semverOrder).at(-1)).toBe('1.0.0')
  })
})
