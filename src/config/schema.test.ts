import { describe, expect, test } from 'bun:test'
import { parseConfig } from './load'
import { ConfigError, ECOSYSTEMS, PUBLISH_TARGETS, RELEASE, SCHEMA_VERSION } from './schema'

/**
 * The published JSON Schema, held to the loader.
 *
 * `docs/cutver.schema.json` is served — it is what `$schema` points at, and the
 * only reason [the config reference](../../docs/reference/config.md) offers JSON
 * as an alternative to YAML. Nothing imports it, so nothing would notice it
 * going stale: add an ecosystem, bump `SCHEMA_VERSION`, loosen a channel name,
 * and every editor keeps validating against last year's rules while the loader
 * has moved on. Red squiggles under a config that runs fine are worse than no
 * completion at all, and the reverse — a file the editor blesses and cutver
 * refuses — is worse still.
 *
 * So the two are compared directly. The channel-name case is a grid rather than
 * an assertion about the regex, because what matters is that the pattern and
 * `parseChannels` reach the same verdict, not that they are spelled alike.
 */

const schema = await Bun.file(new URL('../../docs/cutver.schema.json', import.meta.url)).json()

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
  return Object.keys(channels.patternProperties).some(p => new RegExp(p).test(key))
}

describe('docs/cutver.schema.json', () => {
  test('is served from where $schema points', async () => {
    // Pages publishes `docs/` as the site root, so the file has to live there
    // rather than at the repository root — the URL in the reference page is the
    // spec, and a schema one directory up is a 404 nobody sees until an editor
    // silently stops completing.
    expect(schema.$id).toBe('https://cutver.okyle.dev/cutver.schema.json')

    const reference = await Bun.file(new URL('../../docs/reference/config.md', import.meta.url)).text()
    expect(reference).toContain(schema.$id)
  })

  test('allows exactly the top-level keys the loader does', () => {
    const declared = Object.keys(schema.properties).sort()
    expect(schema.additionalProperties).toBe(false)
    expect(declared).toEqual(['$schema', 'channels', 'publish', 'schema', 'target'])
  })

  test('offers exactly the publish targets that exist', () => {
    expect([...schema.properties.publish.items.enum].sort()).toEqual([...PUBLISH_TARGETS].sort())

    // And agrees with the loader on what it refuses, which is where a schema
    // and a parser usually drift apart.
    expect(() => parseConfig({ publish: ['registry'] }, 'test')).not.toThrow()
    expect(() => parseConfig({ publish: [] }, 'test')).not.toThrow()
    expect(() => parseConfig({ publish: ['crates'] }, 'test')).toThrow(ConfigError)
    expect(() => parseConfig({ publish: 'registry' }, 'test')).toThrow(ConfigError)
  })

  test('caps `schema` at the version this build understands', () => {
    expect(schema.properties.schema.maximum).toBe(SCHEMA_VERSION)
    expect(() => parseConfig({ schema: SCHEMA_VERSION + 1 }, 'test')).toThrow(ConfigError)
  })

  test('offers exactly the ecosystems that exist', () => {
    expect([...schema.properties.target.enum].sort()).toEqual([...ECOSYSTEMS].sort())
  })

  test('names the reserved stable channel', () => {
    expect(Object.keys(schema.properties.channels.properties)).toEqual([RELEASE])
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
      expect(schemaAccepts(name), `channels.${name || '<empty>'}`).toBe(loaderAccepts(name))
    }
  })
})
