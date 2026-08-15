/**
 * Find, parse and check `cutver.json` / `cutver.yml`.
 *
 * Everything here refuses **at load time** — before git is touched, before a
 * manifest is read, before anything is written. A config file that is wrong
 * should cost you an error message, never a version number.
 *
 * Both parsers are worse than they look and the difference matters:
 * `JSON.parse` and `Bun.YAML.parse` give no line numbers, and both silently
 * keep the *last* of a duplicated key. Measured, both of them. So cutver adds
 * the file path to every message and lints for duplicates itself.
 */
import { escapeRegex } from '../text'
import {
  CHANNEL_NAME,
  ConfigError,
  DEFAULT_CONFIG,
  ECOSYSTEMS,
  KEY_ALIASES,
  PUBLISH_TARGETS,
  RELEASE,
  toKebab,
  SCHEMA_VERSION,
  type Config,
  type Ecosystem,
  type PublishTarget,
} from './schema'

/** Tried in this order; more than one existing is an error, not a preference. */
const NAMES = ['cutver.json', 'cutver.yml', 'cutver.yaml'] as const

const TOP_LEVEL = new Set(['$schema', 'schema', 'target', 'channels', 'publish'])

/** Nearest known key, so a typo names its own fix. */
function nearest(key: string, known: Iterable<string>): string | null {
  const lower = key.toLowerCase()
  for (const k of known) {
    if (k.toLowerCase() === lower) return k
    // One transposition, insertion or deletion covers the realistic typos
    // without pulling in a full edit-distance implementation.
    if (k.length > 2 && (k.startsWith(lower.slice(0, -1)) || lower.startsWith(k.slice(0, -1)))) {
      return k
    }
  }
  return null
}

/**
 * A key written twice, which both parsers accept while keeping only the last.
 *
 * A lint over the raw text, not a parser: it looks for exactly the keys that
 * were parsed, as keys. `"beta":` in JSON and `beta:` at a line start in YAML
 * cannot appear inside an array of branch names — those are `"beta"` and
 * `- beta` — so this cannot fire on a value.
 */
function lintDuplicates(text: string, json: boolean, keys: string[], where: string): void {
  for (const key of keys) {
    const escaped = escapeRegex(key)
    const re = json
      ? new RegExp(`"${escaped}"\\s*:`, 'g')
      : new RegExp(`^\\s*(?:"${escaped}"|'${escaped}'|${escaped})\\s*:`, 'gm')

    if ((text.match(re) ?? []).length > 1) {
      throw new ConfigError(
        `${where}: \`${key}\` is declared more than once.\n` +
          '        Both parsers keep only the last one, so the earlier entries do nothing.',
      )
    }
  }
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) {
    throw new ConfigError(`${where} must be a list of non-empty branch patterns`)
  }
  return value as string[]
}

/**
 * Turn a parsed document into a `Config`, or refuse.
 *
 * Exported so the tests can drive it without a filesystem — the awkward cases
 * here are all about shape, and a temp directory adds nothing to them.
 */
export function parseConfig(raw: unknown, where: string): Config {
  if (Array.isArray(raw)) {
    // A YAML file with `---` separators parses to an array of documents.
    throw new ConfigError(`${where} must be a single mapping, not a list of documents`)
  }
  if (raw === null || raw === undefined) return { ...DEFAULT_CONFIG, source: where }
  if (typeof raw !== 'object') throw new ConfigError(`${where} must be a mapping`)

  const doc = raw as Record<string, unknown>

  for (const key of Object.keys(doc)) {
    if (TOP_LEVEL.has(key)) continue
    const hint = nearest(key, TOP_LEVEL)
    throw new ConfigError(
      `${where}: unknown key \`${key}\`${hint ? ` — did you mean \`${hint}\`?` : ''}`,
    )
  }

  // **The schema gate refuses rather than guesses.** A newer schema may give a
  // key this build already knows a different meaning, and the failure mode of
  // guessing is an irreversible publish.
  const schema = doc.schema ?? SCHEMA_VERSION
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) {
    throw new ConfigError(`${where}: \`schema\` must be a positive integer`)
  }
  if (schema > SCHEMA_VERSION) {
    throw new ConfigError(
      `${where} declares schema ${schema}; this cutver understands ${SCHEMA_VERSION}.\n` +
        '        Upgrade cutver, or pin the older schema.',
    )
  }

  let target: Ecosystem | null = null
  if (doc.target !== undefined) {
    if (typeof doc.target !== 'string' || !(ECOSYSTEMS as readonly string[]).includes(doc.target)) {
      throw new ConfigError(`${where}: \`target\` must be one of ${ECOSYSTEMS.join(', ')}`)
    }
    target = doc.target as Ecosystem
  }

  const channels = parseChannels(doc.channels, where)
  const publish = parsePublish(doc.publish, where)
  return { schema, target, channels, publish, source: where }
}

/**
 * `publish: [registry, artifacts]`, or `[]` to tag and stop.
 *
 * Absent stays `null` so the adapter default applies; an empty list is kept as
 * an empty list, because "publish nothing" is a thing a repository means on
 * purpose and is not the same as not having answered.
 */
function parsePublish(raw: unknown, where: string): PublishTarget[] | null {
  if (raw === undefined) return null
  if (!Array.isArray(raw)) {
    throw new ConfigError(
      `${where}: \`publish\` must be a list — ${PUBLISH_TARGETS.map(t => `\`${t}\``).join(
        ' or ',
      )}, both, or \`[]\` to tag without publishing`,
    )
  }

  const out: PublishTarget[] = []
  for (const entry of raw) {
    const name = typeof entry === 'string' ? toKebab(entry) : ''
    if (!(PUBLISH_TARGETS as readonly string[]).includes(name)) {
      throw new ConfigError(
        `${where}: \`${String(entry)}\` is not something a tag can produce.\n` +
          `        Known: ${PUBLISH_TARGETS.join(', ')}.`,
      )
    }
    // Deduplicated rather than refused: a list naming the same output twice is
    // a copy-paste, not a decision, and there is no second thing it could mean.
    if (!out.includes(name as PublishTarget)) out.push(name as PublishTarget)
  }
  return out
}

function parseChannels(raw: unknown, where: string): Record<string, string[]> {
  if (raw === undefined) return DEFAULT_CONFIG.channels
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${where}: \`channels\` must be a mapping of channel to branch patterns`)
  }

  const out: Record<string, string[]> = {}
  const seen = new Map<string, string>()

  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    // **Normalised, not refused.** `Beta`, `myPrefix` and `my_prefix` all name
    // the same thing to anyone reading the file, so they resolve to the same
    // channel rather than two of the three being errors. Done once, here, so
    // the version string, the git tag, the dist-tag and the generated workflow
    // arm cannot disagree about spelling.
    const kebab = toKebab(rawKey)
    const key = KEY_ALIASES[kebab] ?? kebab

    const previous = seen.get(key)
    if (previous !== undefined) {
      throw new ConfigError(
        `${where}: \`${previous}\` and \`${rawKey}\` are the same channel (\`${key}\`).\n` +
          '        Merging them silently would put a branch in a channel nobody declared.',
      )
    }
    seen.set(key, rawKey)

    // Kebab-case is the whole alphabet here. A digit is what normalising
    // cannot rescue, and it buys nothing: an all-digit prerelease identifier
    // has leading-zero rules of its own, and a channel name is not the place
    // to spend that.
    if (key !== RELEASE && !CHANNEL_NAME.test(key)) {
      throw new ConfigError(
        `${where}: \`${rawKey}\` is not a usable channel name.\n` +
          `        Letters and single hyphens only — \`${kebab}\` is not.\n` +
          '        camelCase and snake_case are converted for you; digits are not accepted.',
      )
    }

    out[key] = asStringArray(value, `${where}: \`channels.${rawKey}\``)
  }

  // An unmentioned channel keeps its default, so a config that only names
  // `beta` does not silently switch `rc` off.
  return { ...DEFAULT_CONFIG.channels, ...out }
}

export interface Loaded {
  config: Config
  /** Repo-relative path, or `null` when nothing was found. */
  path: string | null
}

/**
 * Find and load the config.
 *
 * **No upward search, and no user-level config.** A config outside the
 * repository would mean CI and a laptop computing different version numbers
 * from the same commits, which is the one property this tool cannot lose.
 */
export async function loadConfig(root: string, explicit?: string): Promise<Loaded> {
  if (explicit) {
    const file = Bun.file(explicit)
    if (!(await file.exists())) {
      // An explicit path that quietly falls back to defaults is how a
      // repository releases the wrong numbers for a month.
      throw new ConfigError(`--config ${explicit}: no such file`)
    }
    return { config: await read(explicit, explicit), path: explicit }
  }

  const found: string[] = []
  for (const name of NAMES) {
    if (await Bun.file(`${root}/${name}`).exists()) found.push(name)
  }

  if (found.length > 1) {
    throw new ConfigError(
      `${found.join(' and ')} both exist — cutver will not pick one.\n` +
        '        The file you edited might not be the file that ran.',
    )
  }

  const name = found[0]
  if (!name) return { config: DEFAULT_CONFIG, path: null }
  return { config: await read(`${root}/${name}`, name), path: name }
}

async function read(path: string, where: string): Promise<Config> {
  const text = await Bun.file(path).text()
  const json = path.endsWith('.json')

  let raw: unknown
  try {
    // Parsed by extension: each parser gives better errors for its own syntax,
    // and neither gives a line number, so the file name is added here.
    raw = json ? (text.trim() ? JSON.parse(text) : null) : Bun.YAML.parse(text)
  } catch (e) {
    throw new ConfigError(`${where}: ${(e as Error).message}`)
  }

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const doc = raw as Record<string, unknown>
    lintDuplicates(text, json, Object.keys(doc), where)
    if (doc.channels && typeof doc.channels === 'object') {
      lintDuplicates(text, json, Object.keys(doc.channels as object), where)
    }
  }

  return parseConfig(raw, where)
}
