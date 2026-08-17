import { expect, test, describe } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import manifest from '../../package.json' with { type: 'json' }

/**
 * The CLI as a subprocess, which is the only way to see what it reports.
 *
 * `VERSION` is not exported and should not be — importing the entry runs the
 * CLI. So the version it believes in is only observable by asking it, and for
 * thirteen releases nobody did: the npm package's `bin` points straight at
 * `src/cli/index.ts`, `CUTVER_VERSION` is injected only by `bun build --compile
 * --define`, and every install from beta.0 onward therefore answered `dev`.
 *
 * That was three bugs wearing one coat. `--version` printed the wrong thing,
 * and both callers that branch on `version === 'dev'` took the source-checkout
 * path: `hook install` wrote the unpinned `releases/latest/download` URL — a
 * 404 in any repository that has only published prereleases — and `init`
 * skipped pinning cutver as a devDependency, generating exactly the workflow
 * floating on `latest` that the pin exists to prevent.
 *
 * Every unit test passed throughout, because each one was handed a `version`
 * argument by the test itself. The gap was never in what the functions did with
 * a version; it was in which version the CLI handed them. That is what running
 * the real entry point checks and nothing else can.
 */

const ENTRY = new URL('./index.ts', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
)

async function cutver(
  ...args: string[]
): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(['bun', ENTRY, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { out: out + err, code: await proc.exited }
}

describe('cutver notes', () => {
  test('a tag prints its changelog section', async () => {
    // Run against this repository, whose changelog is the fixture — a temp repo
    // with one fake tag would test the plumbing and none of the parsing.
    //
    // **The tag is read out of the file rather than written in here.** Pinning
    // `v1.1.1` coupled this to a section `keep: 10` will eventually trim, so it
    // was set to fail on the eleventh stable release for a reason that has
    // nothing to do with the code. The newest heading is always present by
    // definition.
    const changelog = await Bun.file(
      new URL('../../CHANGELOG.md', import.meta.url),
    ).text()
    const newest = /^## \[([^\]]+)\]/m.exec(changelog)?.[1]
    expect(newest, 'no release heading in CHANGELOG.md').toBeTruthy()

    const { out, code } = await cutver('notes', `v${newest}`)
    expect(code).toBe(0)
    // Its own body, and not the one under it: a section that ran on would take
    // the next heading with it.
    expect(out.length).toBeGreaterThan(0)
    const rest = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)]
      .map(m => m[1])
      .slice(1)
    for (const older of rest)
      expect(out, `ran on into ${older}`).not.toContain(`## [${older}]`)
  })

  test('a range compiles from the commits instead', async () => {
    const { out, code } = await cutver('notes', 'v1.1.0', 'v1.1.1')
    expect(code).toBe(0)
    expect(out).toContain('diff:')
    expect(out).toMatch(/^### /m)
  })

  test('a version nobody tagged is not an error', async () => {
    // **Always exit 0.** This runs in a publish job that has already tagged and
    // already built; failing over release notes would strand a release that is
    // otherwise finished.
    const { out, code } = await cutver('notes', 'v99.99.99')
    expect(code).toBe(0)
    expect(out).toContain('releasing without a body')
  })

  test('no argument is refused, since there is nothing to guess', async () => {
    const { code } = await cutver('notes')
    expect(code).toBe(1)
  })
})

describe('the version it reports', () => {
  test('is the manifest version, not `dev`', async () => {
    const { out, code } = await cutver('--version')
    expect(code).toBe(0)
    expect(out.trim()).toBe(manifest.version)
  })

  test('appears in --help too', async () => {
    // `HELP` interpolates the same constant, and it is what a person reads
    // before `--version` occurs to them.
    const { out } = await cutver('--help')
    expect(out).toContain(`cutver ${manifest.version}`)
    expect(out).not.toContain('cutver dev')
  })

  test('is a version the download URLs can be built from', async () => {
    // The consequence, stated as its own assertion: `downloadBase` and `init`'s
    // pin both treat `dev` as "no version", so a CLI reporting it silently
    // degrades both. Anything semver-shaped is enough — this is about the
    // string reaching them at all.
    const { out } = await cutver('--version')
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })
})

/**
 * The tag that already exists.
 *
 * **The version comes from reachable history; the tag namespace is the whole
 * repository.** When a release commit leaves a branch — force-pushed, rebased,
 * never merged — its tag stays behind, and the next run recomputes exactly the
 * version that tag holds. Nothing downstream notices until `git tag`, by which
 * point the generated workflow has already committed and pushed the bump.
 *
 * Found in two real repositories on the same day, both one push from it. Driven
 * end to end rather than unit-tested because the point is that `stage` stops
 * before writing, and "wrote nothing" is only meaningful against a real tree.
 */
describe('cutver stage, against an orphaned tag', () => {
  async function repo(): Promise<string> {
    const dir = mkdtempSync(`${tmpdir()}/cutver-orphan-`).replaceAll('\\', '/')
    const git = (...args: string[]) =>
      Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
        .exited

    await git('init', '-q')
    await git('config', 'user.email', 'a@b.c')
    await git('config', 'user.name', 't')
    await Bun.write(`${dir}/package.json`, '{"name":"p","version":"1.0.0"}')
    await git('add', '-A')
    await git('commit', '-qm', 'feat: base')
    await git('tag', 'v1.0.0')

    // A release that was tagged and then lost its commit.
    await Bun.write(`${dir}/f.txt`, 'x')
    await git('add', '-A')
    await git('commit', '-qm', 'fix: released, then rewritten away')
    await git('tag', 'v1.0.1')
    await git('reset', '--hard', '-q', 'HEAD~1')

    // Work since, which recomputes the same 1.0.1.
    await Bun.write(`${dir}/g.txt`, 'y')
    await git('add', '-A')
    await git('commit', '-qm', 'fix: something else')
    return dir
  }

  test('refuses, names the repair, and writes nothing', async () => {
    const dir = await repo()
    const { out, code } = await cutver('stage', '--offline', '--cwd', dir)

    expect(code).toBe(1)
    expect(out).toContain('v1.0.1 already exists as a tag')
    expect(out).toContain('git merge --no-ff v1.0.1')

    // The half that matters. A refusal after the manifest is written is the
    // failure this replaces, not an improvement on it.
    const manifest = await Bun.file(`${dir}/package.json`).json()
    expect(manifest.version).toBe('1.0.0')

    rmSync(dir, { recursive: true, force: true })
  })

  test('--if-needed does not soften it', async () => {
    // That flag means "no release was warranted". This is the opposite: one is
    // warranted and cannot be cut, so going green would hide it.
    const dir = await repo()
    const { code } = await cutver(
      'stage',
      '--offline',
      '--if-needed',
      '--cwd',
      dir,
    )

    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * Leaving 0.x, which no commit message can authorise.
 *
 * **The arithmetic is right and stays as it is** — semver says a `feat!` is a
 * major, and the ported `applyBump` applies it. What it cannot know is that
 * crossing out of `0.x` means something no rule decides: `0.x` is where an
 * author may still change their mind and `1.0.0` is a promise to stop.
 *
 * Left alone it was the most expensive accident available here. The generated
 * `version.yml` runs `stage --if-needed` unattended and then commits, tags and
 * pushes — so a 0.x project's first `feat!` shipped `1.0.0` to a registry with
 * nobody in the loop, and npm never gives a number back.
 */
describe('cutver stage, crossing out of 0.x', () => {
  async function repo(version: string, subject: string): Promise<string> {
    const dir = mkdtempSync(`${tmpdir()}/cutver-zerox-`).replaceAll('\\', '/')
    const git = (...args: string[]) =>
      Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
        .exited

    await git('init', '-q')
    await git('config', 'user.email', 'a@b.c')
    await git('config', 'user.name', 't')
    await Bun.write(
      `${dir}/package.json`,
      `{"name":"p","version":"${version}"}`,
    )
    await git('add', '-A')
    await git('commit', '-qm', 'feat: base')
    await git('tag', `v${version}`)

    await Bun.write(`${dir}/f.txt`, 'x')
    await git('add', '-A')
    await git('commit', '-qm', subject)
    return dir
  }

  test('refuses, writes nothing, and names both ways out', async () => {
    const dir = await repo('0.2.0', 'feat(core)!: a breaking change')
    const { out, code } = await cutver('stage', '--offline', '--cwd', dir)

    expect(code).toBe(1)
    expect(out).toContain('cutver stage 1.0.0')
    // The conventional reading below 1.0.0, offered rather than applied —
    // cutver does not get to pick which of the two a project meant.
    expect(out).toContain('cutver stage 0.3.0')

    const manifest = await Bun.file(`${dir}/package.json`).json()
    expect(manifest.version).toBe('0.2.0')

    rmSync(dir, { recursive: true, force: true })
  })

  test('--if-needed does not soften it', async () => {
    // That flag means no release was warranted. Here one is, and cannot be
    // cut for you — which is the whole reason to stop.
    const dir = await repo('0.2.0', 'feat(core)!: a breaking change')
    const { code } = await cutver(
      'stage',
      '--offline',
      '--if-needed',
      '--cwd',
      dir,
    )

    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('an explicit version is obeyed, either way', async () => {
    for (const asked of ['1.0.0', '0.3.0']) {
      const dir = await repo('0.2.0', 'feat(core)!: a breaking change')
      const { out, code } = await cutver(
        'stage',
        asked,
        '--offline',
        '--dry-run',
        '--cwd',
        dir,
      )

      expect(code, asked).toBe(0)
      expect(out, asked).toContain(`0.2.0 -> ${asked}`)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('1.x is untouched — the promise is already made', async () => {
    const dir = await repo('1.4.0', 'feat(core)!: a breaking change')
    const { out, code } = await cutver(
      'stage',
      '--offline',
      '--dry-run',
      '--cwd',
      dir,
    )

    expect(code).toBe(0)
    expect(out).toContain('1.4.0 -> 2.0.0')
    rmSync(dir, { recursive: true, force: true })
  })
})
