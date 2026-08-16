/**
 * `cutver doctor` — everything `check` deliberately will not say.
 *
 * **The two exist because they answer to different callers.** `check` runs from
 * a pre-push hook on every branch of every push, so almost everything it could
 * find has to be swallowed: a broken config, a missing manifest, its own crash.
 * Blocking a push over any of them would wedge the repository. That silence is
 * correct there and useless when something is actually wrong.
 *
 * This is the command for that moment. It asks every question at once — the
 * config as resolved, the plan for this branch, drift between the config and
 * the generated workflows, whether the summariser can actually run, and whether
 * the registry has heard of each package — and reports all of it rather than
 * stopping at the first answer. A release fails for one reason at a time; being
 * told them one release at a time is the slow way to find out.
 *
 * Read-only throughout. It exits 1 when it finds something that would fail or
 * refuse a release, so it is usable as a CI gate, and 0 otherwise.
 */
import { ADAPTERS, applicableAdapters } from '../adapters'
import { loadConfig } from '../config/load'
import {
  channelNames,
  publishesToRegistry,
  type Config,
} from '../config/schema'
import { inspect, readWorkflows } from '../drift'
import { currentBranch, isGitRepo } from '../git'
import { plan, PlanRefusal } from '../plan'
import { checkRegistry, detectOidc } from '../registry'
import { keyFor } from '../summarize/connectors'
import { COMMAND_ENV } from '../summarize'
import { parse, preScan, resolveAdapter, resolveRoot } from './args'
import { env } from '../runtime'

/** How each line is marked. `✗` is the only one that changes the exit code. */
type Level = 'ok' | 'note' | 'bad'

const MARK: Record<Level, string> = { ok: '✓', note: '·', bad: '✗' }

/** One finding, in the order it was asked. */
interface Finding {
  level: Level
  /** The subject, padded into a column — `config`, `branch`, `registry`. */
  topic: string
  detail: string
  /** Printed indented underneath, for anything that needs more than a line. */
  more?: string
}

/**
 * The headline of a multi-line message.
 *
 * Every message here is written for a full-width report — several lines, often
 * with the fix pasted in — and this is a column. The rest is not discarded
 * blindly: drift findings carry their docs link across in `more`.
 */
function firstLine(message: string): string {
  return message.split('\n')[0] ?? message
}

function say(f: Finding, width: number): void {
  console.log(`  ${MARK[f.level]} ${f.topic.padEnd(width)}  ${f.detail}`)
  if (f.more)
    for (const line of f.more.split('\n'))
      console.log(`      ${' '.repeat(width)}${line}`)
}

/**
 * Whether the summariser could actually run, which is three separate things.
 *
 * Switched on, pointed at a provider, and holding a key. Every one of them can
 * be true alone and useless — and the failure is silent by design, because a
 * release must never die over its notes. So it is worth a line here, where
 * nothing is at stake and somebody is looking.
 */
function summariser(
  config: Config,
  env: Record<string, string | undefined>,
): Finding {
  const declared = config.changelog?.summarizer
  if (!declared) {
    return { level: 'note', topic: 'summariser', detail: 'off' }
  }
  if (env[COMMAND_ENV]?.trim()) {
    return {
      level: 'ok',
      topic: 'summariser',
      detail: `${COMMAND_ENV} is set, and wins`,
    }
  }

  // `true` asked for the command and there is none. **This is the case the
  // nesting made unambiguous**: it used to be `summarize: true` with no
  // top-level block, which read identically to a half-finished config.
  if (declared === true) {
    return {
      level: 'bad',
      topic: 'summariser',
      detail: `\`changelog.summarizer: true\` asks for ${COMMAND_ENV}, which is not set`,
      more: 'Set it, or name a provider under `changelog.summarizer:` instead.',
    }
  }

  const { value, tried } = keyFor(declared.connector, env)
  return value
    ? {
        level: 'ok',
        topic: 'summariser',
        detail: `${declared.connector}, ${declared.model}, key present`,
      }
    : {
        level: 'bad',
        topic: 'summariser',
        detail: `${declared.connector} is configured but no key is set`,
        more: `Looked in ${tried.join(', ')}. The release body would go out as written.`,
      }
}

export async function runDoctor(argv: string[]): Promise<void> {
  const pre = preScan(argv)
  const root = resolveRoot(pre.cwd)
  const found: Finding[] = []

  const loaded = await loadConfig(root, pre.config).catch((e: Error) => e)
  if (loaded instanceof Error) {
    // Nothing below can be asked without it, so this is the one early exit.
    console.log(`cutver: ${root}`)
    console.log(`  ${MARK.bad} config  ${firstLine(loaded.message)}`)
    process.exit(1)
  }

  const { config } = loaded
  const opts = parse(argv, channelNames(config), 'doctor')
  console.log(`cutver: ${root}`)

  found.push({
    level: 'ok',
    topic: 'config',
    detail: config.source ?? 'none — running on the defaults',
  })
  found.push({
    level: 'note',
    topic: 'channels',
    detail: channelNames(config).length
      ? channelNames(config).join(', ')
      : 'release only',
  })

  if (!(await isGitRepo(root))) {
    found.push({ level: 'bad', topic: 'git', detail: 'not a git repository' })
  } else {
    const ids = await applicableAdapters(root)
    if (!opts.adapter && !ids.length) {
      found.push({
        level: 'bad',
        topic: 'adapter',
        detail: 'no package.json or Cargo.toml here',
      })
    } else {
      const { id, from } = await resolveAdapter(root, opts, config)
      found.push({ level: 'ok', topic: 'adapter', detail: `${id} (${from})` })

      const branch = opts.branch ?? (await currentBranch(root))
      let version: string | null = null

      try {
        const decision = await plan({
          root,
          current: await ADAPTERS[id].readVersion(root),
          branch,
          channel: opts.channel,
          config,
        })
        version = decision.kind === 'release' ? decision.version : null
        found.push({
          level: decision.kind === 'release' ? 'ok' : 'note',
          topic: 'branch',
          detail:
            decision.kind === 'release'
              ? `'${branch}' would release ${decision.version}`
              : `'${branch}' releases nothing (${decision.why})`,
        })

        // **Non-conventional commits are counted here and nowhere else that is
        // easy to look at.** They contribute to neither the version nor the
        // changelog, silently, so a repository where half the history is `wip`
        // gets a patch bump and a thin changelog with nothing saying why.
        const stray = decision.survey?.unconventional ?? []
        if (stray.length) {
          found.push({
            level: 'note',
            topic: 'commits',
            detail: `${stray.length} not in conventional form — counted for nothing`,
            more:
              stray.slice(0, 3).join('\n') +
              (stray.length > 3 ? `\n… and ${stray.length - 3} more` : ''),
          })
        }
      } catch (e) {
        found.push({
          level: e instanceof PlanRefusal ? 'bad' : 'note',
          topic: 'branch',
          detail: firstLine((e as Error).message),
        })
      }

      // Drift needs a version to judge the dist-tag arm against. Without one —
      // a branch that releases nothing — the channel-specific half is skipped
      // and the rest still applies.
      const drift = inspect(
        await readWorkflows(root),
        config,
        version ?? '0.0.0',
        id,
      )
      if (!drift.length) {
        found.push({
          level: 'ok',
          topic: 'workflows',
          detail: 'in step with the config',
        })
      }
      for (const d of drift) {
        found.push({
          level: d.level === 'refuse' ? 'bad' : 'note',
          topic: 'workflows',
          detail: firstLine(d.message),
          more: `Docs: ${d.docs}`,
        })
      }

      if (opts.offline) {
        found.push({
          level: 'note',
          topic: 'registry',
          detail: 'skipped (--offline)',
        })
      } else if (!publishesToRegistry(id, config)) {
        found.push({
          level: 'note',
          topic: 'registry',
          detail: 'a tag here publishes to none',
        })
      } else {
        const oidc = detectOidc(
          process.env,
          id === 'cargo' ? 'crates.io' : 'npm',
        )
        found.push({
          level: oidc.available ? 'ok' : 'note',
          topic: 'oidc',
          detail: oidc.detail,
        })

        for (const p of await checkRegistry(
          await ADAPTERS[id].publishTargets(root),
        )) {
          found.push({
            level:
              p.published === true
                ? 'ok'
                : p.published === false
                  ? 'bad'
                  : 'note',
            topic: 'registry',
            detail:
              p.published === true
                ? `${p.target.name} published${p.latest ? ` (latest ${p.latest})` : ''}`
                : p.published === false
                  ? `${p.target.name} has never been published — needs --allow-first-publish`
                  : `${p.target.name}: the registry did not answer (${p.error})`,
          })
        }
      }
    }
  }

  found.push(summariser(config, env))

  // **The config's own deprecations.** `parseConfig` has collected these since
  // `publish` became a boolean, and nothing printed them — so this command,
  // whose whole promise is to say what `check` will not, answered "nothing
  // wrong here" against a config using a spelling that goes away in 3.0.
  //
  // A note rather than a problem: the old spelling still works, so it does not
  // affect this release and must not change the exit code.
  for (const w of config.warnings) {
    found.push({ level: 'note', topic: 'config', detail: w })
  }

  const width = Math.max(...found.map(f => f.topic.length))
  for (const f of found) say(f, width)

  const bad = found.filter(f => f.level === 'bad').length
  console.log(
    bad
      ? `\ncutver: ${bad} problem(s) that would affect a release.`
      : '\ncutver: nothing wrong here.',
  )
  if (bad) process.exit(1)
}
