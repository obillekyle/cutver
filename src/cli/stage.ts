/**
 * `cutver stage` — the one path that writes a version into the tree.
 *
 * **It reads top-to-bottom as the sequence it performs**, and the ordering is
 * the design rather than an accident: config, then git, then the plan, then
 * every refusal, and only afterwards the first write. Each check that can stop
 * a release is asked while stopping is still free. A tag is public forever and
 * a version number on npm can never be reused, so the expensive half of this
 * file is everything that happens before a byte changes.
 *
 * Pure output lives here too — `report`, `preflight`, `reportSurvey` — because
 * showing the work is not a side errand. A computed version nobody can check is
 * worse than a typed one.
 */
import { ADAPTERS, AdapterError, type Change } from '../adapters'
import { rollChangelog, writeChangelog } from '../changelog'
import { compileReleases } from '../changelog/compile'
import { loadConfig } from '../config/load'
import {
  channelNames,
  KEY_ALIASES,
  publishesToRegistry,
  RELEASE,
  toKebab,
  type Config,
} from '../config/schema'
import { channelOf, inspect, readWorkflows } from '../drift'
import {
  createTag,
  currentBranch,
  isGitRepo,
  remoteUrl,
  status,
  tagExists,
} from '../git'
import { plan, SEMVER, type Survey } from '../plan'
import {
  checkRegistry,
  detectOidc,
  normaliseRepo,
  repositoryMatches,
  type Presence,
} from '../registry'
import {
  die,
  parse,
  preScan,
  reportDeprecated,
  resolveAdapter,
  resolveRoot,
  type Options,
} from './args'
import { runChangelog } from './commands'
import { say, style, warn } from '../style'

/**
 * The minor bump inside 0.x, for the advice line.
 *
 * Conventional rather than mandated: semver says nothing below 1.0.0 is
 * guaranteed, so a break there is usually taken as a minor. Named only as the
 * alternative, never applied — cutver does not get to pick which of the two a
 * project meant.
 */
function bumpWithinZero(current: string): string {
  const [, minor = 0] = (current.split(/[-+]/)[0] ?? current)
    .split('.')
    .map(Number)
  return `0.${minor + 1}.0`
}

/** How each file's outcome is marked in the report column. */
// Green for a file that moved, dim for one that did not — the report is read
// by someone deciding whether to commit, and "what changed" is the question.
const MARK = {
  updated: '%g↑%0',
  unchanged: '%d=%0',
  absent: '%d·%0',
} as const

/**
 * The bump levels, coloured by what they cost a consumer.
 *
 * Red for a major is not "error" — it is the one row on screen that obliges
 * somebody downstream to do work, and the survey exists so that obligation is
 * visible *before* the tag rather than in a bug report after it. Green is
 * additive, cyan is a fix, and anything unrecognised stays grey rather than
 * borrowing a meaning it has not earned.
 */
const BUMP: Record<string, string> = {
  major: '%r',
  minor: '%g',
  patch: '%c',
}

/** One aligned line per file touched, or deliberately not touched. */
function report(changes: Change[]): void {
  const width = Math.max(...changes.map(c => c.file.length), 0)
  for (const c of changes) {
    // The path is the anchor; the detail is a note about it. Same three
    // weights the doctor report uses, for the same reason.
    say(`  ${MARK[c.state]} ${c.file.padEnd(width)}  %d${c.detail}%0`)
  }
}

/**
 * The commit survey — what was counted, and where the base came from.
 *
 * Kept out of the release sequence because it is the one block that is not a
 * step in it: pure output, two nested loops and a conditional sub-report,
 * touching nothing but its argument.
 */
function reportSurvey(survey: Survey): void {
  say(`cutver: %c${survey.total}%0 %dcommit(s) since ${survey.since}%0`)
  for (const { level, subjects } of survey.tally) {
    say(`  ${BUMP[level] ?? '%d'}${level.padEnd(5)}%0 %c${subjects.length}%0`)
    // Show the work. A computed version nobody can check is worse than a typed
    // one: the reason for a major has to be visible before it is tagged.
    for (const s of subjects.slice(0, 3)) say(`        %d${s}%0`)
    if (subjects.length > 3)
      say(`        %<dim>… and ${subjects.length - 3} more%0`)
  }

  // The two ranges, when they differ. Without this line the output shows a
  // single `fix:` and then announces a major, with nothing on screen saying
  // where the major came from — and an unexplained number is the one thing
  // showing the work is supposed to prevent.
  // **Counted for nothing, and that used to be invisible.** An unrecognised
  // subject raises no version and lands in no changelog section, so a run over
  // ten commits where six are `wip` reports a patch bump with nothing saying
  // where the other six went. Named, not acted on — guessing what `wip` meant
  // is the one thing this tool refuses to do.
  if (survey.unconventional.length) {
    const n = survey.unconventional.length
    say(
      `  %dnone%0  %y${n}%0 %dnot conventional — no version, no changelog entry%0`,
    )
    for (const s of survey.unconventional.slice(0, 3)) say(`        %d${s}%0`)
    if (n > 3) say(`        %<dim>… and ${n - 3} more%0`)
  }

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
 *
 * @param found      one entry per package a tag here would publish.
 * @param remote     `origin`, for the provenance check. `null` on a clone with
 *                   no remote, which skips that half rather than failing it.
 * @param allowFirst `--allow-first-publish`: proceed anyway, having read why.
 * @param dryRun     report where a real run would stop, rather than stopping.
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
  const oidc = detectOidc(process.env, registry)
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
  const mismatched = found.filter(
    p => !repositoryMatches(p.target.repository, remote),
  )
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
    console.log(
      '  ! the registry did not answer for some packages — continuing anyway',
    )
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

/** What `stage`'s one argument turned out to mean. */
interface Target {
  /** A version given outright, overriding the computation. */
  explicit?: string
  /** The prerelease channel to cut in, or `null` for whatever the branch says. */
  channel: string | null
  /** Cut a stable version whatever the branch is configured to cut. */
  stable: boolean
}

/**
 * One positional, two meanings, and no flag to tell them apart.
 *
 * **The config makes this unambiguous rather than merely convenient.** Channel
 * names are refused at load if they contain a digit — `rc2` and `v2-latest` are
 * both rejected — so nothing that parses as semver can also be a channel, and
 * the two namespaces cannot collide however the config is written. That is why
 * `cutver stage 1.4.0` and `cutver stage beta` can be the same argument.
 *
 * `release` is the third case. It is a channel key in the config but not a
 * prerelease identifier, so it maps to `stable` rather than to `channel`.
 */
function target(opts: Options, config: Config): Target {
  const [first, ...extra] = opts.positional
  if (extra.length) {
    die(`stage takes one channel or version, not ${opts.positional.length}`)
  }

  // `--channel`, deprecated in 2.0 and still honoured.
  const flagged = opts.channel
  if (!first) return { channel: flagged, stable: false }

  if (SEMVER.test(first))
    return { explicit: first, channel: flagged, stable: false }

  // Caught before the channel lookup so the message is about the `v`, which is
  // the actual mistake, rather than about a channel nobody was naming.
  if (/^v?\d/.test(first)) {
    die(
      `'${first}' is not a semver ` +
        `version${first.startsWith('v') ? " (no leading 'v')" : ''}`,
    )
  }

  const asked = KEY_ALIASES[toKebab(first)] ?? toKebab(first)
  if (asked === RELEASE) return { channel: null, stable: true }

  const known = channelNames(config)
  if (!known.includes(asked)) {
    die(
      `'${first}' is neither a version nor a channel in this repository.\n` +
        `        Channels here: ${[RELEASE, ...known].join(', ')} — add another by\n` +
        '        adding a key to your config. A version looks like 1.4.0.',
    )
  }

  if (flagged && flagged !== asked) {
    die(
      `--channel ${flagged} and \`stage ${asked}\` disagree — pass one of them`,
    )
  }
  return { channel: asked, stable: false }
}

/** `cutver stage`: compute the next version and write it into every manifest. */
export async function runStage(argv: string[]): Promise<void> {
  const pre = preScan(argv)
  const root = resolveRoot(pre.cwd)

  // Loaded before anything else reads a file: a config that is wrong should
  // cost an error message, never a version number.
  const { config } = await loadConfig(root, pre.config).catch((e: Error) =>
    die(e.message),
  )
  const opts = parse(argv, channelNames(config), 'stage')

  reportDeprecated(opts, config)

  const { explicit, channel, stable } = target(opts, config)

  if (!(await isGitRepo(root))) {
    die(
      `${root} is not a git repository — the version is computed from its ` +
        `commits`,
    )
  }

  if (opts.regenerateChangelogs) return runChangelog(argv)

  // The adapter. Detected from which manifest exists; asked for when both do,
  // because a repository with a Cargo.toml *and* a package.json is common and
  // guessing would eventually bump the wrong one.
  const adapterId = (await resolveAdapter(root, opts, config)).id
  const adapter = ADAPTERS[adapterId]

  let current: string
  try {
    current = await adapter.readVersion(root)
  } catch (e) {
    die(e instanceof AdapterError ? e.message : String(e))
  }

  const branch = opts.branch ?? (await currentBranch(root))
  say(
    `cutver: ${root} %d(${adapter.id}, at%0 %c${current}%0%d, on '${branch}')%0`,
  )

  const decision = await plan({
    root,
    current,
    branch,
    channel,
    stable,
    explicit,
    config,
  }).catch((e: Error) => die(e.message))

  if (decision.survey) reportSurvey(decision.survey)

  if (decision.kind === 'no-rule') {
    // Configured branch gating, doing its job: this branch may not release at
    // all. Green under --if-needed so CI on a feature branch stays quiet.
    if (opts.ifNeeded) {
      console.log(`cutver: ${decision.why}. Nothing written.`)
      process.exit(0)
    }
    die(
      `${decision.why}.\n` +
        '        Add it to a channel in your config, or pass a version explicitly.',
    )
  }

  if (decision.kind === 'nothing') {
    const nothing = `nothing to release — ${decision.why}.`
    // Most pushes to a default branch are docs or chores and warrant no release
    // at all. Run from CI that is the *expected* outcome, not a failure —
    // without this every ordinary merge would end in a red cross, and a
    // workflow that is usually red is a workflow nobody reads.
    if (opts.ifNeeded) {
      console.log(`cutver: ${nothing}`)
      console.log('cutver: --if-needed, so this is fine. Nothing written.')
      process.exit(0)
    }
    die(`${nothing}\n        Pass a version explicitly to override.`)
  }

  const { version } = decision
  // **The one line this whole tool exists to print.** The version being cut is
  // the only thing on screen that cannot be recovered once it is wrong, so it
  // is the only thing here in bold: the number you came from recedes, the
  // reason is a footnote, and the number you are about to spend is unmissable.
  say(
    `cutver: %d${decision.from}%0 %d->%0 %<bold>%c${version}%0 ` +
      `%d(${decision.why})%0`,
  )

  // A release number is interpolated into every manifest and a git tag, so it
  // is validated rather than trusted — including the computed one, which is
  // cheap insurance against a bug in the arithmetic. Prerelease and build
  // metadata are allowed; a leading `v` is not, because the tag adds it and
  // `v1.1.0` is not a valid version string in any manifest.
  if (!SEMVER.test(version)) {
    die(`'${version}' is not a semver version (no leading 'v')`)
  }

  // **Graduating to 1.0.0 is a decision, and this is where it gets asked.**
  //
  // The arithmetic is right and stays as it is: semver says a `feat!` is a
  // major, and `applyBump` applies it. What it cannot know is that crossing out
  // of 0.x means something no rule can decide — 0.x is the range where the
  // author is still allowed to change their mind, and 1.0.0 is a promise to
  // stop. cutver reads commit messages; it does not know whether the API is
  // finished.
  //
  // Left alone this is the most expensive accident available here. The
  // generated `version.yml` runs `stage --if-needed` unattended and then
  // commits, tags and pushes, so a 0.x project's first `feat!` ships 1.0.0 to a
  // registry with nobody in the loop — and npm never gives a number back.
  //
  // Refused rather than capped at `0.(minor+1).0`. Capping is also a policy,
  // silently disagreeing with what the arithmetic says, and it would leave two
  // answers to the same question. A refusal spends nothing and names both ways
  // out. `--if-needed` does not soften it: that flag means no release was
  // warranted, and this is one that is warranted and cannot be cut for you.
  if (
    !explicit &&
    current.startsWith('0.') &&
    /^1\.0\.0(?:$|[-+])/.test(version)
  ) {
    die(
      `these commits imply ${version}, and this project is at ${current}.\n` +
        '        Leaving 0.x is a promise about the API rather than a fact\n' +
        '        about the commits, so cutver will not make it for you.\n\n' +
        '        If the API is settled:\n' +
        '          cutver stage 1.0.0\n' +
        '        If it is not, a breaking change below 1.0.0 is conventionally\n' +
        '        a minor:\n' +
        `          cutver stage ${bumpWithinZero(current)}`,
    )
  }

  // **Refused before anything is written, because the failure lands after.**
  // The version is computed from reachable history and the tag namespace is the
  // whole repository, so the two can disagree: a release whose bump commit left
  // the branch — rewritten, force-pushed, never merged — leaves its tag behind,
  // and the next run recomputes exactly that version.
  //
  // Nothing here notices. The manifests are written, the workflow commits and
  // pushes them, and `git tag` is what finally fails — with the bump already
  // public and the branch carrying a release that does not exist.
  //
  // **The case that produced this guard was a local one, and that is the more
  // useful lesson.** Two repositories looked orphaned — tag present, its commit
  // not an ancestor — and both were simply clones that had diverged from a
  // release commit already sitting on origin. A fetch would have shown it. But
  // `stage` runs against whatever history it is given, and against that stale
  // tree it computed a version whose tag existed and would have written every
  // manifest before anything complained. Reachable history and the tag
  // namespace disagree either way; where the disagreement came from does not
  // change what this has to do about it.
  //
  // Not softened by `--if-needed`. That flag means "no release was warranted",
  // and this is the opposite: one is warranted and cannot be cut.
  if (await tagExists(root, `v${version}`)) {
    die(
      `v${version} already exists as a tag, so this release cannot be cut.\n` +
        '        The version comes from the commits that are reachable; the tag\n' +
        '        is not among them, which happens when a release commit leaves\n' +
        '        the branch and its tag stays.\n\n' +
        '        Bring the tag back into the history it belongs to:\n' +
        `          git merge --no-ff v${version}\n` +
        '        or, if that release shipped nothing and the number is free:\n' +
        `          git tag -d v${version} && git push origin :refs/tags/v${version}`,
    )
  }

  // **Config against the workflows it generated, before the tag exists.**
  // `init` derives the triggers and the dist-tag arms once; nothing until now
  // checked that a workflow still matches the config it came from. The refusal
  // is worth having in exactly one case — a channel the publish workflow cannot
  // name a dist-tag for, which dies on the catch-all *after* the tag and the
  // release commit are public. Here it costs a re-run.
  //
  // Deliberately not in the pre-push hook: see `drift.ts`.
  const drift = inspect(await readWorkflows(root), config, version, adapterId)
  for (const d of drift.filter(d => d.level === 'warn')) {
    console.error(`\ncutver: ${d.message}\n        Docs: ${d.docs}`)
  }
  for (const d of drift.filter(d => d.level === 'refuse')) {
    die(`${d.message}\n        Docs: ${d.docs}`)
  }

  // **The preflight is a question about publishing, so it is only asked when a
  // tag publishes.** Its whole job is to refuse a release for a package the
  // registry has never heard of, because a first publish cannot go through a
  // trusted publisher. Against a repository whose tags produce executables and
  // nothing else that refusal is not a safeguard — it is ten crates reported
  // missing from a registry they are never going to reach, needing
  // `--allow-first-publish` forever to say so.
  const publishing = publishesToRegistry(adapterId, config)

  if (opts.offline) {
    console.log('\npreflight: skipped (--offline)')
  } else if (!publishing) {
    console.log('\npreflight: skipped — a tag here publishes to no registry')
  } else {
    // `remoteUrl` is a git spawn with no relationship to the registry lookups,
    // so it rides alongside the HTTP rather than after it — free, since the
    // network round trip dominates.
    const [found, remote] = await Promise.all([
      checkRegistry(await adapter.publishTargets(root)),
      remoteUrl(root),
    ])
    preflight(found, remote, opts.allowFirstPublish, opts.dryRun)
  }

  // A dirty tree means the release would capture edits nobody reviewed.
  //
  // Guarded on the flag rather than on the answer: under `--dry-run` nothing is
  // written, so the result can never be used — and asking anyway spends a whole
  // git spawn on the flag people iterate with.
  if (!opts.dryRun) {
    const dirt = await status(root)
    if (dirt) die(`working tree is not clean:\n${dirt}`)
  }

  console.log(`\nfiles${opts.dryRun ? ' (dry run — nothing is written)' : ''}`)
  const changes = await adapter
    .setVersion({ root, version, dryRun: opts.dryRun })
    .catch((e: Error) => die(e instanceof AdapterError ? e.message : String(e)))

  // The caller's clock, formatted ISO-8601 like every other heading. Not
  // `toLocaleDateString` — a release note that reads differently depending on
  // who cut it is a small lie.
  const today = new Date().toISOString().slice(0, 10)

  // **Only when the config asks.** Compiled sections are opt-in because the
  // default this tool has always had — open the heading, write nothing — is a
  // position rather than an omission, and upgrading cutver must not start
  // writing into anyone's changelog on its own.
  const changelog = !config.changelog
    ? await rollChangelog({ root, version, dryRun: opts.dryRun, today })
    : !config.changelog.file
      ? // `file: false` — compiled sections exist for the release body and
        // nothing in the tree is touched. Not even the `## [Unreleased]` roll,
        // which is the other mode's job and would edit a file this config has
        // said to leave alone.
        null
      : await writeChangelog({
          root,
          dryRun: opts.dryRun,
          keep: config.changelog.keep,
          releases: await compileReleases(
            root,
            { version, date: today },
            config.changelog.sections,
            config.changelog.prereleases,
          ),
        })

  const all = changelog ? [...changes, changelog] : changes
  report(all)
  const updated = all.filter(c => c.state === 'updated').length

  // **A prerelease published without a dist-tag becomes `latest`.** That is
  // npm's default, it is silent, and the consequence is that every plain
  // install in the world starts resolving to an alpha. Undoing it means
  // re-tagging by hand *after* users have already installed it, so the flag is
  // printed here rather than left to be remembered at the point of running the
  // publish.
  // `channelOf` rather than a regex written again here. The inline one read
  // `[a-z]+`, and channel names are kebab-case — so `1.2.0-my-prefix.1` gave
  // `prefix`, and the line whose whole job is stopping a prerelease from
  // becoming `latest` advised the wrong dist-tag.
  const dist = channel ?? channelOf(version)

  // **The opening tag, and only when nothing was written.**
  //
  // A repository with no tags cannot be measured from one, so the first is the
  // only thing between a fresh project and a tool that cannot help it yet.
  // cutver creates it rather than asking someone to type `git tag v0.1.0`
  // correctly, once, before anything works.
  //
  // `updated === 0` is the condition and it is not a heuristic. This tags
  // *HEAD*, so HEAD's manifest has to already hold the version — which is
  // exactly the first-release case, where the number being cut is the one the
  // manifest already stated. When the manifest did change (a `0.0.0`
  // placeholder becoming `0.1.0`) the bump is still uncommitted, and tagging
  // HEAD would put the tag on a commit that says `0.0.0`. So that path keeps
  // the old advice and lets the caller commit first.
  //
  // A local tag publishes nothing. The push is still a separate act.
  const tag = `v${version}`
  const opened =
    decision.first && updated === 0 && !opts.dryRun
      ? await createTag(root, tag)
      : 'skip'

  if (opened !== 'skip' && opened !== null) {
    // Not fatal. The version is correct and the manifests are right; a tag is
    // one command, and dying here would strand a release over the easiest part
    // of it to do by hand.
    warn(`\ncutver: could not create ${tag} — ${opened}\n        git tag ${tag}`)
  }

  const tagged = opened === null

  console.log(
    opts.dryRun
      ? `\ncutver: dry run — ${updated} file(s) would change, none did.` +
          (decision.first && updated === 0
            ? `\n  It would also create ${tag}, this repository having no tags.`
            : '')
      : `\ncutver: ${updated} file(s) updated.` +
          (tagged
            ? `\n  ${style('%g↑%0')} tagged ${tag}\n` +
              `  next: git push --tags, and publish from the tag.`
            : '\n  next: review the diff, commit, tag ' +
              `${tag}, and publish from the tag.`) +
          (dist && adapter.registry === 'npm'
            ? `\n\n  Publish this one with \`--tag ${dist}\`. Without it npm marks\n` +
              `  ${version} as \`latest\` and every plain install resolves to a\n` +
              `  prerelease. Consumers opt in with \`@${dist}\`.`
            : ''),
  )
}
