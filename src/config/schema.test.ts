import { describe, expect, test } from 'bun:test'
import { parseConfig } from './load'
import {
  ConfigError,
  ECOSYSTEMS,
  producesArtifacts,
  PUBLISH_TARGETS,
  publishesToRegistry,
  RELEASE,
  SCHEMA_VERSION,
} from './schema'
import { SECTIONS } from '../changelog/notes'

/**
 * The published JSON Schema, held to the loader.
 *
 * `docs/cutver.schema.json` is served — it is what `$schema` points at, and the
 * only reason [the config reference](../../docs/reference/config.md) offers
 * JSON as an alternative to YAML. Nothing imports it, so nothing would notice
 * it going stale: add an ecosystem, bump `SCHEMA_VERSION`, loosen a channel
 * name, and every editor keeps validating against last year's rules while the
 * loader has moved on. Red squiggles under a config that runs fine are worse
 * than no completion at all, and the reverse — a file the editor blesses and
 * cutver refuses — is worse still.
 *
 * So the two are compared directly. The channel-name case is a grid rather than
 * an assertion about the regex, because what matters is that the pattern and
 * `parseChannels` reach the same verdict, not that they are spelled alike.
 */

const schema = await Bun.file(
  new URL('../../docs/cutver.schema.json', import.meta.url),
).json()

/** Whether `parseChannels` accepts a key, reached through the real entry point. */
function loaderAccepts(key: string): boolean {
  try {
    parseConfig({ channels: { [key]: ['x'] } }, 'test')
    return true
  } catch (e) {
    if (e instanceof ConfigError) return false
    throw e
  }
}

/** Whether the published schema accepts a key under `channels`. */
function schemaAccepts(key: string): boolean {
  const channels = schema.properties.channels
  if (Object.hasOwn(channels.properties, key)) return true
  return Object.keys(channels.patternProperties).some(p =>
    new RegExp(p).test(key),
  )
}

describe('docs/cutver.schema.json', () => {
  test('is served from where $schema points', async () => {
    // Pages publishes `docs/` as the site root, so the file has to live there
    // rather than at the repository root — the URL in the reference page is the
    // spec, and a schema one directory up is a 404 nobody sees until an editor
    // silently stops completing.
    expect(schema.$id).toBe('https://cutver.okyle.dev/cutver.schema.json')

    const reference = await Bun.file(
      new URL('../../docs/reference/config.md', import.meta.url),
    ).text()
    expect(reference).toContain(schema.$id)
  })

  test('allows exactly the top-level keys the loader does', () => {
    const declared = Object.keys(schema.properties).sort()
    expect(schema.additionalProperties).toBe(false)
    expect(declared).toEqual([
      '$schema',
      'artifacts',
      'changelog',
      'channels',
      'publish',
      'schema',
      'summarizer',
      'target',
    ])
  })

  test('offers exactly the changelog sections that exist', () => {
    expect([...schema.$defs.sections.items.enum].sort()).toEqual(
      Object.keys(SECTIONS).sort(),
    )

    // The boolean shorthand is the one people reach for first, so the schema
    // has to bless it or an editor underlines a config that runs.
    expect(() => parseConfig({ changelog: true }, 'test')).not.toThrow()
    expect(() => parseConfig({ changelog: false }, 'test')).not.toThrow()
    expect(() =>
      parseConfig({ changelog: ['feat', 'fix'] }, 'test'),
    ).not.toThrow()
    expect(() => parseConfig({ changelog: ['nope'] }, 'test')).toThrow(
      ConfigError,
    )
    expect(() =>
      parseConfig({ changelog: { sections: ['feat'], keep: 5 } }, 'test'),
    ).not.toThrow()
    expect(() => parseConfig({ changelog: { keep: -1 } }, 'test')).toThrow(
      ConfigError,
    )
    expect(() => parseConfig({ changelog: { nope: 1 } }, 'test')).toThrow(
      ConfigError,
    )
  })

  test('offers both shapes of `publish`, and the targets the old one took', () => {
    // **This assertion was `oneOf ? true : type`, which is true either way.**
    // It was weakened rather than rewritten when `publish` became a boolean,
    // and a check that cannot fail is worse than none: it reads as coverage.
    // What matters is that the schema offers exactly the two shapes the loader
    // takes — the boolean, and the pre-2.0 list it still accepts.
    const shapes = schema.properties.publish.oneOf as { type?: string }[]
    expect(shapes.map(s => s.type).sort()).toEqual(['array', 'boolean'])

    const list = shapes.find(s => s.type === 'array') as {
      items: { enum: string[] }
    }
    expect([...list.items.enum].sort()).toEqual([...PUBLISH_TARGETS].sort())

    // And agrees with the loader on what it refuses, which is where a schema
    // and a parser usually drift apart.
    expect(() => parseConfig({ publish: true }, 'test')).not.toThrow()
    expect(() => parseConfig({ publish: false }, 'test')).not.toThrow()
    expect(() => parseConfig({ publish: ['registry'] }, 'test')).not.toThrow()
    expect(() => parseConfig({ publish: [] }, 'test')).not.toThrow()
    expect(() => parseConfig({ publish: ['crates'] }, 'test')).toThrow(
      ConfigError,
    )
    expect(() => parseConfig({ publish: 'registry' }, 'test')).toThrow(
      ConfigError,
    )
  })

  test('offers the shapes of `artifacts`, and no key the loader dropped', () => {
    const shapes = schema.properties.artifacts.oneOf as {
      type?: string
      const?: string
    }[]
    // `false`, `auto`, or a mapping — the three the loader takes.
    expect(shapes.map(s => s.const ?? s.type).sort()).toEqual([
      'auto',
      'boolean',
      'object',
    ])

    const mapping = shapes.find(s => s.type === 'object') as {
      properties: Record<string, unknown>
    }
    // `enabled` was removed because writing the block is the opt-in and
    // `artifacts: false` is the refusal. An editor still offering it would
    // complete a key that fails to load.
    expect(Object.keys(mapping.properties).sort()).toEqual(['files', 'folders'])
    expect(() => parseConfig({ artifacts: { enabled: true } }, 'test')).toThrow(
      ConfigError,
    )

    expect(() => parseConfig({ artifacts: false }, 'test')).not.toThrow()
    expect(() => parseConfig({ artifacts: 'auto' }, 'test')).not.toThrow()
    expect(() =>
      parseConfig({ artifacts: { files: ['dist/app'] } }, 'test'),
    ).not.toThrow()
  })

  test('offers every `changelog` key the loader accepts', () => {
    // **The gap that let `changelog.file` go missing.** The top-level keys are
    // pinned above and `artifacts`' are pinned beside this; nothing pinned
    // `changelog`'s. So `file` shipped real, load-bearing at `stage.ts` and
    // `commands.ts`, undocumented — and *rejected by this schema*, which sets
    // `additionalProperties: false`. A valid config got a red squiggle from the
    // editor completion the docs advertise.
    //
    // Asserted by round-tripping each key through the real loader rather than
    // against a second list: a list here would be the third copy of the same
    // thing, which is the shape of the original bug.
    const shapes = schema.properties.changelog.oneOf as {
      type?: string
      properties?: Record<string, unknown>
    }[]
    const mapping = shapes.find(s => s.type === 'object') as {
      properties: Record<string, unknown>
    }

    for (const key of Object.keys(mapping.properties)) {
      expect(
        () => parseConfig({ changelog: { [key]: undefined } }, 'test'),
        `schema offers \`changelog.${key}\`, loader rejects it`,
      ).not.toThrow(/unknown key/)
    }

    // And the direction that actually failed: a key the loader takes must be
    // offered. `summarize` is excluded — it parses, and it is the pre-2.0
    // spelling nothing should complete to.
    for (const key of ['sections', 'keep', 'prereleases', 'file', 'prompt']) {
      expect(
        Object.keys(mapping.properties),
        `loader accepts \`changelog.${key}\`, schema does not offer it`,
      ).toContain(key)
    }
  })

  test('caps `schema` at the version this build understands', () => {
    expect(schema.properties.schema.maximum).toBe(SCHEMA_VERSION)
    expect(() => parseConfig({ schema: SCHEMA_VERSION + 1 }, 'test')).toThrow(
      ConfigError,
    )
  })

  test('offers exactly the ecosystems that exist', () => {
    expect([...schema.properties.target.enum].sort()).toEqual(
      [...ECOSYSTEMS].sort(),
    )
  })

  test('names the reserved stable channel', () => {
    expect(Object.keys(schema.properties.channels.properties)).toEqual([
      RELEASE,
    ])
  })

  test('agrees with the loader on every channel name', () => {
    const names = [
      // Accepted, one shape each.
      'beta',
      'canary',
      'my-prefix',
      'myPrefix',
      'MyPrefix',
      'my_prefix',
      'my prefix',
      'HTTPServer',
      RELEASE,
      // Refused. The digits are the interesting half: `rc2` and `v2-latest`
      // are legal npm dist-tags and legal semver, and both freeze the counter.
      'rc2',
      'v2-latest',
      'beta.1',
      'beta/next',
      '',
      '-beta',
      'beta-',
    ]

    for (const name of names) {
      expect(schemaAccepts(name), `channels.${name || '<empty>'}`).toBe(
        loaderAccepts(name),
      )
    }
  })
})

describe('artifacts', () => {
  const cfg = (artifacts: unknown) =>
    parseConfig({ schema: 1, target: 'bun', artifacts }, 'cutver.yml')

  test('writing the block is the opt-in, and it beats `publish`', () => {
    // The more specific statement wins, the way `--adapter` beats `target:`.
    // A repository whose `publish` predates the block should not have to edit
    // two places to turn binaries on.
    const on = parseConfig(
      { schema: 1, target: 'bun', artifacts: { files: ['dist/app'] } },
      'cutver.yml',
    )
    expect(producesArtifacts('js', on)).toBe(true)

    const off = parseConfig(
      {
        schema: 1,
        target: 'bun',
        publish: ['registry', 'artifacts'],
        artifacts: false,
      },
      'cutver.yml',
    )
    expect(producesArtifacts('js', off)).toBe(false)
    expect(publishesToRegistry('js', off)).toBe(true)
  })

  test('no block at all leaves `publish` deciding alone', () => {
    // The zero-config promise: adding this feature must not change what a
    // repository that never mentions it produces.
    const bare = parseConfig({ schema: 1, target: 'bun' }, 'cutver.yml')
    expect(publishesToRegistry('js', bare)).toBe(true)
    expect(producesArtifacts('js', bare)).toBe(false)
    expect(producesArtifacts('cargo', bare)).toBe(true)
    expect(publishesToRegistry('cargo', bare)).toBe(false)
  })

  test('a path that leaves the repository is refused', () => {
    // These are interpolated into a shell script that runs in CI holding a
    // write token, so an escape is refused at load rather than discovered as a
    // `tar` reading somewhere it should not.
    expect(() => cfg({ files: ['/etc/passwd'] })).toThrow(/absolute path/)
    expect(() => cfg({ files: ['C:/Windows/system32/cmd.exe'] })).toThrow(
      /absolute path/,
    )
    expect(() => cfg({ folders: ['../../secrets'] })).toThrow(/climbs out/)
  })

  test('the shorthands: false, auto, and a mapping naming nothing', () => {
    // Enabled and naming nothing means `auto` — the only honest reading, and
    // the same thing a bare `artifacts: auto` says.
    expect(cfg({}).artifacts).toEqual({ folders: [], files: 'auto' })
    expect(cfg('auto').artifacts).toEqual({ folders: [], files: 'auto' })
    expect(cfg(false).artifacts).toEqual(false)
    // Off with no paths is fine — that is how you turn it off without deleting
    // the list you spent time getting right.
    expect(cfg(false).artifacts).toEqual(false)
  })

  test('the usual shape errors', () => {
    expect(() => cfg(['dist'])).toThrow(/mapping/)
    expect(() => cfg({ folder: ['dist'] })).toThrow(
      /unknown key `artifacts.folder`/,
    )
    expect(() => cfg({ enabled: true })).toThrow(
      /unknown key `artifacts.enabled`/,
    )
    expect(() => cfg({ files: 'dist/app' })).toThrow(/list of paths/)
    expect(() => cfg({ files: ['  '] })).toThrow(/empty entry/)
  })
})
