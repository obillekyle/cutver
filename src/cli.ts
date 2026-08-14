#!/usr/bin/env bun
/**
 * cutver — work out the next version, write it into every manifest, stop.
 *
 *     cutver                    # version computed from the commit messages
 *     cutver --dry-run          # show the computed bump, write nothing
 *     cutver 1.4.0              # explicit, overrides the computation
 *     cutver --beta             # 1.3.0-beta.0
 *     cutver --adapter cargo    # when a repo has both manifests
 *
 * **Does not publish, and that is the design rather than an omission.**
 * Publishing is the one irreversible step in the whole sequence — npm does not
 * allow a version number to be reused, by anyone, ever — so it gets its own
 * trigger, its own credentials, and a human or a workflow that decided to run
 * it. A tool that both rewrites the tree and pushes to a registry is one typo
 * away from a mistake nobody can take back. This gets the tree to a releasable
 * state and stops.
 *
 * What it will do is tell you, before writing anything, whether the publish
 * that follows can actually work: see `registry.ts` on why a package's first
 * release cannot go out through a trusted publisher.
 */
import {
  ADAPTER_IDS,
  ADAPTERS,
  AdapterError,
  applicableAdapters,
  type AdapterId,
  type Change,
} from './adapters'
import { rollChangelog } from './changelog'
import { ECOSYSTEMS, init, type Ecosystem } from './init'
import { installHook, uninstallHook } from './hook'
import { currentBranch, isGitRepo, remoteUrl, status } from './git'
import { plan, PlanRefusal, SEMVER } from './plan'
import { loadConfig } from './config/load'
import { channelNames, ConfigError, DEFAULT_CONFIG, type Config } from './config/schema'
import { explainReport } from './explain'
import {
  checkRegistry,
  detectOidc,
  normaliseRepo,
  repositoryMatches,
  type Presence,
} from './registry'
import { CHANNELS, type Channel } from './version-from-commits'

// Injected by `bun build --compile --define`. A compiled executable does not
// carry package.json — the docs are explicit that it is not embedded by
// default — so reading the version from disk works in development and reports
// nothing at all from the binary, which is the one place a user is most likely
// to ask. `typeof` rather than a bare reference: undefined at dev time.
declare const CUTVER_VERSION: string | undefined
const VERSION: string =
  typeof CUTVER_VERSION === 'string' && CUTVER_VERSION ? CUTVER_VERSION : 'dev'

const HELP = `cutver ${VERSION} — cut a version from your commit messages.

  cutver [version] [options]
  cutver init <cargo|node|bun> [--force]
  cutver check [--branch <name>] [--rev <commit>]
  cutver hook install|uninstall
  cutver explain [--branch <name>]

  version               an explicit semver, overriding the computation
  init                  write version.yml + publish.yml for that ecosystem
  check                 exit 1 only if this branch may not release what it implies
  hook                  install or remove the pre-push guard that runs check
  explain               which rule claims this branch, and what else was tried

Options
  --dry-run             compute and report, write nothing
  --alpha|--beta|--rc   cut a prerelease in that channel (--prerelease = --rc)
  --<channel>           any other channel declared in cutver.json / cutver.yml
  --adapter js|cargo    force the manifest adapter (default: detected)
  --cwd <path>          repository root (default: the working directory)
  --branch <name>       branch name, for CI on a detached HEAD
  --if-needed           exit 0 rather than 1 when no release is warranted
  --offline             skip the registry preflight
  --allow-first-publish proceed even though a package is not on the registry yet
  --force               (init, hook) replace files that are already there
  --rev <commit>        (check) the commit to judge, default HEAD
  --runner <cmd>        (hook) how the hook should invoke cutver
  --no-hook             (init) do not install the pre-push guard
  --config <path>       read this config instead of looking for one
  -h, --help            this
  -v, --version         print the version of cutver itself

It never publishes. It bumps manifests and prints what to do next.`

function die(message: string): never {
  console.error(`cutver: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------- arguments

interface Options {
  explicit?: string
  dryRun: boolean
  ifNeeded: boolean
  offline: boolean
  allowFirstPublish: boolean
  force: boolean
  noHook: boolean
  adapter?: AdapterId
  rev?: string
  runner?: string
  cwd?: string
  branch?: string
  channel: string | null
  config?: string
}

/**
 * Which channels have a flag.
 *
 * Derived from the config, so `--canary` exists exactly when the repository
 * declares a canary channel — and an unknown flag still dies with today's
 * message rather than being silently accepted.
 */
function parse(argv: string[], known: readonly string[] = CHANNELS): Options {
  const opts: Options = {
    dryRun: false,
    ifNeeded: false,
    offline: false,
    allowFirstPublish: false,
    force: false,
    noHook: false,
    channel: null,
  }
  const picked: string[] = []

  // Both `--adapter js` and `--adapter=js`. Hand-rolled rather than positional
  // filtering, because `args.find(a => !a.startsWith('--'))` picks up the
  // *value* of a space-separated flag and reads it as the version.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const eq = arg.indexOf('=')
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : null
    const next = () => inline ?? (argv[++i] as string | undefined)

    switch (name) {
      case '-h':
      case '--help':
        console.log(HELP)
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
      default: {
        // `--prerelease` is the same spelling alias the branch names take, and
        // resolves to the same canonical `rc`.
        const channel =
          name === '--prerelease' && known.includes('rc')
            ? 'rc'
            : known.find(c => name === `--${c}`)
        if (channel) {
          picked.push(channel)
          break
        }
        if (arg.startsWith('-')) die(`unknown option ${arg}\n\n${HELP}`)
        if (opts.explicit) die(`two versions given: ${opts.explicit} and ${arg}`)
        opts.explicit = arg
      }
    }
  }

  if (picked.length > 1) {
    die(`pick one channel, not ${picked.map(c => `--${c}`).join(' and ')}`)
  }
  opts.channel = picked[0] ?? null
  return opts
}

// ------------------------------------------------------------------ output

const MARK = { updated: '↑', unchanged: '=', absent: '·' } as const

function report(changes: Change[]): void {
  const width = Math.max(...changes.map(c => c.file.length), 0)
  for (const c of changes) {
    console.log(`  ${MARK[c.state]} ${c.file.padEnd(width)}  ${c.detail}`)
  }
}

/**
 * The preflight, and the one place this tool refuses to continue over
 * something that is not yet wrong.
 *
 * A package the registry has never heard of cannot be published by a trusted
 * publisher — npm has nowhere to attach one until the package exists. Every
 * later step still succeeds: the manifests bump, the commit lands, the tag
 * goes up, and only the final publish 403s, by which point the version number
 * is spent and the tag is a promise about something nobody can install.
 *
 * So it stops here, before the first write, and names the escape hatch. It is
 * emphatically *not* a refusal to do a first release — it is a refusal to do
 * one by accident.
 */
function preflight(
  found: Presence[],
  remote: string | null,
  allowFirst: boolean,
  dryRun: boolean,
): void {
  if (!found.length) {
    console.log('\npreflight: nothing this repository publishes')
    return
  }

  const registry = found[0]?.target.registry === 'crates' ? 'crates.io' : 'npm'
  const oidc = detectOidc()
  console.log(`\npreflight (${found.length} package(s) on ${registry})`)
  console.log(`  ${oidc.available ? '✓' : '·'} oidc  ${oidc.detail}`)

  // **Warned about, not written.** A publish under trusted publishing carries
  // a provenance statement naming the repository that built it, and npm
  // rejects a tarball whose manifest disagrees — including one that says
  // nothing, which it normalises to the empty string. cutver hit this on its
  // own first automated release, after the tag had already been pushed.
  //
  // Deriving the field from `git remote get-url origin` would fix the common
  // case and encode a wrong answer on a fork, where it would pass here and
  // fail identically upstream. It also cannot fix the other half — a
  // `repository` that is present and stale, which produces the same 422.
  const mismatched = found.filter(p => !repositoryMatches(p.target.repository, remote))
  if (remote && mismatched.length) {
    const short = normaliseRepo(remote)
    for (const p of mismatched) {
      const declared = p.target.repository
      console.log(
        `  ! repo  ${p.target.name} ${declared ? `names ${normaliseRepo(declared)}` : 'names no repository'}, ` +
          `but this checkout is ${short}`,
      )
    }
    console.log(
      '         A provenance publish is refused when those disagree (npm 422).\n' +
        `         Set "repository" in the manifest to ${short} before tagging.`,
    )
  }

  const width = Math.max(...found.map(p => p.target.name.length), 4)
  for (const p of found) {
    const mark = p.published === true ? '✓' : p.published === false ? '✗' : '?'
    const note =
      p.published === true
        ? `published${p.latest ? ` (latest ${p.latest})` : ''}`
        : p.published === false
          ? 'NOT on the registry — this would be its first publish'
          : `could not ask the registry (${p.error})`
    console.log(`  ${mark} ${p.target.name.padEnd(width)}  ${note}`)
  }

  const unknown = found.filter(p => p.published === null)
  if (unknown.length) {
    // Never fatal. A release that cannot be cut because a laptop is offline is
    // a worse failure than the one this check prevents.
    console.log('  ! the registry did not answer for some packages — continuing anyway')
  }

  const missing = found.filter(p => p.published === false)
  if (!missing.length) return

  if (allowFirst) {
    console.log('  ! --allow-first-publish, so this is fine')
    return
  }

  // Registry-specific, because the reason is. On npm there is nowhere to
  // attach a trusted publisher until the package exists; on crates.io the
  // first publish is what reserves the name, and a trusted publisher is
  // configured against a crate that is already there. Same consequence either
  // way: release one is a manual, token-authenticated act.
  const why =
    registry === 'npm'
      ? 'A first publish cannot go through npm trusted publishing (OIDC): there is\n' +
        '        nowhere to attach a trusted publisher until the package exists.'
      : 'On crates.io the first publish is what reserves the name; a trusted\n' +
        '        publisher is configured against a crate that already exists.'

  const message =
    `${missing.length} package(s) have never been published:\n` +
    missing.map(p => `          ${p.target.name}`).join('\n') +
    `\n\n        ${why}\n` +
    '        Release one goes out by hand with a token; every release after it\n' +
    '        can be automated.\n\n' +
    '        Pass --allow-first-publish once you have read that and meant it.'

  // A dry run writes nothing, so stopping it here would withhold the very
  // report it was asked for. It says where a real run would stop instead.
  if (dryRun) {
    console.error(`cutver: a real run would stop here — ${message}`)
    return
  }

  die(message)
}

// -------------------------------------------------------------------- main

/**
 * A function rather than a top-level await, and it is not a style choice.
 * `bun build --compile --bytecode` emits CommonJS — bytecode compilation
 * requires it — and CommonJS has no top-level await, so a module-scoped
 * `await` here fails the build with an error that points at the line rather
 * than at the reason. The whole entry lives in `main()` so the compiled binary
 * and `bun run src/cli.ts` are the same program.
 */
/**
 * The two flags that must be read before the real parse can happen.
 *
 * Channel flags come from the config, and the config's location comes from
 * `--cwd`/`--config` — so those two are extracted first, by a scan that knows
 * nothing else. Ten lines to avoid a chicken-and-egg, and it deliberately does
 * not validate: the real parse does that, once, with the full flag set.
 */
function preScan(argv: string[]): { cwd?: string; config?: string } {
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
 */
async function resolveAdapter(
  root: string,
  opts: { adapter?: AdapterId },
  config: Config,
): Promise<{ id: AdapterId; from: 'flag' | 'config' | 'detected' }> {
  if (opts.adapter) return { id: opts.adapter, from: 'flag' }
  if (config.target) return { id: config.target === 'cargo' ? 'cargo' : 'js', from: 'config' }

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

/** An absolute root with forward slashes, drive letter intact on Windows. */
function resolveRoot(cwd: string | undefined): string {
  return (cwd ? Bun.pathToFileURL(cwd).pathname : process.cwd())
    .replace(/^\/([A-Za-z]:)/, '$1')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
}

/**
 * `cutver init <cargo|node|bun>`.
 *
 * Deliberately does not require a git repository. Scaffolding the workflows is
 * the one thing here that makes sense in a tree that has not been initialised
 * yet, and refusing would send people to write the files by hand — which is
 * how the two gotchas in them get lost.
 */
async function runInit(argv: string[]): Promise<void> {
  const opts = parse(argv, [])
  const eco = opts.explicit

  if (!eco || !(ECOSYSTEMS as readonly string[]).includes(eco)) {
    die(`init takes one of ${ECOSYSTEMS.join(', ')} — e.g. \`cutver init cargo\``)
  }

  const root = resolveRoot(opts.cwd)
  const { config } = await loadConfig(root, opts.config).catch((e: Error) => die(e.message))
  const results = await init(root, eco as Ecosystem, {
    force: opts.force,
    dryRun: opts.dryRun,
    hook: !opts.noHook,
    version: VERSION,
    config,
  })

  console.log(`cutver: ${root} (${eco})${opts.dryRun ? ' — dry run, nothing written' : ''}`)
  const width = Math.max(...results.map(r => r.path.length))
  for (const r of results) {
    console.log(`  ${r.state === 'written' ? '↑' : '='} ${r.path.padEnd(width)}  ${r.detail}`)
  }

  // A new devDependency and an unchanged lockfile disagree, and the generated
  // workflow installs with `--frozen-lockfile` — so the very first CI run
  // would fail on the dependency this command just added. Say it first,
  // because it is the only step that breaks something if skipped.
  const pinned = results.find(r => r.path === 'package.json' && r.state === 'written')
  if (pinned) {
    console.log(
      `\n  first: run your package manager's install. ${pinned.detail} is in\n` +
        '         package.json and not yet in the lockfile, and the generated\n' +
        '         workflow installs with --frozen-lockfile.',
    )
  }

  console.log(
    '\n  next:  read both workflows — the comments in them are the reasons, not\n' +
      '         decoration. Set your gates in version.yml; cutver cannot know\n' +
      '         what they are. Release one is published by hand: a trusted\n' +
      '         publisher cannot create a package that does not exist yet.',
  )
}

/**
 * `cutver check` — is this branch allowed to release what its commits imply?
 *
 * Read-only, offline, and with exit codes suited to a hook rather than to a
 * person: **0 for "nothing to release"**, which is not a problem and must not
 * block a push, and 1 only for the branch-declared refusal.
 *
 * Anything else — cutver crashed, git is broken, the manifest will not parse —
 * also exits 0, loudly. A guard that fails closed on its own bug blocks every
 * push in the repository, and CI still catches the real thing.
 */
async function runCheck(argv: string[]): Promise<void> {
  const pre = preScan(argv)
  const root = resolveRoot(pre.cwd)

  try {
    // The config is loaded inside the try on purpose: a repository with a
    // broken or too-new config must not have every push blocked by it. A
    // ConfigError is not a PlanRefusal, so the catch below lets the push
    // through and says why.
    const { config } = await loadConfig(root, pre.config)
    const opts = parse(argv, channelNames(config))
    const rev = opts.rev ?? 'HEAD'
    // Both of these are ordinary states rather than errors — a hook lives in
    // repositories cutver was never set up for — so they are named plainly
    // instead of arriving as a stack trace about `undefined`.
    if (!(await isGitRepo(root))) {
      console.error(`cutver: check skipped — ${root} is not a git repository`)
      return
    }
    const ids = await applicableAdapters(root)
    if (!opts.adapter && !ids.length) {
      console.error('cutver: check skipped — no package.json or Cargo.toml here')
      return
    }

    const adapter = ADAPTERS[(await resolveAdapter(root, opts, config)).id]
    const branch = opts.branch ?? (await currentBranch(root))
    const decision = await plan({
      root,
      current: await adapter.readVersion(root),
      branch,
      channel: opts.channel,
      rev,
      config,
    })

    // **`no-rule` exits 0 here, and that is the whole reason it is a Plan
    // variant rather than a PlanRefusal.** This runs from the pre-push hook on
    // every branch of every push; refusing an unmatched branch would block
    // every feature branch in the repository, forever.
    console.log(
      decision.kind === 'release'
        ? `cutver: check ok — '${branch}' would release ${decision.version}`
        : `cutver: check ok — '${branch}' releases nothing (${decision.why})`,
    )
  } catch (e) {
    if (e instanceof PlanRefusal) {
      console.error(`cutver: ${e.message}`)
      console.error('        Push with --no-verify if the branch is right.')
      process.exit(1)
    }
    // Not the refusal. Say so and get out of the way.
    console.error(`cutver: check skipped — ${(e as Error).message}`)
  }
}

/** `cutver hook install|uninstall`. */
async function runHook(argv: string[]): Promise<void> {
  const action = argv[0]
  if (action !== 'install' && action !== 'uninstall') {
    die('hook takes `install` or `uninstall`')
  }

  const opts = parse(argv.slice(1))
  const root = resolveRoot(opts.cwd)
  if (!(await isGitRepo(root))) die(`${root} is not a git repository`)

  const result =
    action === 'install'
      ? await installHook(root, {
          force: opts.force,
          dryRun: opts.dryRun,
          runner: opts.runner,
          version: VERSION,
        })
      : await uninstallHook(root, { dryRun: opts.dryRun })

  console.log(
    `cutver: ${result.state === 'written' ? '↑' : '='} ${result.path}  ${result.detail}` +
      (opts.dryRun ? ' (dry run)' : ''),
  )

  if (action === 'install' && result.state === 'written') {
    console.log(
      '\n  It refuses a push to a release branch whose name promises a lower\n' +
        '  version than its commits justify. Everything else it lets through —\n' +
        '  including its own failures. `git push --no-verify` bypasses it.',
    )
  }
}

/**
 * `cutver explain` — read-only, offline, and always exit 0.
 *
 * Same posture as `check`, for the same reason: it is a diagnostic, and a
 * diagnostic that can fail is one more thing to diagnose.
 */
async function runExplain(argv: string[]): Promise<void> {
  const pre = preScan(argv)
  const root = resolveRoot(pre.cwd)

  try {
    const { config } = await loadConfig(root, pre.config)
    const opts = parse(argv, channelNames(config))
    const adapter = await resolveAdapter(root, opts, config)
    const branch = opts.branch ?? (await currentBranch(root))

    let summary: string | null = null
    try {
      const decision = await plan({
        root,
        current: await ADAPTERS[adapter.id].readVersion(root),
        branch,
        channel: opts.channel,
        config,
      })
      summary =
        decision.kind === 'release'
          ? `${decision.from} -> ${decision.version} (${decision.why})`
          : decision.why
    } catch (e) {
      summary = `REFUSED — ${(e as Error).message.split('\n')[0]}`
    }

    for (const line of explainReport({
      root,
      branch,
      config,
      adapter: adapter.id,
      adapterFrom: adapter.from,
      plan: summary,
    })) {
      console.log(line)
    }
  } catch (e) {
    console.error(`cutver: ${(e as Error).message}`)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === 'init') return runInit(argv.slice(1))
  if (argv[0] === 'check') return runCheck(argv.slice(1))
  if (argv[0] === 'hook') return runHook(argv.slice(1))
  if (argv[0] === 'explain') return runExplain(argv.slice(1))

  const pre = preScan(argv)
  const root = resolveRoot(pre.cwd)

  // Loaded before anything else reads a file: a config that is wrong should
  // cost an error message, never a version number.
  const { config } = await loadConfig(root, pre.config).catch((e: Error) => die(e.message))
  const opts = parse(argv, channelNames(config))

  if (!(await isGitRepo(root))) {
    die(`${root} is not a git repository — the version is computed from its commits`)
  }

  // The adapter. Detected from which manifest exists; asked for when both do,
  // because a repository with a Cargo.toml *and* a package.json is common and
  // guessing would eventually bump the wrong one.
  const adapter = ADAPTERS[(await resolveAdapter(root, opts, config)).id]

  let current: string
  try {
    current = await adapter.readVersion(root)
  } catch (e) {
    die(e instanceof AdapterError ? e.message : String(e))
  }

  const branch = opts.branch ?? (await currentBranch(root))
  console.log(`cutver: ${root} (${adapter.id}, at ${current}, on '${branch}')`)

  const decision = await plan({
    root,
    current,
    branch,
    channel: opts.channel,
    explicit: opts.explicit,
    config,
  }).catch((e: Error) => die(e.message))

  if (decision.survey) {
    const { survey } = decision
    console.log(`cutver: ${survey.total} commit(s) since ${survey.since}`)
    for (const { level, subjects } of survey.tally) {
      console.log(`  ${level.padEnd(5)} ${subjects.length}`)
      // Show the work. A computed version nobody can check is worse than a typed
      // one: the reason for a major has to be visible before it is tagged.
      for (const s of subjects.slice(0, 3)) console.log(`        ${s}`)
      if (subjects.length > 3) console.log(`        … and ${subjects.length - 3} more`)
    }

    // The two ranges, when they differ. Without this line the output shows a
    // single `fix:` and then announces a major, with nothing on screen saying
    // where the major came from — and an unexplained number is the one thing
    // showing the work is supposed to prevent.
    if (survey.base) {
      console.log(
        `  base  ${survey.base.bump} across ${survey.base.total} commit(s) since ` +
          // Only call it the last stable release when there is one. With no
          // stable tag the base came from the manifest, and saying otherwise
          // would name a release that has never happened.
          (survey.base.since === 'the first commit'
            ? 'the first commit'
            : `${survey.base.since}, the last stable release`),
      )
    }
  }

  if (decision.kind === 'no-rule') {
    // Configured branch gating, doing its job: this branch may not release at
    // all. Green under --if-needed so CI on a feature branch stays quiet.
    if (opts.ifNeeded) {
      console.log(`cutver: ${decision.why}. Nothing written.`)
      process.exit(0)
    }
    die(
      `${decision.why}.
` +
        '        Add it to a channel in your config, or pass a version explicitly.',
    )
  }

  if (decision.kind === 'nothing') {
    const nothing = `nothing to release — ${decision.why}.`
    // Most pushes to a default branch are docs or chores and warrant no release
    // at all. Run from CI that is the *expected* outcome, not a failure —
    // without this every ordinary merge would end in a red cross, and a workflow
    // that is usually red is a workflow nobody reads.
    if (opts.ifNeeded) {
      console.log(`cutver: ${nothing}`)
      console.log('cutver: --if-needed, so this is fine. Nothing written.')
      process.exit(0)
    }
    die(`${nothing}\n        Pass a version explicitly to override.`)
  }

  const { version } = decision
  console.log(`cutver: ${decision.from} -> ${version} (${decision.why})`)

  // A release number is interpolated into every manifest and a git tag, so it is
  // validated rather than trusted — including the computed one, which is cheap
  // insurance against a bug in the arithmetic. Prerelease and build metadata are
  // allowed; a leading `v` is not, because the tag adds it and `v1.1.0` is not a
  // valid version string in any manifest.
  if (!SEMVER.test(version)) {
    die(`'${version}' is not a semver version (no leading 'v')`)
  }

  if (!opts.offline) {
    preflight(
      await checkRegistry(await adapter.publishTargets(root)),
      await remoteUrl(root),
      opts.allowFirstPublish,
      opts.dryRun,
    )
  } else {
    console.log('\npreflight: skipped (--offline)')
  }

  // A dirty tree means the release would capture edits nobody reviewed.
  const dirt = await status(root)
  if (dirt && !opts.dryRun) die(`working tree is not clean:\n${dirt}`)

  console.log(`\nfiles${opts.dryRun ? ' (dry run — nothing is written)' : ''}`)
  const changes = await adapter
    .setVersion({ root, version, dryRun: opts.dryRun })
    .catch((e: Error) => die(e instanceof AdapterError ? e.message : String(e)))

  const changelog = await rollChangelog({
    root,
    version,
    dryRun: opts.dryRun,
    // The caller's clock, formatted ISO-8601 like every other heading. Not
    // `toLocaleDateString` — a release note that reads differently depending on
    // who cut it is a small lie.
    today: new Date().toISOString().slice(0, 10),
  })

  report(changelog ? [...changes, changelog] : changes)

  const updated = [...changes, ...(changelog ? [changelog] : [])].filter(
    c => c.state === 'updated',
  ).length

  // **A prerelease published without a dist-tag becomes `latest`.** That is npm's
  // default, it is silent, and the consequence is that every plain install in the
  // world starts resolving to an alpha. Undoing it means re-tagging by hand
  // *after* users have already installed it, so the flag is printed here rather
  // than left to be remembered at the point of running the publish.
  const channel = opts.channel ?? /-([a-z]+)\./.exec(version)?.[1]

  console.log(
    opts.dryRun
      ? `\ncutver: dry run — ${updated} file(s) would change, none did.`
      : `\ncutver: ${updated} file(s) updated.\n` +
          '  next: review the diff, commit, tag ' +
          `v${version}, and publish from the tag.` +
          (channel && adapter.id === 'js'
            ? `\n\n  Publish this one with \`--tag ${channel}\`. Without it npm marks\n` +
              `  ${version} as \`latest\` and every plain install resolves to a\n` +
              `  prerelease. Consumers opt in with \`@${channel}\`.`
            : ''),
  )
}

main().catch((e: unknown) => {
  // Anything that got past a specific handler, printed with its stack: an
  // unexpected failure in a release tool is a bug report, not a user error,
  // and the one thing worse than the crash is a crash with no location.
  console.error(e)
  process.exit(1)
})
