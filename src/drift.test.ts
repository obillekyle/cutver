import { describe, expect, test } from 'bun:test'
import { channelOf, inspect, type Workflows } from './drift'
import { DEFAULT_CONFIG, type Config } from './config/schema'
import { initFiles } from './init'

/**
 * Drift between a config and the workflows it generated.
 *
 * Most of these assert **silence**, which is the harder half. A check that
 * fires on a repository doing its CI differently is worse than no check: it
 * refuses a release for a choice somebody made on purpose, and the only escape
 * is to stop using the tool.
 */

const generated = (config: Config = DEFAULT_CONFIG): Workflows => {
  const files = initFiles('bun', undefined, config)
  return {
    version: files.find(f => f.path.endsWith('version.yml'))?.contents ?? null,
    publish: files.find(f => f.path.endsWith('publish.yml'))?.contents ?? null,
  }
}

const withCanary = (over: Partial<Config> = {}): Config => ({
  ...DEFAULT_CONFIG,
  channels: { ...DEFAULT_CONFIG.channels, canary: ['canary'] },
  ...over,
})

describe('channelOf', () => {
  test('reads the channel out of a prerelease', () => {
    expect(channelOf('1.3.0-canary.0')).toBe('canary')
    expect(channelOf('1.3.0-my-prefix.12')).toBe('my-prefix')
  })

  test('a stable version has none', () => {
    expect(channelOf('1.3.0')).toBeNull()
  })

  test('a counter is required', () => {
    // `1.3.0-canary` is not a shape cutver produces, and matching it would
    // report drift for a version that will never be published.
    expect(channelOf('1.3.0-canary')).toBeNull()
  })
})

describe('inspect', () => {
  test('a freshly generated pair has no drift', () => {
    // The check has to be silent on its own output, or every `init` is followed
    // by a warning about the file it just wrote.
    expect(inspect(generated(), DEFAULT_CONFIG, '1.3.0')).toEqual([])
    expect(inspect(generated(), DEFAULT_CONFIG, '1.3.0-beta.0')).toEqual([])
  })

  test('no workflows at all is not drift', () => {
    // A repository releasing from a laptop, or from CI cutver never generated,
    // is a normal repository. Complaining would invent a requirement.
    expect(
      inspect({ version: null, publish: null }, withCanary(), '1.3.0-canary.0'),
    ).toEqual([])
  })

  test('refuses a channel the publish workflow cannot name', () => {
    // The one certainly-fatal case: the generated catch-all refuses an
    // unrecognised prerelease rather than defaulting it to `latest`, so this
    // dies *after* the tag and the release commit are public.
    const found = inspect(generated(), withCanary(), '1.3.0-canary.0')
    const refusal = found.find(d => d.level === 'refuse')

    expect(refusal).toBeTruthy()
    expect(refusal?.message).toContain('canary')
    expect(refusal?.message).toContain('already public')
    // And it names the fix rather than only the problem.
    expect(refusal?.message).toContain('*-canary.*)')
  })

  test('a channel not being released is a warning, not a refusal', () => {
    // Not this release's problem — which is exactly why it is worth saying now
    // rather than the day someone cuts one.
    const found = inspect(generated(), withCanary(), '1.3.0')
    expect(found.some(d => d.level === 'refuse')).toBe(false)
    expect(found.find(d => d.level === 'warn')?.message).toContain('canary')
  })

  test('an artifacts-only workflow has no dist-tag case to be missing', () => {
    // cargo defaults to artifacts, so there is no `case` and none is needed.
    // Refusing here would block every prerelease in every Rust workspace.
    const cargo = initFiles('cargo', undefined, withCanary({ target: 'cargo' }))
    const files: Workflows = {
      version: cargo[0]?.contents ?? null,
      publish: cargo[1]?.contents ?? null,
    }
    expect(
      inspect(files, withCanary({ target: 'cargo' }), '1.3.0-canary.0'),
    ).toEqual([])
  })

  test('warns when a tag should carry artifacts and the workflow builds none', () => {
    const config = {
      ...DEFAULT_CONFIG,
      artifacts: { folders: [], files: 'auto' as const },
    }
    // Generated for the registry, then the config changed under it.
    const found = inspect(generated(), config, '1.3.0')
    expect(found.some(d => d.message.includes('no binaries'))).toBe(true)
  })

  test('warns when the workflow predates `cutver notes`', () => {
    const config = {
      ...DEFAULT_CONFIG,
      changelog: {
        sections: ['feat'],
        keep: 10,
        prereleases: false,
        file: true,
        summarizer: null,
        prompt: null,
      },
    }
    // `gh release` is what says this workflow makes a release page at all — a
    // registry-only publish has no notes step because it has nothing to attach
    // one to, and warning there sent people looking for a job that never
    // existed.
    const stale: Workflows = {
      version: null,
      publish:
        'jobs:\n  release:\n    steps:\n      - run: awk …\n      - run: gh ' +
        'release create "$TAG"\n',
    }
    const found = inspect(stale, config, '1.3.0')
    expect(
      found.some(d => d.message.includes('extracts the release body itself')),
    ).toBe(true)
    // Every message hands over what to add. Telling someone to regenerate is
    // the one piece of advice that destroys a hand-maintained workflow, which
    // is the case this whole check exists to be safe around.
    expect(found.some(d => d.message.includes('cutver notes "$TAG"'))).toBe(
      true,
    )
  })

  describe('summarize is on with nothing to run it', () => {
    const on = (): Config => ({
      ...DEFAULT_CONFIG,
      changelog: {
        sections: ['feat'],
        keep: 10,
        prereleases: false,
        file: true,
        summarizer: true,
        prompt: null,
      },
    })

    test('warns, and hands over the setup', () => {
      // The failure this catches is a quiet one: the switch is on, no command
      // exists, and the release goes out with the notes as written — a correct
      // release, and therefore one nobody looks twice at.
      const found = inspect(generated(), on(), '1.3.0')
      const d = found.find(f => f.message.includes('CUTVER_SUMMARIZE'))
      expect(d).toBeDefined()
      expect(d?.level).toBe('warn')
      // Not a diagnosis — the actual lines to paste.
      expect(d?.message).toContain('summarizer:')
      expect(d?.message).toContain('connector: gemini')
      // And where the key goes, since the one place it must not go is the file
      // this message is telling them to edit.
      expect(d?.message).toContain('CUTVER_SUMMARIZE_KEY')
    })

    test('silent when a connector is configured', () => {
      // The config names a provider, so nothing is missing — warning here would
      // fire on every correctly-configured repository.
      const withConnector: Config = {
        ...on(),
        // `artifacts` because that is the job that creates the GitHub release,
        // and therefore the only one with a notes step to find.
        publish: true,
        artifacts: { folders: [], files: 'auto' as const },
        changelog: {
          ...on().changelog!,
          summarizer: {
            connector: 'gemini',
            model: 'gemini-3.5-flash',
            baseUrl: null,
            retry: null,
            withBody: true,
          },
        },
      }
      // Generated *from that config*, so the workflow carries the notes step —
      // `generated()` on its own builds from the default, where `changelog` is
      // null and there is no step to find.
      expect(inspect(generated(withConnector), withConnector, '1.3.0')).toEqual(
        [],
      )
    })

    test('the seam `init` writes does not count as a command', () => {
      // `init` writes `CUTVER_SUMMARIZE: ''` so the comment explaining it has
      // somewhere to live, so the key being present proves nothing.
      for (const value of ["''", '""', '']) {
        const publish = `        env:\n          CUTVER_SUMMARIZE: ${value}\n        run: cutver notes "$TAG" > notes.md\n`
        expect(inspect({ version: null, publish }, on(), '1.3.0').length).toBe(
          1,
        )
      }
    })

    test('silent once a command is set', () => {
      const publish = `        env:\n          CUTVER_SUMMARIZE: my-summariser --stdin\n        run: cutver notes "$TAG" > notes.md\n`
      expect(inspect({ version: null, publish }, on(), '1.3.0')).toEqual([])
    })

    test('silent when the switch is off', () => {
      // Nothing was asked for, so a missing command is not a finding.
      expect(inspect(generated(), DEFAULT_CONFIG, '1.3.0')).toEqual([])
    })

    test('never refuses a release over a missing model', () => {
      // Notes as written were always the fallback and are always publishable.
      // Refusing here would make inference the most load-bearing thing in the
      // pipeline, which is the opposite of how it is wired everywhere else.
      const found = inspect(
        { version: null, publish: 'run: cutver notes "$TAG" > notes.md' },
        on(),
        '1.3.0',
      )
      expect(found.every(d => d.level === 'warn')).toBe(true)
    })
  })

  test('no message tells anyone to regenerate', () => {
    // `cutver init --force` flattens a workflow someone has been editing for a
    // year — and for a repository whose publish.yml is named in npm's
    // trusted-publisher configuration, regenerating it breaks publishing
    // outright. Every finding gives the lines to paste instead.
    const found = [
      ...inspect(generated(), withCanary(), '1.3.0-canary.0'),
      ...inspect(generated(), withCanary(), '1.3.0'),
      ...inspect(
        generated(),
        {
          ...DEFAULT_CONFIG,
          artifacts: { folders: [], files: 'auto' as const },
        },
        '1.3.0',
      ),
    ]

    expect(found.length).toBeGreaterThan(0)
    for (const d of found) expect(d.message, d.message).not.toContain('--force')
  })

  test('every finding carries a docs link', () => {
    // The pasted lines fix this occurrence; the page is what stops the next
    // person hitting the same thing for a different reason and pasting the
    // wrong fix.
    const found = [
      ...inspect(generated(), withCanary(), '1.3.0-canary.0'),
      ...inspect(generated(), withCanary(), '1.3.0'),
      ...inspect(
        generated(),
        {
          ...DEFAULT_CONFIG,
          artifacts: { folders: [], files: 'auto' as const },
        },
        '1.3.0',
      ),
    ]

    expect(found.length).toBeGreaterThan(0)
    for (const d of found)
      expect(d.docs, d.message).toStartWith('https://cutver.okyle.dev/')
  })

  test('warns about a branch the version workflow will never fire on', () => {
    const found = inspect(generated(), withCanary(), '1.3.0')
    expect(found.some(d => d.message.includes('does not trigger'))).toBe(true)
  })
})

/**
 * The pre-2.0 invocation, and why one of these is not like the other.
 *
 * Both shapes appear in real repositories, and only one of them is broken.
 * Reporting them at the same level made `cutver doctor` say "nothing wrong
 * here" about a release workflow that could not release — measured against two
 * projects, both one push away from it.
 */
describe('a workflow that calls cutver the pre-2.0 way', () => {
  const withVersion = (yml: string): Workflows => ({
    version: yml,
    publish: null,
  })

  test('refuses when nothing pins an older cutver', () => {
    // `bunx cutver` resolves whatever is current, so the bare invocation there
    // is a step that exits 1 having released nothing.
    const found = inspect(
      withVersion('- run: bunx cutver --if-needed --branch main\n'),
      DEFAULT_CONFIG,
      '1.3.0',
    )
    const hit = found.find(d => d.message.includes('pre-2.0 shape'))

    expect(hit?.level).toBe('refuse')
  })

  test('only warns when the workflow pins cutver 1.x', () => {
    // Fetching a pinned v1 executable and calling it the v1 way is internally
    // consistent. It is frozen, not broken, and failing a release over it
    // would be this tool complaining about a version it is not running.
    const found = inspect(
      withVersion(
        'curl -fsSL -o /usr/local/bin/cutver \\n' +
          '  https://github.com/o/r/releases/download/v1.1.0/cutver-linux-x64\n' +
          '- run: cutver --if-needed --branch main\n',
      ),
      DEFAULT_CONFIG,
      '1.3.0',
    )
    const hit = found.find(d => d.message.includes('pins cutver 1.x'))

    expect(hit?.level).toBe('warn')
    expect(found.some(d => d.level === 'refuse')).toBe(false)
  })

  test('refuses when the pin is 2.x, where the shape is simply wrong', () => {
    const found = inspect(
      withVersion(
        'curl -o cutver https://github.com/o/r/releases/download/v2.0.2/cutver-linux-x64\n' +
          '- run: cutver --if-needed\n',
      ),
      DEFAULT_CONFIG,
      '1.3.0',
    )

    expect(found.find(d => d.message.includes('pre-2.0 shape'))?.level).toBe(
      'refuse',
    )
  })

  test('says nothing about a workflow that already uses `stage`', () => {
    const found = inspect(
      withVersion("- run: bunx cutver stage --if-needed --branch 'main'\n"),
      DEFAULT_CONFIG,
      '1.3.0',
    )

    expect(found.some(d => d.message.includes('pre-2.0'))).toBe(false)
  })
})
