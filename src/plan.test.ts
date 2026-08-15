import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { plan, PlanRefusal } from './plan'
import { matchBranch } from './config/match'
import { DEFAULT_CONFIG } from './config/schema'
import { versionFromBranch } from './version-from-commits'
import { run } from './run'

const made: string[] = []

afterEach(async () => {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true })
})

/**
 * A throwaway repository with a real history.
 *
 * Real git rather than a stubbed log, because the thing under test is
 * partly *which* commits git is asked for — the range, the tag filter, the
 * `--merged HEAD`. A fake log would agree with whatever the code asked for.
 *
 * `entries` are `subject` or `subject@tag`: the tag is applied after that
 * commit lands.
 */
async function repo(entries: string[]): Promise<string> {
  const dir = (await mkdtemp(`${tmpdir()}/cutver-plan-`)).replaceAll('\\', '/')
  made.push(dir)

  await run(['git', 'init', '-q', '-b', 'main'], dir)
  // Local to the fixture. CI runners have no identity configured and `git
  // commit` refuses without one.
  await run(['git', 'config', 'user.email', 'fixture@example.invalid'], dir)
  await run(['git', 'config', 'user.name', 'fixture'], dir)

  for (const entry of entries) {
    const [subject = '', tag] = entry.split('@')
    // Empty commits: nothing under test reads a file, only `git log` and
    // `git tag`. Writing one and staging it cost an extra spawn and an extra
    // write per commit — around 20% of a fixture, and these fixtures are most
    // of the suite's runtime.
    await run(['git', 'commit', '-q', '--allow-empty', '-m', subject], dir)
    if (tag) await run(['git', 'tag', tag], dir)
  }

  return dir
}

const at = (root: string, current: string, branch = 'main') =>
  plan({ root, current, branch, channel: null })

describe('with no tags at all', () => {
  test('measures from the manifest, not from 0.0.0', async () => {
    // **The deviation from the script this was extracted from, and why.** That
    // repository has been tagged since its first release, so its `0.0.0`
    // fallback never ran. Pointed at a repository with zero tags — which is
    // exactly the case this tool was extracted to serve — `0.0.0` computes
    // `0.1.0` for a minor: the version the manifest already says, so the tool
    // reports "nothing to release" across the entire history.
    const root = await repo(['chore: init', 'feat: sync engine', 'fix: a race'])
    expect(await at(root, '0.1.0')).toMatchObject({ kind: 'release', version: '0.2.0' })
  })

  test('a patch does not go backwards', async () => {
    // The same fallback in its uglier direction: from 0.0.0 a patch computes
    // 0.0.1, which is *lower* than the version in the manifest and which the
    // semver check would happily accept.
    const root = await repo(['chore: init', 'fix: a race'])
    expect(await at(root, '0.1.0')).toMatchObject({ kind: 'release', version: '0.1.1' })
  })

  test('reports the range it measured as the first commit', async () => {
    const root = await repo(['feat: one', 'feat: two'])
    const p = await at(root, '1.0.0')
    expect(p.survey).toMatchObject({ since: 'the first commit', total: 2 })
  })
})

describe('with a stable tag', () => {
  test('measures from the tag, not from the manifest', async () => {
    const root = await repo(['feat: one@v1.0.0', 'fix: two'])
    expect(await at(root, '1.0.0')).toMatchObject({ kind: 'release', version: '1.0.1' })
  })

  test('ignores prerelease tags when choosing the baseline', async () => {
    // `git describe --abbrev=0` would hand back v1.1.0-beta.0 here, and
    // measuring the breaking commit from there ships it as a minor.
    const root = await repo([
      'feat: one@v1.0.0',
      'feat: two@v1.1.0-beta.0',
      'refactor!: rip out the old API',
    ])
    const p = await at(root, '1.1.0-beta.0')
    expect(p).toMatchObject({ kind: 'release', version: '2.0.0' })
    // `since` names the new-work range, which starts at the last release of
    // any kind; the base is reported separately and is the stable one. The
    // number is the guarantee — 2.0.0, not 1.1.0.
    expect(p.survey?.since).toBe('v1.1.0-beta.0')
    expect(p.survey?.base?.since).toBe('v1.0.0')
  })

  test('nothing to release when the range holds only housekeeping', async () => {
    const root = await repo(['feat: one@v1.0.0', 'docs: notes', 'chore: tidy'])
    expect(await at(root, '1.0.0')).toMatchObject({ kind: 'nothing' })
  })

  test('nothing to release when the computed version is the one already written', async () => {
    // The CI race this guards: a bump commit is itself a push, so the workflow
    // re-triggers, recomputes the same number from the same commits, and would
    // otherwise "release" a version that is already in the manifests — then
    // fail trying to create a tag that exists. Guarding on the version rather
    // than on a clean tree also makes it immune to unrelated dirt, which is
    // what CI was really tripping over.
    const root = await repo(['feat: one@v1.0.0', 'feat: two'])
    expect(await at(root, '1.1.0')).toMatchObject({
      kind: 'nothing',
      why: '1.1.0 is already the current version',
    })
  })
})

describe('a prerelease already tagged', () => {
  test('a docs-only push since the last prerelease releases nothing', async () => {
    // **The waste this exists to stop.** The range since the last *stable* tag
    // still holds every `feat:` the beta branch was opened for, so without a
    // second range a docs commit looks exactly like new work — and a
    // long-lived release branch spends a beta number on every push forever.
    const root = await repo([
      'feat: one@v1.0.0',
      'feat: two',
      'chore(release): v1.1.0-beta.0@v1.1.0-beta.0',
      'docs: write it all down',
    ])
    expect(await at(root, '1.1.0-beta.0', '1.1.0-beta')).toMatchObject({
      kind: 'nothing',
      why: 'no feat/fix/perf or breaking commit since v1.1.0-beta.0',
    })
  })

  test('a real commit since it does release, and the base still comes from stable', async () => {
    // The half that must survive: the base is measured from v1.0.0, not from
    // the beta tag, so the `feat!` buried in the beta still majors. Measuring
    // both questions from the prerelease is exactly the bug where a breaking
    // change ships as a minor.
    const root = await repo([
      'feat: one@v1.0.0',
      'feat!: the world moved',
      'chore(release): v2.0.0-beta.0@v2.0.0-beta.0',
      'fix: a small thing',
    ])
    const p = await at(root, '2.0.0-beta.0', '2.0.0-beta')

    expect(p).toMatchObject({ kind: 'release', version: '2.0.0-beta.1' })
    // What is *new* is one patch; what set the base is a major, from earlier.
    expect(p.survey?.since).toBe('v2.0.0-beta.0')
    expect(p.survey?.tally).toEqual([{ level: 'patch', subjects: ['fix: a small thing'] }])
    expect(p.survey?.base).toMatchObject({ since: 'v1.0.0', bump: 'major' })
  })

  test('graduating still measures the base from the last stable release', async () => {
    const root = await repo([
      'feat: one@v1.0.0',
      'feat: two',
      'chore(release): v1.1.0-beta.0@v1.1.0-beta.0',
      'fix: last one',
    ])
    // No branch declaration, no channel: the beta graduates to the base it was
    // for — 1.1.0 — rather than to 1.0.1 from the patch alone.
    expect(await at(root, '1.1.0-beta.0')).toMatchObject({ version: '1.1.0' })
  })

  test('a prerelease tag does not read as newer than its own release', async () => {
    // `git tag --sort=-v:refname` puts v1.1.0-beta.0 *after* v1.1.0 unless
    // `versionsort.suffix` is set, which nobody sets. Picking the wrong "last
    // release" here would measure the new-work range from before the stable
    // tag and cut a release for commits already shipped in it.
    const root = await repo([
      'feat: one@v1.0.0',
      'feat: two@v1.1.0-beta.0',
      'chore(release): v1.1.0@v1.1.0',
      'docs: nothing releasable',
    ])
    expect(await at(root, '1.1.0')).toMatchObject({
      kind: 'nothing',
      why: 'no feat/fix/perf or breaking commit since v1.1.0',
    })
  })
})

describe('branch-declared versions', () => {
  test('a release branch names the base and the channel', async () => {
    const root = await repo(['feat: one@v1.0.0', 'feat: two'])
    expect(await at(root, '1.0.0', '1.1.0-beta')).toMatchObject({
      kind: 'release',
      version: '1.1.0-beta.0',
    })
  })

  test('the counter continues from the manifest, not from the branch name', async () => {
    const root = await repo(['feat: one@v1.0.0', 'feat: two'])
    expect(await at(root, '1.1.0-beta.2', '1.1.0-beta')).toMatchObject({
      version: '1.1.0-beta.3',
    })
  })

  test('does not refuse when nothing stable has ever been tagged', async () => {
    // The regression that cost a red CI run on cutver's own first branch
    // build. With no tag the baseline comes from the manifest, and on a
    // release branch the manifest is a prerelease *of the base the branch
    // declares* — so 0.1.0-beta.0 infers a baseline of 0.1.0, and the commits
    // that justify 0.1.0 are counted again on top of it. The refusal then
    // fires against a number nothing ever published, and its advice ("rename
    // to 0.2.0-beta") would skip 0.1.0 altogether.
    const root = await repo(['feat: one', 'feat: two'])
    expect(await at(root, '0.1.0-beta.0', '0.1.0-beta')).toMatchObject({
      kind: 'release',
      version: '0.1.0-beta.1',
    })
  })

  test('opens the channel at .0 from a stable manifest with no tags', async () => {
    const root = await repo(['feat: one', 'feat: two'])
    expect(await at(root, '0.0.0', '0.1.0-beta')).toMatchObject({
      version: '0.1.0-beta.0',
    })
  })

  test('refuses when the commits imply a higher base than the branch declares', async () => {
    // Publishing 1.1.0 here would ship a breaking change as a minor. A warning
    // would scroll past in a CI log and the wrong version would go out anyway.
    const root = await repo(['feat: one@v1.0.0', 'feat!: the world moved'])
    await expect(at(root, '1.1.0-beta.0', '1.1.0-beta')).rejects.toThrow(/declares 1\.1\.0.*2\.0\.0/s)
  })
})

describe('a branch that names only a channel', () => {
  test('`beta` cuts a beta with the base computed from the commits', async () => {
    const root = await repo(['feat: one@v1.2.0', 'feat: two'])
    expect(await at(root, '1.2.0', 'beta')).toMatchObject({
      kind: 'release',
      version: '1.3.0-beta.0',
      why: "minor, beta from branch 'beta'",
    })
  })

  test('alpha and rc too, and release/beta for symmetry', async () => {
    const root = await repo(['feat: one@v1.2.0', 'fix: two'])
    expect((await at(root, '1.2.0', 'alpha')) as { version: string }).toMatchObject({
      version: '1.2.1-alpha.0',
    })
    expect((await at(root, '1.2.0', 'rc')) as { version: string }).toMatchObject({
      version: '1.2.1-rc.0',
    })
    expect((await at(root, '1.2.0', 'release/beta')) as { version: string }).toMatchObject({
      version: '1.2.1-beta.0',
    })
  })

  test('the counter continues while the base holds', async () => {
    const root = await repo(['feat: one@v1.2.0', 'feat: two@v1.3.0-beta.0', 'fix: three'])
    expect(await at(root, '1.3.0-beta.0', 'beta')).toMatchObject({ version: '1.3.0-beta.1' })
  })

  test('a break re-bases and restarts the counter, with nothing to rename', async () => {
    // **The reason this branch shape exists.** On `1.3.0-beta` this same
    // history is refused outright — the name promises 1.3.0 and the commits
    // have outgrown it — and the fix is to rename the branch mid-flight. A
    // branch called `beta` promises only the channel, so the base moves on its
    // own and the counter restarts because the base changed.
    const root = await repo([
      'feat: one@v1.2.0',
      'feat: two@v1.3.0-beta.0',
      'feat!: the world moved',
    ])
    await expect(await at(root, '1.3.0-beta.0', 'beta')).toMatchObject({ version: '2.0.0-beta.0' })

    // The versioned form, for contrast, refuses.
    await expect(at(root, '1.3.0-beta.0', '1.3.0-beta')).rejects.toBeInstanceOf(PlanRefusal)
  })

  test('a flag typed now beats a branch named months ago', async () => {
    const root = await repo(['feat: one@v1.2.0', 'feat: two'])
    expect(
      await plan({ root, current: '1.2.0', branch: 'beta', channel: 'rc' }),
    ).toMatchObject({ version: '1.3.0-rc.0', why: 'minor, rc' })
  })

  test('a branch that merely contains a channel word is an ordinary branch', async () => {
    // `feat/beta-ui` is not a release channel, and a tool that guessed
    // otherwise would start publishing prereleases off a feature branch.
    const root = await repo(['feat: one@v1.2.0', 'feat: two'])
    for (const name of ['beta-two', 'my-beta', 'betas', 'feat/beta-ui', 'alpha/x']) {
      expect((await at(root, '1.2.0', name)) as { version: string }, name).toMatchObject({
        version: '1.3.0',
      })
    }
  })

  test('`prerelease` is the same channel as `rc`, spelled the way people write it', async () => {
    // It reads as a category rather than a channel, and plenty of projects
    // name the branch that. **The version string stays canonical** — `-rc.N`,
    // never `-prerelease.N` — because the dist-tag is derived from the version
    // and a fourth spelling in there is a channel no registry has heard of.
    const root = await repo(['feat: one@v1.2.0', 'fix: two'])
    expect(await at(root, '1.2.0', 'prerelease')).toMatchObject({ version: '1.2.1-rc.0' })
    expect((await at(root, '1.2.0', 'release/prerelease')) as { version: string }).toMatchObject({
      version: '1.2.1-rc.0',
    })
  })

  test('and works in the versioned branch shape too', async () => {
    const root = await repo(['feat: one@v1.2.0', 'fix: two'])
    expect(await at(root, '1.2.0', '1.2.1-prerelease')).toMatchObject({
      version: '1.2.1-rc.0',
      // The message quotes the branch that actually exists, not the rewrite.
      why: "declared by branch '1.2.1-prerelease'",
    })
  })

  test('the alias cannot eat an ordinary branch', async () => {
    const root = await repo(['feat: one@v1.2.0', 'feat: two'])
    for (const name of ['prereleases', 'my-prerelease', 'prerelease/x']) {
      expect((await at(root, '1.2.0', name)) as { version: string }, name).toMatchObject({
        version: '1.3.0',
      })
    }
    const channelOf = (b: string) => {
      const m = matchBranch(b, DEFAULT_CONFIG)
      return m.kind === 'channel' ? m.channel : null
    }
    expect(channelOf('prereleases')).toBeNull()
    expect(channelOf('my-prerelease')).toBeNull()
    expect(channelOf('prerelease')).toBe('rc')
    expect(channelOf('1.2.0-prerelease')).toBe('rc')
  })

  test('the ported versionFromBranch still declares nothing for it', () => {
    // `versionFromBranch` answers "what version does this name declare", and
    // for `beta` that is still none — a ported test pins it. The config answers
    // a different question, so the two disagree deliberately.
    expect(versionFromBranch('beta')).toBeNull()

    const bare = matchBranch('beta', DEFAULT_CONFIG)
    expect(bare).toMatchObject({ kind: 'channel', channel: 'beta', declared: null })

    const versioned = matchBranch('1.3.0-beta', DEFAULT_CONFIG)
    expect(versioned).toMatchObject({ channel: 'beta', declared: '1.3.0' })
  })
})

describe('an explicit version', () => {
  test('wins over the computation, without consulting git', async () => {
    const root = await repo(['docs: nothing releasable'])
    expect(
      await plan({ root, current: '1.0.0', branch: 'main', channel: null, explicit: '3.0.0' }),
    ).toMatchObject({ kind: 'release', version: '3.0.0', why: 'given explicitly' })
  })

  test('except when it is the version already in the manifests', async () => {
    const root = await repo(['feat: one'])
    expect(
      await plan({ root, current: '1.0.0', branch: 'main', channel: null, explicit: '1.0.0' }),
    ).toMatchObject({ kind: 'nothing' })
  })
})

describe('a repository with a config', () => {
  const withChannels = (channels: Record<string, string[]>) => ({
    ...DEFAULT_CONFIG,
    channels: { ...DEFAULT_CONFIG.channels, ...channels },
    source: 'cutver.json',
  })

  test('an arbitrary branch cuts a prerelease — the whole point', async () => {
    const root = await repo(['feat: one@v1.2.0', 'feat: two'])
    const config = withChannels({ beta: ['develop'] })

    expect(await plan({ root, current: '1.2.0', branch: 'develop', channel: null, config })).toMatchObject({
      version: '1.3.0-beta.0',
      why: "minor, beta from branch 'develop'",
    })
  })

  test('a custom channel counts up, which the ported Channel type forbids', async () => {
    // The frozen-counter trap: a channel outside [a-z]+ would compute `.0`
    // forever and then report "nothing to release". `canary` is legal, so it
    // must actually advance.
    const root = await repo(['feat: one@v1.2.0', 'feat: two'])
    const config = withChannels({ canary: ['canary', 'nightly/*'] })

    expect(await plan({ root, current: '1.2.0', branch: 'canary', channel: null, config })).toMatchObject({
      version: '1.3.0-canary.0',
    })
    expect(
      await plan({ root, current: '1.3.0-canary.0', branch: 'nightly/x', channel: null, config }),
    ).toMatchObject({ version: '1.3.0-canary.1' })
  })

  test('a branch matching nothing is `no-rule`, not a refusal', async () => {
    // Load-bearing: a refusal here exits 1 from `cutver check`, which the
    // pre-push hook runs on every branch of every push — it would block every
    // feature branch in the repository.
    const root = await repo(['feat: one@v1.2.0', 'feat: two'])
    const config = withChannels({ release: ['main'], beta: ['develop'] })

    const decision = await plan({ root, current: '1.2.0', branch: 'feat/login', channel: null, config })
    expect(decision.kind).toBe('no-rule')
    expect(decision.why).toContain('matches no channel and no release rule')
  })

  test('the declared-base refusal still fires under a config', async () => {
    const root = await repo(['feat: one@v1.2.0', 'feat!: the world moved'])
    const config = withChannels({ beta: ['{version}-beta'] })

    await expect(
      plan({ root, current: '1.3.0-beta.0', branch: '1.3.0-beta', channel: null, config }),
    ).rejects.toBeInstanceOf(PlanRefusal)
  })

  test('a flag still beats the branch', async () => {
    const root = await repo(['feat: one@v1.2.0', 'feat: two'])
    const config = withChannels({ beta: ['develop'], canary: ['canary'] })

    expect(
      await plan({ root, current: '1.2.0', branch: 'develop', channel: 'canary', config }),
    ).toMatchObject({ version: '1.3.0-canary.0', why: 'minor, canary' })
  })
})
