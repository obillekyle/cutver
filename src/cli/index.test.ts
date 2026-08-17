import { expect, test, describe } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import manifest from '../../package.json' with { type: 'json' }

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

/**
 * Every test here spawns at least one process, and bun's default allows 5s.
 *
 * **Measured, after chasing it as a mystery flake for a while.** The suite went
 * green 18 runs out of 20 and failed twice with no pattern; the failures were
 * `Expected: 0, Received: 143`, which is SIGTERM — bun killing a subprocess it
 * had already given up on. The line above it said so plainly once the run was
 * captured: `this test timed out after 5000ms`, at 5030ms.
 *
 * `an explicit version is obeyed, either way` is the one that goes first,
 * because it builds a git repository and spawns cutver *twice* in a loop. On an
 * idle machine it lands just under the limit; with anything else running it
 * does not. Nothing was wrong with the code, and every re-run said so, which is
 * exactly what made it expensive to find.
 *
 * Generous rather than tuned: the number that matters is "not a wall clock a
 * loaded laptop can lose against", and a test that hangs for real still fails.
 */
const SLOW = 30_000

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
  test(
    'a tag prints its changelog section',
    async () => {
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
    },
    SLOW,
  )

  test(
    'a range compiles from the commits instead',
    async () => {
      const { out, code } = await cutver('notes', 'v1.1.0', 'v1.1.1')
      expect(code).toBe(0)
      expect(out).toContain('diff:')
      expect(out).toMatch(/^### /m)
    },
    SLOW,
  )

  test(
    'a version nobody tagged is not an error',
    async () => {
      // **Always exit 0.** This runs in a publish job that has already tagged and
      // already built; failing over release notes would strand a release that is
      // otherwise finished.
      const { out, code } = await cutver('notes', 'v99.99.99')
      expect(code).toBe(0)
      expect(out).toContain('releasing without a body')
    },
    SLOW,
  )

  test(
    'no argument is refused, since there is nothing to guess',
    async () => {
      const { code } = await cutver('notes')
      expect(code).toBe(1)
    },
    SLOW,
  )
})

describe('the version it reports', () => {
  test(
    'is the manifest version, not `dev`',
    async () => {
      const { out, code } = await cutver('--version')
      expect(code).toBe(0)
      expect(out.trim()).toBe(manifest.version)
    },
    SLOW,
  )

  test(
    'appears in --help too',
    async () => {
      // `help()` is handed the same version, and it is what a person reads
      // before `--version` occurs to them.
      const { out } = await cutver('--help')
      expect(out).toContain(`cutver ${manifest.version}`)
      expect(out).not.toContain('cutver dev')
    },
    SLOW,
  )

  test(
    'is a version the download URLs can be built from',
    async () => {
      // The consequence, stated as its own assertion: `downloadBase` and `init`'s
      // pin both treat `dev` as "no version", so a CLI reporting it silently
      // degrades both. Anything semver-shaped is enough — this is about the
      // string reaching them at all.
      const { out } = await cutver('--version')
      expect(out.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    },
    SLOW,
  )
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

  test(
    'refuses, names the repair, and writes nothing',
    async () => {
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
    },
    SLOW,
  )

  test(
    '--if-needed does not soften it',
    async () => {
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
    },
    SLOW,
  )
})

/**
 * Both manifests, and no config to say which one the release is about.
 *
 * **The refusal is right; ending the process for it was not.** `check`,
 * `doctor` and `explain` all resolve an adapter, and `resolveAdapter` refuses
 * to guess when a repository holds a `package.json` and a `Cargo.toml` — the
 * napi-rs, Tauri and wasm-pack shape. It refused by calling `die()`, which
 * exits, so `check` left with 1 against a promise to exit 0 for everything but
 * the branch-declared refusal. `check` is what the pre-push hook runs, so in
 * one of those repositories that was every push, and the flag the error named
 * as the way out was rejected for not being in `check`'s flag list.
 *
 * Driven end to end because both halves are wiring: which list a flag is in,
 * and whether a refusal returns or exits. Neither is visible to a unit test of
 * the functions themselves, which is exactly how it survived.
 */
describe('cutver check, with both manifests present', () => {
  async function repo(): Promise<string> {
    const dir = mkdtempSync(`${tmpdir()}/cutver-dual-`).replaceAll('\\', '/')
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
    await Bun.write(`${dir}/package.json`, '{"name":"p","version":"1.0.0"}')
    await Bun.write(
      `${dir}/Cargo.toml`,
      '[package]\nname = "p"\nversion = "1.0.0"\n',
    )
    await git('add', '-A')
    await git('commit', '-qm', 'feat: base')
    return dir
  }

  test(
    'exits 0 and names the way out, rather than blocking the push',
    async () => {
      const dir = await repo()
      const { out, code } = await cutver('check', '--cwd', dir)

      expect(code).toBe(0)
      expect(out).toContain('package.json and Cargo.toml')
      expect(out).toContain('--adapter js|cargo')

      rmSync(dir, { recursive: true, force: true })
    },
    SLOW,
  )

  test(
    'accepts the flag its own error advises',
    async () => {
      const dir = await repo()
      const { out, code } = await cutver(
        'check',
        '--adapter',
        'js',
        '--cwd',
        dir,
      )

      expect(code).toBe(0)
      expect(out).not.toContain('does not take --adapter')
      expect(out).toContain('check ok')

      rmSync(dir, { recursive: true, force: true })
    },
    SLOW,
  )

  test(
    'explain keeps its own promise too',
    async () => {
      const dir = await repo()
      const { code } = await cutver('explain', '--cwd', dir)

      expect(code).toBe(0)
      rmSync(dir, { recursive: true, force: true })
    },
    SLOW,
  )

  test(
    'doctor reports it instead of dying mid-report',
    async () => {
      // Exit 1 is right here — it is a real problem and `doctor` grades on
      // findings. What matters is that the rest of the report still printed.
      const dir = await repo()
      const { out, code } = await cutver('doctor', '--offline', '--cwd', dir)

      expect(code).toBe(1)
      expect(out).toContain('package.json and Cargo.toml')
      expect(out).toContain('channels')

      rmSync(dir, { recursive: true, force: true })
    },
    SLOW,
  )
})

/**
 * The opening tag, in a repository that has none.
 *
 * Two halves, and only the second is wiring. `plan` decides that an untagged
 * repository ships the version its manifest already names; `stage` is what
 * turns that into a tag on disk, and only when the manifest did not have to
 * change — because the tag lands on HEAD, and HEAD has to already hold the
 * version being cut. Neither half is observable from the other.
 */
describe('cutver stage, in a repository with no tags', () => {
  async function repo(version: string, subject: string): Promise<string> {
    const dir = mkdtempSync(`${tmpdir()}/cutver-first-`).replaceAll('\\', '/')
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
    await Bun.write(
      `${dir}/package.json`,
      `{"name":"p","version":"${version}"}`,
    )
    await git('add', '-A')
    await git('commit', '-qm', subject)
    return dir
  }

  async function tags(dir: string): Promise<string> {
    const p = Bun.spawn(['git', 'tag'], { cwd: dir, stdout: 'pipe' })
    return (await new Response(p.stdout).text()).trim()
  }

  test(
    'ships the manifest version and tags it',
    async () => {
      // `npm init` writes 1.0.0. Before this, the first release of a brand-new
      // project was 1.1.0 — 1.0.0 skipped, and unavailable to anyone reading the
      // tag list later.
      const dir = await repo('1.0.0', 'feat: the library view')
      const { out, code } = await cutver('stage', '--offline', '--cwd', dir)

      expect(code).toBe(0)
      expect(out).toContain('1.0.0 -> 1.0.0')
      expect(out).toContain('first release')
      expect(await tags(dir)).toBe('v1.0.0')

      // The manifest is left exactly as it was: it already said the right thing,
      // which is the whole reason the tag can go on HEAD.
      const manifest = await Bun.file(`${dir}/package.json`).json()
      expect(manifest.version).toBe('1.0.0')

      rmSync(dir, { recursive: true, force: true })
    },
    SLOW,
  )

  test(
    'does not tag when the manifest had to change',
    async () => {
      // `0.0.0` is a placeholder rather than an intended release, so the commits
      // decide and the manifest moves — which leaves the bump uncommitted. A tag
      // on HEAD would name a commit whose manifest still says 0.0.0.
      const dir = await repo('0.0.0', 'feat: the library view')
      const { out, code } = await cutver('stage', '--offline', '--cwd', dir)

      expect(code).toBe(0)
      expect(out).toContain('0.0.0 -> 0.1.0')
      expect(await tags(dir), 'tagged a commit that predates the bump').toBe('')
      expect(out).toContain('commit, tag v0.1.0')

      rmSync(dir, { recursive: true, force: true })
    },
    SLOW,
  )

  test(
    'a dry run says it would tag, and creates nothing',
    async () => {
      const dir = await repo('2.3.1', 'fix: a race')
      const { out, code } = await cutver(
        'stage',
        '--offline',
        '--dry-run',
        '--cwd',
        dir,
      )

      expect(code).toBe(0)
      expect(out).toContain('2.3.1 -> 2.3.1')
      expect(out).toContain('would also create v2.3.1')
      expect(await tags(dir)).toBe('')

      rmSync(dir, { recursive: true, force: true })
    },
    SLOW,
  )
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

  test(
    'refuses, writes nothing, and names both ways out',
    async () => {
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
    },
    SLOW,
  )

  test(
    '--if-needed does not soften it',
    async () => {
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
    },
    SLOW,
  )

  test(
    'an explicit version is obeyed, either way',
    async () => {
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
    },
    SLOW,
  )

  test(
    '1.x is untouched — the promise is already made',
    async () => {
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
    },
    SLOW,
  )
})

/**
 * The refusals in `runStage` that nothing reached.
 *
 * **`stage.ts` exports one function, and that is right.** `target`, `preflight`
 * and the dirty-tree guard are module-private, so a co-located unit test would
 * mean widening the public surface purely to look at it — and every one of them
 * is a refusal, which is only meaningful against a real tree. What was missing
 * was coverage, not a file: `runStage` is the only path that writes a version,
 * and three of its guards had nothing driving them.
 */
describe('cutver stage, the guards before the write', () => {
  async function repo(): Promise<string> {
    const dir = mkdtempSync(`${tmpdir()}/cutver-guard-`).replaceAll('\\', '/')
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
    await Bun.write(`${dir}/package.json`, '{"name":"p","version":"1.0.0"}')
    await git('add', '-A')
    await git('commit', '-qm', 'feat: base')
    await git('tag', 'v1.0.0')
    await Bun.write(`${dir}/f.txt`, 'x')
    await git('add', '-A')
    await git('commit', '-qm', 'fix: something')
    return dir
  }

  test(
    'a dirty tree is refused, and nothing is written',
    async () => {
      // The release would otherwise capture edits nobody reviewed — and the
      // manifest it captured them into is the one thing that cannot be undone
      // by re-running.
      const dir = await repo()
      await Bun.write(`${dir}/stray.txt`, 'unreviewed')

      const { out, code } = await cutver('stage', '--offline', '--cwd', dir)
      expect(code).toBe(1)
      expect(out).toContain('working tree is not clean')

      const manifest = await Bun.file(`${dir}/package.json`).json()
      expect(manifest.version).toBe('1.0.0')

      rmSync(dir, { recursive: true, force: true })
    },
    SLOW,
  )

  test(
    'a dry run does not ask about the tree',
    async () => {
      // Guarded on the flag rather than the answer: nothing is written, so the
      // answer could not be used, and asking spends a git spawn on the flag
      // people iterate with.
      const dir = await repo()
      await Bun.write(`${dir}/stray.txt`, 'unreviewed')

      const { out, code } = await cutver(
        'stage',
        '--offline',
        '--dry-run',
        '--cwd',
        dir,
      )
      expect(code).toBe(0)
      expect(out).not.toContain('working tree is not clean')

      rmSync(dir, { recursive: true, force: true })
    },
    SLOW,
  )

  test(
    'the argument is a version, a channel, or an error that says which',
    async () => {
      const dir = await repo()

      // A leading `v` is the actual mistake, so the message is about the `v`
      // rather than about a channel nobody was naming.
      const v = await cutver('stage', 'v1.2.0', '--offline', '--cwd', dir)
      expect(v.code).toBe(1)
      expect(v.out).toContain("no leading 'v'")

      // Neither shape: the message lists what this repository does have.
      const nonsense = await cutver('stage', 'gamma', '--offline', '--cwd', dir)
      expect(nonsense.code).toBe(1)
      expect(nonsense.out).toContain('neither a version nor a channel')
      expect(nonsense.out).toContain('Channels here:')

      // Two of them is not a guess to make.
      const two = await cutver(
        'stage',
        '1.2.0',
        'beta',
        '--offline',
        '--cwd',
        dir,
      )
      expect(two.code).toBe(1)
      expect(two.out).toContain('one channel or version')

      rmSync(dir, { recursive: true, force: true })
    },
    SLOW,
  )
})
