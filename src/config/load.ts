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
import { AUTO, type ArtifactsConfig } from './schema'
import { CONNECTORS_AVAILABLE } from '../summarize/connectors'
import { escapeRegex } from '../text'
import { DEFAULT_SECTIONS, SECTIONS } from '../changelog/notes'
import {
  CHANNEL_NAME,
  DEFAULT_KEEP,
  type ChangelogConfig,
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
  type SummarizerConfig,
} from './schema'

/** Tried in this order; more than one existing is an error, not a preference. */
const NAMES = ['cutver.json', 'cutver.yml', 'cutver.yaml'] as const

const TOP_LEVEL = new Set([
  '$schema',
  'schema',
  'target',
  'channels',
  'publish',
  'changelog',
  'summarizer',
  'artifacts',
])

/** Nearest known key, so a typo names its own fix. */
function nearest(key: string, known: Iterable<string>): string | null {
  const lower = key.toLowerCase()
  for (const k of known) {
    if (k.toLowerCase() === lower) return k
    // One transposition, insertion or deletion covers the realistic typos
    // without pulling in a full edit-distance implementation.
    if (
      k.length > 2 &&
      (k.startsWith(lower.slice(0, -1)) || lower.startsWith(k.slice(0, -1)))
    ) {
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
function lintDuplicates(
  text: string,
  json: boolean,
  keys: string[],
  where: string,
): void {
  for (const key of keys) {
    const escaped = escapeRegex(key)
    const re = json
      ? new RegExp(`"${escaped}"\\s*:`, 'g')
      : new RegExp(`^\\s*(?:"${escaped}"|'${escaped}'|${escaped})\\s*:`, 'gm')

    if ((text.match(re) ?? []).length > 1) {
      throw new ConfigError(
        `${where}: \`${key}\` is declared more than once.\n` +
          'Both parsers keep only the last one, so the earlier entries do ' +
          'nothing.',
      )
    }
  }
}

function asStringArray(value: unknown, where: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some(v => typeof v !== 'string' || !v.trim())
  ) {
    throw new ConfigError(
      `${where} must be a list of non-empty branch patterns`,
    )
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
    throw new ConfigError(
      `${where} must be a single mapping, not a list of documents`,
    )
  }
  if (raw === null || raw === undefined)
    return { ...DEFAULT_CONFIG, source: where }
  if (typeof raw !== 'object')
    throw new ConfigError(`${where} must be a mapping`)

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
    if (
      typeof doc.target !== 'string' ||
      !(ECOSYSTEMS as readonly string[]).includes(doc.target)
    ) {
      throw new ConfigError(
        `${where}: \`target\` must be one of ${ECOSYSTEMS.join(', ')}`,
      )
    }
    target = doc.target as Ecosystem
  }

  const channels = parseChannels(doc.channels, where)
  // Only the keys this file wrote. A default that arrives by inheritance is
  // not a decision anybody made about their branches.
  const declaredChannels =
    doc.channels &&
    typeof doc.channels === 'object' &&
    !Array.isArray(doc.channels)
      ? Object.keys(doc.channels as object).map(
          k => KEY_ALIASES[toKebab(k)] ?? toKebab(k),
        )
      : []
  const warnings: string[] = []
  const legacy = parsePublish(doc.publish, where, warnings)
  // The pre-2.0 top-level block, parsed so it can be folded into
  // `changelog.summarizer` and reported rather than silently ignored.
  const legacySummarizer = parseSummarizer(doc.summarizer, where)
  if (legacySummarizer) {
    warnings.push(
      `${where}: a top-level \`summarizer:\` is the pre-2.0 spelling — it goes ` +
        'under `changelog.summarizer:` now. It still works, and goes away in 3.0.',
    )
  }
  const changelog = parseChangelog(
    doc.changelog,
    where,
    warnings,
    legacySummarizer,
  )
  const declaredArtifacts = parseArtifacts(doc.artifacts, where)
  // The old list said `artifacts` without saying which files. `auto` is the
  // only honest reading of that, and it is what the list used to do.
  const artifacts =
    declaredArtifacts ??
    (legacy.artifacts === null
      ? null
      : legacy.artifacts
        ? { folders: [], files: AUTO }
        : false)
  return {
    schema,
    target,
    channels,
    declaredChannels,
    publish: legacy.publish,
    changelog,
    artifacts,
    warnings,
    source: where,
  }
}

/**
 * `changelog: true`, a list of sections, or an object with both knobs.
 *
 * Three shapes because they are three different amounts of opinion, and the
 * shorthands cost one branch each. `false` and an empty list mean "open the
 * heading and write nothing", which is the default and what every release
 * before this did.
 */
function parseChangelog(
  raw: unknown,
  where: string,
  warnings: string[],
  /** A top-level `summarizer:`, which is the pre-2.0 place for it. */
  legacySummarizer: SummarizerConfig | null,
): ChangelogConfig | null {
  if (raw === undefined || raw === false || raw === null) return null
  const bare = {
    keep: DEFAULT_KEEP,
    prereleases: false,
    summarizer: null,
    prompt: null,
  }
  if (raw === true) return { sections: [...DEFAULT_SECTIONS], ...bare }
  if (Array.isArray(raw)) {
    const sections = parseSections(raw, where)
    return sections.length ? { sections, ...bare } : null
  }

  if (typeof raw !== 'object') {
    throw new ConfigError(
      `${where}: \`changelog\` must be true, false, a list of sections, or a mapping.\n` +
        `        Known sections: ${Object.keys(SECTIONS).join(', ')}.`,
    )
  }

  const doc = raw as Record<string, unknown>
  for (const key of Object.keys(doc)) {
    if (
      [
        'sections',
        'keep',
        'prereleases',
        'summarizer',
        'summarize',
        'prompt',
      ].includes(key)
    )
      continue
    throw new ConfigError(
      `${where}: unknown key \`changelog.${key}\` — expected sections, keep,` +
        `summarize or prompt`,
    )
  }

  const sections =
    doc.sections === undefined
      ? [...DEFAULT_SECTIONS]
      : parseSections(doc.sections, where)

  // `keep: false` and `keep: 0` both mean "every section", said two ways people
  // actually write. Anything else has to be a positive whole number of
  // sections — a fractional or negative one is a typo, and silently rounding it
  // would trim a file by an amount nobody asked for.
  let keep: number | null = DEFAULT_KEEP
  if (doc.keep === false || doc.keep === 0 || doc.keep === null) keep = null
  else if (doc.keep !== undefined) {
    if (
      typeof doc.keep !== 'number' ||
      !Number.isInteger(doc.keep) ||
      doc.keep < 1
    ) {
      throw new ConfigError(
        `${where}: \`changelog.keep\` must be a positive whole number of sections, ` +
          'or false to keep every one',
      )
    }
    keep = doc.keep
  }

  // **A switch, not a command.** The command comes from `CUTVER_SUMMARIZE` in
  // the environment: a command written here would be a command in a tracked
  // file, and `gh pr checkout` puts a fork's tracked files in a maintainer's
  // working tree. This config had an `events:` key cut before it ever shipped
  // for exactly that reason, and a command string reintroduced it.
  //
  // A string is refused rather than quietly accepted, because someone who
  // writes one has a command they expect to run and needs telling where it
  // goes.
  // `changelog.summarizer:` — a mapping naming a provider, or `true` for the
  // command in `CUTVER_SUMMARIZE`. Writing it is the opt-in; there is no
  // separate switch, because two keys for one decision meant either alone did
  // nothing.
  let summarizer: SummarizerConfig | true | null = null
  if (doc.summarizer === true) summarizer = true
  else if (doc.summarizer !== undefined && doc.summarizer !== null) {
    if (typeof doc.summarizer === 'string') {
      throw new ConfigError(
        `${where}: \`changelog.summarizer\` is a mapping, or \`true\` for the ` +
          'command in\n' +
          '        CUTVER_SUMMARIZE. A command does not go in this file: it is\n' +
          '        tracked, and `gh pr checkout` brings a fork’s tracked files\n' +
          '        into your working tree.',
      )
    }
    summarizer = parseSummarizer(doc.summarizer, where, 'changelog.summarizer')
  }

  // The pre-2.0 spelling: a boolean here plus a provider at the top level.
  // Mapped onto the one key and reported — see `parseConfig`, which passes the
  // top-level block in so the two halves can be rejoined.
  if (doc.summarize !== undefined && doc.summarize !== null) {
    if (typeof doc.summarize !== 'boolean') {
      throw new ConfigError(
        `${where}: \`changelog.summarize\` is true or false, and is the pre-2.0 ` +
          'spelling.\n' +
          '        Name the provider under `changelog.summarizer:` instead.',
      )
    }
    if (doc.summarize && !summarizer) summarizer = legacySummarizer ?? true
    warnings.push(
      `${where}: \`changelog.summarize\` is the pre-2.0 spelling — the ` +
        'summariser goes under `changelog.summarizer:` now. It still works, ' +
        'and goes away in 3.0.',
    )
  }

  let prompt: string | null = null
  if (doc.prompt !== undefined && doc.prompt !== null) {
    if (typeof doc.prompt !== 'string' || !doc.prompt.trim()) {
      throw new ConfigError(
        `${where}: \`changelog.prompt\` must be a non-empty string`,
      )
    }
    // A prompt with no command to send it to is a config that does nothing,
    // which is worth saying rather than quietly ignoring.
    if (!summarizer) {
      throw new ConfigError(
        `${where}: \`changelog.prompt\` needs \`changelog.summarizer\` — there ` +
          `is nothing to send it to`,
      )
    }
    prompt = doc.prompt.trim()
  }

  // Off by default: a prerelease is a step toward a release rather than one,
  // and everything in it ships again under the stable version that follows.
  // Opting in restores a heading per prerelease.
  if (doc.prereleases !== undefined && typeof doc.prereleases !== 'boolean') {
    throw new ConfigError(
      `${where}: \`changelog.prereleases\` is true or false`,
    )
  }
  const prereleases = doc.prereleases === true

  return sections.length
    ? { sections, keep, prereleases, summarizer, prompt }
    : null
}

function parseSections(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError(`${where}: \`changelog.sections\` must be a list`)
  }

  const out: string[] = []
  for (const entry of raw) {
    const name = typeof entry === 'string' ? toKebab(entry) : ''
    if (!Object.hasOwn(SECTIONS, name)) {
      throw new ConfigError(
        `${where}: \`${String(entry)}\` is not a changelog section.\n` +
          `        Known: ${Object.keys(SECTIONS).join(', ')}.`,
      )
    }
    // Order is the reading order, so a repeat is a copy-paste rather than a
    // request for the section twice.
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * `publish: true` — does a tag reach the registry?
 *
 * **It used to be a list, and the list conflated two decisions.**
 * `[registry, artifacts]` answered "publish to npm" and "attach files" in one
 * key, so setting either meant restating the other — and once `artifacts:`
 * existed to say *which* files, two keys were arguing over one switch. This
 * answers one question; `artifacts:` answers the other.
 *
 * Absent stays `null` so the ecosystem default applies. `false` is a real
 * answer — tag and stop — and it is what keeps the registry preflight from
 * refusing a release for ten crates nobody intends to publish.
 *
 * **The list still parses**, mapped onto the pair and reported, because it is
 * in every config written before 2.0 and a rename is not worth breaking a
 * release over. It goes in 3.0.
 */
function parsePublish(
  raw: unknown,
  where: string,
  warnings: string[],
): { publish: boolean | null; artifacts: boolean | null } {
  if (raw === undefined) return { publish: null, artifacts: null }
  if (typeof raw === 'boolean') return { publish: raw, artifacts: null }

  if (Array.isArray(raw)) {
    const names = raw.map(entry =>
      typeof entry === 'string' ? toKebab(entry) : '',
    )
    for (const name of names) {
      if (!(PUBLISH_TARGETS as readonly string[]).includes(name)) {
        throw new ConfigError(
          `${where}: \`${name || 'that'}\` is not something a tag can produce.\n` +
            `        Known: ${PUBLISH_TARGETS.join(', ')}.`,
        )
      }
    }

    const registry = names.includes('registry')
    const artifacts = names.includes('artifacts')
    warnings.push(
      `${where}: \`publish\` as a list is the pre-2.0 spelling — this one means ` +
        `\`publish: ${registry}\`` +
        (artifacts ? ', with `artifacts:` naming what to attach' : '') +
        '. It still works, and goes away in 3.0.',
    )
    return { publish: registry, artifacts }
  }

  throw new ConfigError(
    `${where}: \`publish\` is true or false — whether a tag reaches the registry.\n` +
      '        What a tag *attaches* is `artifacts:`, which names the files.',
  )
}

function parseChannels(raw: unknown, where: string): Record<string, string[]> {
  if (raw === undefined) return DEFAULT_CONFIG.channels
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      `${where}: \`channels\` must be a mapping of channel to branch patterns`,
    )
  }

  const out: Record<string, string[]> = {}
  const seen = new Map<string, string>()

  for (const [rawKey, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
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
          'Merging them silently would put a branch in a channel nobody ' +
          'declared.',
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
          'camelCase and snake_case are converted for you; digits are not ' +
          'accepted.',
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
export async function loadConfig(
  root: string,
  explicit?: string,
): Promise<Loaded> {
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

/**
 * `summarizer:` — which API to send the notes to.
 *
 * Absent is the normal case and means "use `CUTVER_SUMMARIZE`, or nothing".
 */
function parseSummarizer(
  value: unknown,
  where: string,
  /** What to call this block in a message: it moved under `changelog` in 2.0. */
  label = 'summarizer',
): SummarizerConfig | null {
  if (value === undefined || value === null) return null

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(
      `${where}: \`${label}\` is a mapping, or \`true\` for the command in\n` +
        '        CUTVER_SUMMARIZE.\n' +
        '  changelog:\n' +
        '    summarizer:\n' +
        '      connector: gemini\n' +
        '      model: gemini-3.5-flash',
    )
  }

  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    const k = toKebab(key)
    if (!['connector', 'model', 'base-url', 'retry', 'with-body'].includes(k)) {
      throw new ConfigError(
        `${where}: unknown key \`summarizer.${key}\` — expected connector, ` +
          `model, base_url or retry`,
      )
    }
  }

  const str = (key: 'connector' | 'model'): string => {
    const v = raw[key] ?? raw[toKebab(key)]
    if (typeof v !== 'string' || !v.trim()) {
      throw new ConfigError(
        `${where}: \`summarizer.${key}\` must be a non-empty string`,
      )
    }
    return v.trim()
  }

  const connector = str('connector')
  if (!CONNECTORS_AVAILABLE.includes(connector)) {
    throw new ConfigError(
      `${where}: \`summarizer.connector\` is \`${connector}\` — expected ${CONNECTORS_AVAILABLE.join(', ')}.\n` +
        'Most providers speak the OpenAI shape; use `openai-compatible` with ' +
        'a `base_url`.',
    )
  }

  const baseRaw = raw.base_url ?? raw['base-url'] ?? raw.baseUrl
  if (
    baseRaw !== undefined &&
    (typeof baseRaw !== 'string' || !baseRaw.trim())
  ) {
    throw new ConfigError(
      `${where}: \`summarizer.base_url\` must be a non-empty string`,
    )
  }
  const baseUrl =
    typeof baseRaw === 'string' ? baseRaw.trim().replace(/\/+$/, '') : null

  // Required here and nowhere else: this connector exists to point somewhere
  // other than OpenAI, and a default would send a repository's release notes to
  // a provider it never named.
  if (connector === 'openai-compatible' && !baseUrl) {
    throw new ConfigError(
      `${where}: \`openai-compatible\` needs a \`base_url\` — it is what says which provider.\n` +
        '    base_url: https://openrouter.ai/api/v1',
    )
  }

  return {
    connector,
    model: str('model'),
    baseUrl,
    retry: parseRetry(raw.retry, where),
    withBody: parseWithBody(raw['with_body'] ?? raw.withBody, where, label),
  }
}

/**
 * `retry: false | true | <minutes>` — how long to wait before one more attempt.
 *
 * `true` means one minute, because that is the window every provider's free
 * tier meters tokens against; a bare `true` almost always means "wait out the
 * rate limit". A number says how many minutes instead.
 *
 * Capped at 10. The generated step carries `timeout-minutes: 15`, and a wait
 * plus two attempts has to finish inside it — a retry that gets the job killed
 * loses the release body it was trying to save, which is the opposite of the
 * point.
 */
function parseRetry(value: unknown, where: string): number | null {
  if (value === undefined || value === null || value === false) return null
  if (value === true) return 1

  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 10
  ) {
    throw new ConfigError(
      `${where}: \`summarizer.retry\` is false, true, or a number of minutes from 1 to 10.\n` +
        '  `true` waits one minute — the window rate limits are measured over.\n' +
        'The ceiling is 10 because the generated step allows 15 minutes in ' +
        'total.',
    )
  }
  return value
}

/**
 * `artifacts:` — what a tag attaches to its release.
 *
 * **Paths are checked, not trusted.** They are interpolated into a generated
 * shell script that runs in CI with a write token, so an absolute path or a
 * `..` escape is refused here rather than discovered as a `tar` reading
 * `/etc` on a runner. A glob is fine; leaving the repository is not.
 */
function parseArtifacts(
  value: unknown,
  where: string,
): ArtifactsConfig | false | null {
  if (value === undefined) return null

  // `artifacts: false` — off, whatever the ecosystem would have done. This is
  // the *only* way to say no, which is why there is no `enabled` key: writing
  // the block is the yes, and this is the no.
  if (value === false || value === null) return false

  // `artifacts: true` / `artifacts: auto` — on, and find it. The same shorthand
  // `changelog: true` already has: the common case should not need a mapping.
  if (value === true || value === AUTO) return { folders: [], files: AUTO }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(
      `${where}: \`artifacts\` is false, \`auto\`, or a mapping.\n` +
        '  artifacts: auto\n' +
        '  artifacts:\n' +
        '    folders: [dist]\n' +
        '    files: [build/my-executable]',
    )
  }

  const doc = value as Record<string, unknown>
  const known = ['folders', 'files']
  for (const key of Object.keys(doc)) {
    if (!known.includes(key)) {
      throw new ConfigError(
        `${where}: unknown key \`artifacts.${key}\` — expected ` +
          `${known.join(', ')}`,
      )
    }
  }

  const list = (key: 'folders' | 'files'): string[] | typeof AUTO => {
    const raw = doc[key]
    // An empty entry — `files:` with nothing under it — is YAML for null, and
    // it reads as "you fill this in". `auto` is the useful reading of that.
    if (raw === null) return AUTO
    if (raw === undefined) return []
    if (raw === AUTO) return AUTO
    if (!Array.isArray(raw) || raw.some(v => typeof v !== 'string')) {
      throw new ConfigError(
        `${where}: \`artifacts.${key}\` is a list of paths, or \`auto\``,
      )
    }

    return (raw as string[]).map(entry => {
      const path = entry.trim()
      if (!path)
        throw new ConfigError(
          `${where}: \`artifacts.${key}\` has an empty entry`,
        )
      if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
        throw new ConfigError(
          `${where}: \`artifacts.${key}\` entry '${entry}' is an absolute path.\n` +
            '        These are read on a CI runner, where your repository is the\n' +
            '        only thing that exists. Use a path relative to the root.',
        )
      }
      if (path.split(/[\/]/).includes('..')) {
        throw new ConfigError(
          `${where}: \`artifacts.${key}\` entry '${entry}' climbs out of the ` +
            `repository`,
        )
      }
      return path
    })
  }

  const folders = list('folders')
  const files = list('files')

  // A mapping that names nothing would attach nothing, silently. `auto` is what
  // someone writing that meant, and `artifacts: false` is how you say no.
  const named =
    folders === AUTO || files === AUTO || folders.length > 0 || files.length > 0
  return named ? { folders, files } : { folders: [], files: AUTO }
}

/**
 * `with_body:` — whole commit bodies, or just the thesis of each.
 *
 * On by default, because it is what lets one commit become several bullets: the
 * changes after the first live in the paragraphs a rendered section drops.
 */
function parseWithBody(value: unknown, where: string, label: string): boolean {
  if (value === undefined || value === null) return true
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${where}: \`${label}.with_body\` is true or false`)
  }
  return value
}
