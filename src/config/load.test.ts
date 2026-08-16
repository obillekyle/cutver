import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadConfig, parseConfig } from './load'
import { DEFAULT_CONFIG } from './schema'

const made: string[] = []

afterEach(async () => {
  while (made.length)
    await rm(made.pop() as string, { recursive: true, force: true })
})

async function fixture(files: Record<string, string> = {}): Promise<string> {
  const dir = (await mkdtemp(`${tmpdir()}/cutver-cfg-`)).replaceAll('\\', '/')
  made.push(dir)
  for (const [rel, body] of Object.entries(files))
    await Bun.write(`${dir}/${rel}`, body)
  return dir
}

const at = (o: unknown) => parseConfig(o, 'cutver.json')

describe('discovery', () => {
  test('no file is not an error — it is the default', async () => {
    const { config, path } = await loadConfig(await fixture())
    expect(path).toBeNull()
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test('json and yaml produce the same config', async () => {
    const json = await fixture({
      'cutver.json':
        '{"schema":1,"target":"bun","channels":{"beta":["develop"]}}',
    })
    const yaml = await fixture({
      'cutver.yml': 'schema: 1\ntarget: bun\nchannels:\n  beta: [develop]\n',
    })

    const a = await loadConfig(json)
    const b = await loadConfig(yaml)
    expect({ ...a.config, source: null }).toEqual({ ...b.config, source: null })
    expect(a.config.channels.beta).toEqual(['develop'])
  })

  test('two config files is refused rather than resolved', async () => {
    // Picking a winner means the file you edited might not be the file that
    // ran.
    const root = await fixture({
      'cutver.json': '{}',
      'cutver.yml': 'schema: 1\n',
    })
    await expect(loadConfig(root)).rejects.toThrow(/both exist/)
  })

  test('--config pointing at nothing dies rather than falling back', async () => {
    const root = await fixture()
    await expect(loadConfig(root, `${root}/nope.json`)).rejects.toThrow(
      /no such file/,
    )
  })

  test('an empty file is the default, not a crash', async () => {
    // A comment-only YAML file parses to null; an empty JSON file is not
    // valid JSON at all, so it is special-cased.
    const cases: Record<string, string>[] = [
      { 'cutver.yml': '# nothing here\n' },
      { 'cutver.json': '' },
    ]
    for (const files of cases) {
      const { config } = await loadConfig(await fixture(files))
      expect(config.channels).toEqual(DEFAULT_CONFIG.channels)
    }
  })

  test('a duplicated key is caught, in both formats', async () => {
    // Both parsers accept it and keep only the last, so half the branch
    // patterns would silently stop matching.
    const json = await fixture({
      'cutver.json': '{"channels":{"beta":["a"]},"channels":{"beta":["b"]}}',
    })
    await expect(loadConfig(json)).rejects.toThrow(/declared more than once/)

    const yaml = await fixture({
      'cutver.yml': 'channels:\n  beta: [a]\n  beta: [b]\n',
    })
    await expect(loadConfig(yaml)).rejects.toThrow(/declared more than once/)
  })
})

describe('validation', () => {
  test('an unknown key names its nearest neighbour', () => {
    expect(() => at({ channel: {} })).toThrow(
      /unknown key `channel` — did you mean `channels`/,
    )
    expect(() => at({ targets: 'bun' })).toThrow(/unknown key `targets`/)
  })

  test('a newer schema refuses rather than guesses', () => {
    // An unknown schema may give a key this build already knows a different
    // meaning, and the failure mode of guessing is an irreversible publish.
    expect(() => at({ schema: 2 })).toThrow(
      /declares schema 2; this cutver understands 1/,
    )
    expect(() => at({ schema: 0 })).toThrow(/positive integer/)
    expect(() => at({ schema: 1.5 })).toThrow(/positive integer/)
  })

  test('a multi-document YAML file is refused before the walk', () => {
    expect(() => at([{ schema: 1 }, { schema: 1 }])).toThrow(/single mapping/)
  })

  test('target must name an ecosystem', () => {
    expect(at({ target: 'cargo' }).target).toBe('cargo')
    expect(() => at({ target: 'js' })).toThrow(
      /must be one of cargo, node, bun/,
    )
  })

  test('channel keys are normalised to kebab-case rather than refused', () => {
    // camelCase, PascalCase and snake_case all name the same thing to anyone
    // reading the file, so they resolve to the same channel instead of two of
    // the three being errors.
    const c = at({
      channels: {
        Beta: ['w'],
        myPrefix: ['x'],
        my_snake: ['y'],
        'pre release': ['z'],
      },
    })
    expect(c.channels.beta).toEqual(['w'])
    expect(c.channels['my-prefix']).toEqual(['x'])
    expect(c.channels['my-snake']).toEqual(['y'])
    expect(c.channels['pre-release']).toEqual(['z'])
  })

  test('a run of capitals breaks where a reader would break it', () => {
    // `HTTPServer` is `http-server`, not `h-t-t-p-server`.
    expect(
      Object.keys(at({ channels: { HTTPServer: ['x'] } }).channels),
    ).toContain('http-server')
  })

  test('two keys colliding after normalising is refused, naming both', () => {
    for (const channels of [
      { Beta: ['x'], beta: ['y'] },
      { myPrefix: ['x'], my_prefix: ['y'] },
    ]) {
      expect(() => at({ channels })).toThrow(/are the same channel/)
    }
  })

  test('`prerelease` is a spelling of `rc`, and declaring both is refused', () => {
    expect(at({ channels: { prerelease: ['x'] } }).channels.rc).toEqual(['x'])
    expect(() => at({ channels: { rc: ['a'], prerelease: ['b'] } })).toThrow(
      /are the same channel/,
    )
  })

  test('hyphens are fine — they are the point of kebab-case', () => {
    // A hyphen *inside* the identifier is safe: the counter keeps its own dot,
    // so `my-prefix.9` still sorts below `my-prefix.10`. Measured.
    const c = at({ channels: { 'pre-release': ['x'], 'my-long-name': ['y'] } })
    expect(c.channels['pre-release']).toEqual(['x'])
    expect(c.channels['my-long-name']).toEqual(['y'])
  })

  test('a digit is still refused, and says so', () => {
    for (const name of ['rc2', 'v2-latest']) {
      expect(() => at({ channels: { [name]: ['x'] } }), name).toThrow(
        /not a usable channel name/,
      )
      expect(() => at({ channels: { [name]: ['x'] } }), name).toThrow(
        /digits are not accepted/,
      )
    }
  })

  test('an unmentioned channel keeps its default', () => {
    // A config that only names `beta` must not silently switch `rc` off.
    const c = at({ channels: { beta: ['develop'] } })
    expect(c.channels.rc).toEqual(DEFAULT_CONFIG.channels.rc)
    expect(c.channels.release).toEqual(['**'])
  })

  test('branch patterns must be non-empty strings', () => {
    expect(() => at({ channels: { beta: 'develop' } })).toThrow(
      /list of non-empty branch/,
    )
    expect(() => at({ channels: { beta: ['', 'x'] } })).toThrow(
      /list of non-empty branch/,
    )
    expect(() => at({ channels: { beta: [1] } })).toThrow(
      /list of non-empty branch/,
    )
  })

  test('`$schema` is allowed and ignored', () => {
    expect(() =>
      at({ $schema: 'https://example.invalid/s.json', schema: 1 }),
    ).not.toThrow()
  })
})
