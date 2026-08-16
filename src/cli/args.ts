/**
 * Everything between `process.argv` and a decision: the flags, the help, and
 * the three resolutions that have to happen before any command can start.
 *
 * Kept apart from the commands because it is the one part with no I/O worth
 * speaking of and no opinion about what cutver does — `parse` is the same
 * function whether the command that follows writes a manifest or prints a
 * paragraph.
 */
import {
  ADAPTER_IDS,
  ADAPTER_FOR,
  ADAPTERS,
  applicableAdapters,
  type AdapterId,
} from '../adapters'
import { KEY_ALIASES, toKebab, type Config } from '../config/schema'
import { CHANNELS } from '../version-from-commits'
import { flagsAllowedFor, help } from './help'

/**
 * What cutver believes its own version to be, from whichever of the two
 * distributions is running.
 *
 * `CUTVER_VERSION` is injected by `bun build --compile --define`, because a
 * compiled executable does not carry package.json and a binary that reported
 * nothing would be reporting it in the one place a person is most likely to
 * ask. `typeof` rather than a bare reference: the define does not exist outside
 * a compiled build.
 *
 * **The manifest import is the other half, and it was missing until 1.0.1.**
 * The npm package's `bin` points straight at the source, so nothing ever
 * defines `CUTVER_VERSION` there and every install from beta.0 onward answered
 * `dev`. That is a cosmetic wrong answer for `--version` and a real one twice
 * over: `hook install` writes the unpinned `releases/latest/download` URL for
 * a version it thinks is a source checkout, and `init` skips pinning cutver as
 * a devDependency for the same reason — so `bunx cutver init` generated exactly
 * the floating-on-`latest` workflow that pinning exists to prevent.
 *
 * An import rather than a read, so it resolves synchronously and cannot fail
 * at a path the way `../../package.json` would from a bundled or relocated
 * entry. The define still wins where it exists; `dev` now means a source
 * checkout with no manifest, which is the only case left.
 */
import manifest from '../../package.json' with { type: 'json' }

declare const CUTVER_VERSION: string | undefined

/** cutver's own version, for `--version`, `init` pinning and `hook install`. */
export const VERSION: string =
  typeof CUTVER_VERSION === 'string' && CUTVER_VERSION
    ? CUTVER_VERSION
    : (manifest.version ?? 'dev')

/** Print a `cutver:`-prefixed message on stderr and exit 1. Never returns. */
export function die(message: string): never {
  console.error(`cutver: ${message}`)
  process.exit(1)
}

/** Every flag cutver accepts, after parsing and before any of it is acted on. */
export interface Options {
  /** A version given on the command line, overriding the computation. */
  explicit?: string
  /** Compute and report; write no file, make no tag. */
  dryRun: boolean
  /** Exit 0 rather than 1 when no release is warranted — what CI wants. */
  ifNeeded: boolean
  /** Skip the registry preflight, and the network round trip with it. */
  offline: boolean
  /** Proceed even though a package has never been published. */
  allowFirstPublish: boolean
  /** `init`, `hook`: replace files that are already there. */
  force: boolean
  /** `init`: do not install the pre-push guard. */
  noHook: boolean
  /** Rebuild `CHANGELOG.md` from the tags and release nothing. */
  regenerateChangelogs: boolean
  /** Force the manifest adapter, rather than detecting it. */
  adapter?: AdapterId
  /** `check`: the commit to judge. Defaults to `HEAD`. */
  rev?: string
  /** `hook`: how the installed hook should invoke cutver. */
  runner?: string
  /** The repository root. Defaults to the working directory. */
  cwd?: string
  /** The branch name, for CI on a detached HEAD. */
  branch?: string
  /** The prerelease channel to cut in, already normalised to kebab-case. */
  channel: string | null
  /** Read this config instead of looking for one. */
  config?: string
  /** Every non-flag argument, in order. */
  positional: string[]
  /**
   * Spellings that still work and should not.
   *
   * Collected rather than warned about where they are read, so the notice lands
   * once the command has decided it is going to run — a deprecation printed
   * ahead of the argument error that stopped the run is noise on top of news.
   */
  deprecated: string[]
}

/**
 * `known` is the set of channels `--channel` will accept.
 *
 * One flag taking a value, rather than a flag per channel. Once a config can
 * name channels the set is open-ended, and a parser cannot enumerate names it
 * has not read yet — so `--channel canary` asks, and a repository that has no
 * canary channel is told which ones it does have.
 */
export function parse(
  argv: string[],
  known: readonly string[] = CHANNELS,
  /**
   * The command being parsed, so a flag can be refused where it means nothing.
   *
   * Omitted, every flag is accepted — which is what every caller did before
   * this existed, and what the tests driving `parse` directly still want.
   */
  command?: string,
): Options {
  const opts: Options = {
    dryRun: false,
    ifNeeded: false,
    offline: false,
    allowFirstPublish: false,
    force: false,
    noHook: false,
    regenerateChangelogs: false,
    channel: null,
    positional: [],
    deprecated: [],
  }
  const picked: string[] = []
  const allowed = command ? flagsAllowedFor(command) : null

  // Both `--adapter js` and `--adapter=js`. Hand-rolled rather than positional
  // filtering, because `args.find(a => !a.startsWith('--'))` picks up the
  // *value* of a space-separated flag and reads it as the version.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const eq = arg.indexOf('=')
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : null
    const next = () => inline ?? (argv[++i] as string | undefined)

    // **Refused where it means nothing, rather than dropped.** Every flag used
    // to be accepted by every command, so `cutver check --runner foo` exited 0
    // having silently ignored it — and the reference page annotated which
    // command each flag belonged to while nothing enforced it.
    if (allowed && arg.startsWith('-') && !allowed.has(name)) {
      die(
        `\`cutver ${command}\` does not take ${name}.\n` +
          `        \`cutver help ${command}\` lists the ones it does.`,
      )
    }

    switch (name) {
      case '-h':
      case '--help':
        console.log(help(VERSION))
        process.exit(0)
      case '-v':
      case '--version':
        console.log(VERSION)
        process.exit(0)
      case '--dry-run':
        opts.dryRun = true
        break
      case '--if-needed':
        opts.ifNeeded = true
        break
      case '--offline':
        opts.offline = true
        break
      case '--allow-first-publish':
        opts.allowFirstPublish = true
        break
      case '--force':
        opts.force = true
        break
      case '--regenerate-changelogs':
        opts.regenerateChangelogs = true
        opts.deprecated.push(
          '`--regenerate-changelogs` is now `cutver changelog`',
        )
        break
      case '--no-hook':
        opts.noHook = true
        break
      case '--adapter': {
        const value = next()
        if (!value || !(ADAPTER_IDS as readonly string[]).includes(value)) {
          die(`--adapter takes one of ${ADAPTER_IDS.join(', ')}`)
        }
        opts.adapter = value as AdapterId
        break
      }
      case '--cwd': {
        const value = next()
        if (!value) die('--cwd takes a path')
        opts.cwd = value
        break
      }
      case '--branch': {
        const value = next()
        if (!value) die('--branch takes a name')
        opts.branch = value
        break
      }
      case '--rev': {
        const value = next()
        if (!value) die('--rev takes a commit')
        opts.rev = value
        break
      }
      case '--runner': {
        const value = next()
        if (!value) die('--runner takes a command')
        opts.runner = value
        break
      }
      case '--config': {
        const value = next()
        if (!value) die('--config takes a path')
        opts.config = value
        break
      }
      case '--channel': {
        const value = next()
        if (!value) die(`--channel takes one of ${known.join(', ')}`)

        // Normalised exactly as its config key is, so `--channel myPrefix` and
        // `--channel prerelease` land where `myPrefix:` and `prerelease:` do.
        const asked = KEY_ALIASES[toKebab(value)] ?? toKebab(value)
        if (!known.includes(asked)) {
          die(
            `'${value}' is not a channel in this repository.\n` +
              `        There is ${known.join(', ')} — add another by adding a ` +
              `key to your config.`,
          )
        }
        picked.push(asked)
        opts.deprecated.push(
          '`--channel ' + asked + '` is now `cutver stage ' + asked + '`',
        )
        break
      }
      default: {
        if (arg.startsWith('-'))
          die(`unknown option ${arg} — \`cutver help\` lists them`)
        // Collected as well as assigned. `explicit` is the version a bare
        // `cutver` takes and refuses to see twice; `positional` is the same
        // arguments without that opinion, for subcommands that legitimately
        // take two — `notes <from> <to>`. Parsed once here rather than
        // re-walked by the caller, which would have to know which arguments
        // were flag *values* to get it right.
        opts.positional.push(arg)
        // The first one, for the commands that take exactly one. A second is
        // not recorded separately: `stage` refuses one by counting
        // `positional`, which covers `notes` too, and the field that used to
        // hold it was read by nothing.
        opts.explicit ??= arg
      }
    }
  }

  if (picked.length > 1) {
    die(`pass --channel once, not ${picked.join(' and ')}`)
  }
  opts.channel = picked[0] ?? null
  return opts
}

/**
 * The two flags that must be read before the real parse can happen.
 *
 * Channel flags come from the config, and the config's location comes from
 * `--cwd`/`--config` — so those two are extracted first, by a scan that knows
 * nothing else. Ten lines to avoid a chicken-and-egg, and it deliberately does
 * not validate: the real parse does that, once, with the full flag set.
 */
export function preScan(argv: string[]): { cwd?: string; config?: string } {
  const out: { cwd?: string; config?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    for (const key of ['cwd', 'config'] as const) {
      if (arg === `--${key}`) out[key] = argv[i + 1]
      else if (arg.startsWith(`--${key}=`)) out[key] = arg.slice(key.length + 3)
    }
  }
  return out
}

/**
 * Which adapter to use, and where that decision came from.
 *
 * `--adapter` beats `target:` beats detection, and detection still refuses to
 * guess when both manifests exist — a config that answered silently would
 * remove a safety that is there for a reason.
 *
 * @returns the adapter id, and which of the three settled it. `explain` prints
 *          the provenance, which is the only reason it is returned at all.
 */
export async function resolveAdapter(
  root: string,
  opts: { adapter?: AdapterId },
  config: Config,
): Promise<{ id: AdapterId; from: 'flag' | 'config' | 'detected' }> {
  if (opts.adapter) return { id: opts.adapter, from: 'flag' }
  if (config.target) return { id: ADAPTER_FOR[config.target], from: 'config' }

  const available = await applicableAdapters(root)
  if (!available.length) die(`no package.json or Cargo.toml in ${root}`)
  if (available.length > 1) {
    die(
      `${root} has ${available.map(id => ADAPTERS[id].manifest).join(' and ')}.\n` +
        `        Say which one this release is about: --adapter ${available.join('|')},\n` +
        '        or set `target` in your config.',
    )
  }
  return { id: available[0] as AdapterId, from: 'detected' }
}

/**
 * Say what still works and should not, once, on stderr.
 *
 * Not fatal and not silent. `--channel` and `--regenerate-changelogs` are in
 * every workflow and every shell history that predates 2.0, so removing them
 * outright would break runs for a rename; leaving them undocumented would mean
 * nobody ever moves. They keep working and they say what they became.
 */
export function reportDeprecated(
  opts: Options,
  config?: { warnings: string[] },
): void {
  for (const d of opts.deprecated) {
    console.error(
      `cutver: ${d}. The old spelling still works, and goes away in 3.0.`,
    )
  }
  // **The config's own deprecations, which nothing was printing.**
  // `parseConfig` has collected these since `publish` became a boolean, and
  // every consumer ignored them — so a repository whose config used a spelling
  // due for removal was told nothing by any command, including the one whose
  // whole job is to say what is wrong. They arrive already worded; this only
  // has to say them.
  for (const w of config?.warnings ?? []) console.error(`cutver: ${w}`)
}

/** An absolute root with forward slashes, drive letter intact on Windows. */
export function resolveRoot(cwd: string | undefined): string {
  return (cwd ? Bun.pathToFileURL(cwd).pathname : process.cwd())
    .replace(/^\/([A-Za-z]:)/, '$1')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
}
