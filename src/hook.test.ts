import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { HOOK_NAME, hookScript, installHook, MARKER, uninstallHook } from './hook'
import { plan, PlanRefusal } from './plan'
import { run } from './run'

const made: string[] = []

afterEach(async () => {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true })
})

async function repo(entries: string[]): Promise<string> {
  const dir = (await mkdtemp(`${tmpdir()}/cutver-hook-`)).replaceAll('\\', '/')
  made.push(dir)

  await run(['git', 'init', '-q', '-b', 'main'], dir)
  await run(['git', 'config', 'user.email', 'fixture@example.invalid'], dir)
  await run(['git', 'config', 'user.name', 'fixture'], dir)

  for (const [i, entry] of entries.entries()) {
    const [subject = '', tag] = entry.split('@')
    await Bun.write(`${dir}/f${i}.txt`, `${i}\n`)
    await run(['git', 'add', '-A'], dir)
    await run(['git', 'commit', '-q', '-m', subject], dir)
    if (tag) await run(['git', 'tag', tag], dir)
  }

  return dir
}

/**
 * The scenario the hook exists for, stated as the user did: the *same* commit
 * is a mistake on one release branch and correct on another, and the only
 * difference is the name of the branch it is being pushed to.
 */
describe('what the hook is guarding', () => {
  test('a feat! is refused on a 1.3.0-beta branch', async () => {
    const root = await repo(['feat: one@v1.2.0', 'feat!: the world moved'])
    expect(
      plan({ root, current: '1.3.0-beta.0', branch: '1.3.0-beta', channel: null }),
    ).rejects.toBeInstanceOf(PlanRefusal)
  })

  test('and allowed on a 2.0.0-beta branch', async () => {
    // Same history, same commit, different promise. The declared base matches
    // what the commits imply, so there is nothing to refuse.
    const root = await repo(['feat: one@v1.2.0', 'feat!: the world moved'])
    expect(
      await plan({ root, current: '2.0.0-beta.0', branch: '2.0.0-beta', channel: null }),
    ).toMatchObject({ kind: 'release', version: '2.0.0-beta.1' })
  })

  test('the refusal is typed, so a hook can tell it from a crash', async () => {
    // `cutver check` blocks a push on this and lets everything else through. A
    // guard that fails closed on its own bug blocks every push in the repo.
    const root = await repo(['feat: one@v1.2.0', 'feat!: the world moved'])
    const err = await plan({
      root,
      current: '1.3.0-beta.0',
      branch: '1.3.0-beta',
      channel: null,
    }).catch(e => e)

    expect(err).toBeInstanceOf(PlanRefusal)
    expect(err.message).toContain('declares 1.3.0')
    expect(err.message).toContain('2.0.0')
  })

  test('--rev judges the ref being pushed, not the one checked out', async () => {
    // A pre-push hook is handed a sha per ref, and the branch you are pushing
    // is not always the branch you are on. Judging HEAD instead would clear a
    // push that carries a breaking commit.
    const root = await repo(['feat: one@v1.2.0', 'feat!: the world moved'])
    const head = (await run(['git', 'rev-parse', 'HEAD'], root)).out
    const parent = (await run(['git', 'rev-parse', 'HEAD~1'], root)).out

    // At HEAD the break is present and refused…
    expect(
      plan({ root, current: '1.3.0-beta.0', branch: '1.3.0-beta', channel: null, rev: head }),
    ).rejects.toBeInstanceOf(PlanRefusal)

    // …one commit earlier it is not there yet, so the same branch is fine.
    expect(
      await plan({
        root,
        current: '1.3.0-beta.0',
        branch: '1.3.0-beta',
        channel: null,
        rev: parent,
      }),
    ).toMatchObject({ kind: 'nothing' })
  })
})

describe('the generated script', () => {
  test('is valid shell', async () => {
    // Generated shell that a person only ever sees when it misfires. `sh -n`
    // parses without running, and it is the only cheap way to know the quoting
    // and the `while read` loop are real rather than plausible.
    const dir = (await mkdtemp(`${tmpdir()}/cutver-sh-`)).replaceAll('\\', '/')
    made.push(dir)
    await Bun.write(`${dir}/pre-push`, hookScript())

    const { ok, err } = await run(['sh', '-n', `${dir}/pre-push`], dir)
    expect(err).toBe('')
    expect(ok).toBe(true)
  })

  test('ignores tags and deletions', () => {
    const s = hookScript()
    expect(s).toContain('refs/heads/*')
    // A branch deletion arrives with an all-zero sha and no commits to judge.
    expect(s).toContain('ZERO=0000000000000000000000000000000000000000')
  })

  test('passes both the branch and the ref being pushed', () => {
    const s = hookScript()
    expect(s).toContain('check --branch "$branch" --rev "$local_sha"')
  })

  test('finds cutver at run time, not at install time', () => {
    // A repository that adds cutver as a devDependency next month should get
    // the local copy without reinstalling the hook.
    const s = hookScript()
    expect(s).toContain('command -v cutver')
    expect(s).toContain('bunx cutver')
    // And when it is nowhere, the push goes through rather than failing on a
    // missing tool.
    expect(s).toContain('exit 0')
  })

  test('--runner pins it when you want it pinned', () => {
    expect(hookScript('bunx cutver@beta')).toContain('RUN="bunx cutver@beta"')
  })
})

describe('installHook', () => {
  test('writes an executable hook where git will find it', async () => {
    const root = await repo(['chore: init'])
    expect(await installHook(root)).toMatchObject({ state: 'written', detail: 'created' })

    const written = await Bun.file(`${root}/.git/hooks/${HOOK_NAME}`).text()
    expect(written).toContain(MARKER)

    if (process.platform !== 'win32') {
      const { out } = await run(['test', '-x', `${root}/.git/hooks/${HOOK_NAME}`], root)
      expect(out).toBe('')
    }
  })

  test('refuses to clobber a hook it did not write', async () => {
    // Silently overwriting someone's pre-push hook is how a repository loses a
    // guard it thinks it still has.
    const root = await repo(['chore: init'])
    await Bun.write(`${root}/.git/hooks/${HOOK_NAME}`, '#!/bin/sh\necho mine\n')

    expect(await installHook(root)).toMatchObject({ state: 'skipped' })
    expect(await Bun.file(`${root}/.git/hooks/${HOOK_NAME}`).text()).toContain('echo mine')

    expect(await installHook(root, { force: true })).toMatchObject({ state: 'written' })
    expect(await Bun.file(`${root}/.git/hooks/${HOOK_NAME}`).text()).toContain(MARKER)
  })

  test('replaces its own without ceremony', async () => {
    const root = await repo(['chore: init'])
    await installHook(root)
    expect(await installHook(root)).toMatchObject({ state: 'written', detail: 'replaced' })
  })

  test('honours core.hooksPath', async () => {
    // A repository that moved its hooks did it on purpose. Writing into
    // .git/hooks there installs a hook git never runs.
    const root = await repo(['chore: init'])
    await Bun.write(`${root}/myhooks/.keep`, '')
    await run(['git', 'config', 'core.hooksPath', 'myhooks'], root)

    await installHook(root)
    expect(await Bun.file(`${root}/myhooks/${HOOK_NAME}`).exists()).toBe(true)
    expect(await Bun.file(`${root}/.git/hooks/${HOOK_NAME}`).exists()).toBe(false)
  })

  test('a dry run writes nothing', async () => {
    const root = await repo(['chore: init'])
    expect(await installHook(root, { dryRun: true })).toMatchObject({ state: 'written' })
    expect(await Bun.file(`${root}/.git/hooks/${HOOK_NAME}`).exists()).toBe(false)
  })
})

describe('uninstallHook', () => {
  test('removes ours and leaves anyone else alone', async () => {
    const root = await repo(['chore: init'])
    expect(await uninstallHook(root)).toMatchObject({ state: 'skipped', detail: 'not installed' })

    await installHook(root)
    expect(await uninstallHook(root)).toMatchObject({ state: 'written', detail: 'removed' })
    expect(await Bun.file(`${root}/.git/hooks/${HOOK_NAME}`).exists()).toBe(false)

    await Bun.write(`${root}/.git/hooks/${HOOK_NAME}`, '#!/bin/sh\necho mine\n')
    expect(await uninstallHook(root)).toMatchObject({
      state: 'skipped',
      detail: 'not ours — left alone',
    })
  })
})
