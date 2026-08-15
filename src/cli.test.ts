import { expect, test, describe } from 'bun:test'
import manifest from '../package.json' with { type: 'json' }

/**
 * The CLI as a subprocess, which is the only way to see what it reports.
 *
 * `VERSION` is not exported and should not be — importing `cli.ts` runs the
 * CLI. So the version it believes in is only observable by asking it, and for
 * thirteen releases nobody did: the npm package's `bin` points straight at
 * `src/cli.ts`, `CUTVER_VERSION` is injected only by `bun build --compile
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

const ENTRY = new URL('./cli.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

async function cutver(...args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(['bun', ENTRY, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { out: out + err, code: await proc.exited }
}

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
