import { expect, test, describe } from 'bun:test'
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
