/**
 * Decide the number, without deciding anything about files or the terminal.
 *
 * `version-from-commits.ts` is the arithmetic; this is the policy that feeds
 * it — where the baseline comes from, when a branch name wins, and what
 * counts as "nothing to release". Kept out of `cli.ts` so it can be tested
 * without a process, which is the same reason the arithmetic was kept out of
 * the original release script.
 */
import { commitsIn, lastAnyTag, lastStableTag } from './git'
import { matchBranch } from './config/match'
import { DEFAULT_CONFIG, type Config } from './config/schema'
import { applyBump, classify, highestBump, type Bump } from './version-from-commits'

/**
 * The prerelease counter, for channel names the ported one cannot read.
 *
 * `withChannel` parses the current version with `PRERELEASE`, whose identifier
 * is `[a-z]+`. A kebab-case channel like `my-prefix` never matches it, so the
 * counter restarts at `.0` on every run — and since the next version then
 * equals the current one, the idempotency guard fires and the channel reports
 * "nothing to release" forever. Measured before this existed.
 *
 * So the regex is widened here and **the rule is not touched**: continue only
 * when the base *and* the channel both match, restart at `.0` otherwise. The
 * emitted shape is the same too — `base-channel.n`, the counter keeping its own
 * dot, which is what makes `.9` sort below `.10`.
 *
 * `version-from-commits.ts` stays byte-untouched, and `withChannel` stays its
 * oracle: `equivalence.test.ts` drives both over a grid of bases, channels and
 * currents and requires identical output wherever the channel is one the
 * ported regex can read. A copy that agrees with the original everywhere the
 * original applies is a safer widening than a cast that silently does not.
 */
const STAGE = /^(?<base>\d+\.\d+\.\d+)-(?<tag>[a-z]+(?:-[a-z]+)*)\.(?<n>\d+)$/

export function withStage(base: string, channel: string, current: string): string {
  const m = STAGE.exec(current)
  const continuing = m?.groups?.base === base && m.groups.tag === channel
  const n = continuing ? Number(m?.groups?.n) + 1 : 0

  return `${base}-${channel}.${n}`
}

/**
 * The one refusal a caller may want to catch by type rather than by message.
 *
 * `plan` throws this when a release branch declares a lower base than its
 * commits imply. Everything else that goes wrong here is a bug or a broken
 * checkout — and the difference matters to `cutver check`, which blocks a push
 * on this and deliberately lets one through on anything else. A guard that
 * fails closed on its own crash is worse than no guard.
 */
export class PlanRefusal extends Error {}

/** A release number is interpolated into manifests and a git tag, so it is validated. */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export interface PlanInput {
  root: string
  /** The version the manifests are at right now. */
  current: string
  branch: string
  /** A channel asked for on the command line. A config channel name, not just alpha/beta/rc. */
  channel: string | null
  /** The repository's rules. Defaults to today's hard-coded behaviour. */
  config?: Config | undefined
  /** A version typed on the command line. Wins over everything computed. */
  explicit?: string | undefined
  /**
   * The commit to reason about. Defaults to HEAD, and is a real option only
   * for the pre-push hook, which must judge the ref being pushed rather than
   * whatever happens to be checked out.
   */
  rev?: string | undefined
}

export interface Tally {
  level: Exclude<Bump, null>
  subjects: string[]
}

export interface Survey {
  /** What the "is there anything new" range was measured from — a tag, or `the first commit`. */
  since: string
  total: number
  tally: Tally[]
  /**
   * Set only when the *base* came from an earlier range than the one above —
   * that is, when the last release was a prerelease. Without it the output
   * shows one patch commit and then announces a major, with nothing on screen
   * explaining where the major came from.
   */
  base?: { since: string; bump: Exclude<Bump, null>; total: number }
}

export type Plan =
  | { kind: 'release'; version: string; from: string; why: string; survey: Survey | null }
  | { kind: 'nothing'; why: string; survey: Survey | null }
  /**
   * The branch matches no rule in the config, so nothing here may release.
   *
   * **A `Plan` variant and never a `PlanRefusal`, and the distinction is
   * load-bearing.** `cutver check` exits 1 on a refusal, and `check` is what
   * the pre-push hook runs on every branch of every push — so as a refusal this
   * would block every feature-branch push in the repository, forever. As a
   * variant it lands correctly everywhere: a bare `cutver` dies, `--if-needed`
   * exits 0, and the hook lets the push through.
   */
  | { kind: 'no-rule'; why: string; survey: null }

/** The stable part of a version — `1.3.0-beta.2` -> `1.3.0`. */
function stableCore(version: string): string {
  return version.split(/[-+]/)[0] ?? version
}

/**
 * The baseline every computed version is measured from.
 *
 * The last stable *tag* when there is one. **When there is none, the manifest —
 * not `0.0.0`.** The original script used `0.0.0` and was never wrong, because
 * that repository has had tags since its first release. Pointed at a repository
 * with zero tags and a manifest at `0.1.0`, `0.0.0` is actively harmful in both
 * directions: a minor computes `0.1.0`, the version it is already at, so the
 * tool reports "nothing to release" across the entire history — and a patch
 * computes `0.0.1`, which is a *downgrade* that the semver check would happily
 * accept.
 *
 * With no tags, the manifest is the only record of what has been released, so
 * it is the honest baseline.
 *
 * Known imprecision, worth writing down rather than discovering: if the
 * manifest is itself a prerelease and there are no tags at all, `1.3.0-beta.2`
 * reads as "1.3.0 is out", and a minor then computes 1.4.0 — skipping the
 * 1.3.0 the betas were for. Pass the version explicitly in that one case. It
 * cannot recur after the first tag exists.
 *
 * `tagged` is that caveat made available to callers rather than left in a
 * comment: a baseline with no tag behind it is an inference, and the one place
 * that difference decides an outcome refuses a release. See `plan`.
 */
function baseline(
  tag: string | null,
  current: string,
): { from: string; since: string; tagged: boolean } {
  return tag
    ? { from: tag.slice(1), since: tag, tagged: true }
    : { from: stableCore(current), since: 'the first commit', tagged: false }
}

function survey(commits: { subject: string; bump: Bump }[], since: string): Survey {
  const tally: Tally[] = []
  for (const level of ['major', 'minor', 'patch'] as const) {
    const at = commits.filter(c => c.bump === level)
    if (at.length) tally.push({ level, subjects: at.map(c => c.subject) })
  }
  return { since, total: commits.length, tally }
}

export async function plan({
  root,
  current,
  branch,
  channel,
  explicit,
  rev = 'HEAD',
  config = DEFAULT_CONFIG,
}: PlanInput): Promise<Plan> {
  if (explicit) {
    if (explicit === current) {
      return { kind: 'nothing', why: `${explicit} is already the current version`, survey: null }
    }
    return { kind: 'release', version: explicit, from: current, why: 'given explicitly', survey: null }
  }

  // Which rule claims this branch, before any git archaeology: a branch that
  // may not release is not worth measuring commits for, and the message is
  // more useful than "nothing to release" would be.
  const match = matchBranch(branch, config)
  if (match.kind === 'none') {
    return {
      kind: 'no-rule',
      why:
        `branch '${branch}' matches no channel and no release rule` +
        (config.source ? ` in ${config.source}` : ''),
      survey: null,
    }
  }

  // The two tag lookups ask git for the same list with different formatting,
  // and neither needs the other's answer. Run together they cost about 40% less
  // than back to back — a `git` spawn is ~66 ms on this box and everything else
  // here is microseconds, so spawns are the only thing worth optimising.
  const [stableTag, lastAny] = await Promise.all([
    lastStableTag(root, rev),
    lastAnyTag(root, rev),
  ])
  const { from, since, tagged } = baseline(stableTag, current)

  // **Two ranges, because there are two questions and they have different
  // right answers.**
  //
  // *Is there anything to release?* — measured from the last release of any
  // kind, prereleases included. Without this, a repository on a long-lived
  // `1.2.0-beta` branch cuts a new beta on every push forever: the range since
  // the last *stable* tag still holds all the `feat:` commits the branch was
  // opened for, so a docs-only push looks exactly like new work and spends a
  // beta number on nothing.
  //
  // *What is the base?* — measured from the last **stable** tag, always. This
  // is the half that must not be simplified away: a `feat!` landing mid-beta
  // has to be measured against the last stable release or it ships as a minor.
  // Narrowing this range to the last prerelease is precisely that bug.
  const baseRange = tagged ? `${since}..${rev}` : rev
  const freshSince = lastAny ?? 'the first commit'
  const freshRange = lastAny ? `${lastAny}..${rev}` : rev

  // Both ranges are fixed once the tags are known, and neither log depends on
  // the other — so they are asked for together. Two `git log` spawns run about
  // 28% faster concurrently on this box, which is the whole reason to bother:
  // process creation dominates, and cutver's runtime is almost entirely spawns.
  const classify_ = (cs: { subject: string; body: string }[]) =>
    cs.map(c => ({ ...c, bump: classify(c) }))

  const [freshRaw, baseRaw] = await Promise.all([
    commitsIn(freshRange, root),
    baseRange === freshRange ? null : commitsIn(baseRange, root),
  ])

  const fresh = classify_(freshRaw)
  const commits = baseRaw ? classify_(baseRaw) : fresh

  const s = survey(fresh, freshSince)

  if (!fresh.some(c => c.bump)) {
    return {
      kind: 'nothing',
      why: `no feat/fix/perf or breaking commit since ${freshSince}`,
      survey: s,
    }
  }

  // `commits` is a superset of `fresh` under any sane tagging, so the fallback
  // is unreachable — but a hand-made tag on an unrelated branch could make it
  // otherwise, and guessing `patch` there would be worse than using what the
  // new commits actually justify.
  const bump = highestBump(commits) ?? highestBump(fresh)
  if (!bump) throw new Error('unreachable: driving commits but no bump')

  if (baseRange !== freshRange) {
    s.base = { since, bump, total: commits.length }
  }

  // A branch named `1.2.0-beta` declares its own base and channel. Where that
  // happens the commits still get a vote — not on the number, but on whether
  // the number is *allowed*.
  const declared =
    match.kind === 'channel' && match.declared
      ? { base: match.declared, channel: match.channel }
      : null
  if (declared) {
    const implied = applyBump(from, bump)

    // **Refuse rather than warn.** If the commits imply a higher base than the
    // branch declares — a `release:` landed on a `1.2.0-beta` branch — then
    // publishing 1.2.0 would ship a breaking change as a minor. A warning here
    // would scroll past in a CI log and the wrong version would go out anyway.
    //
    // **Only when a stable tag exists**, and this cost a red CI run to learn.
    // With no tag the baseline is inferred from the manifest, and on a release
    // branch the manifest is a *prerelease of the base the branch declares* —
    // so `0.1.0-beta.0` yields a baseline of `0.1.0`, and the very commits
    // that justify 0.1.0 get counted again on top of it. cutver refused its
    // own first branch build that way: "declares 0.1.0, commits imply 0.2.0",
    // with a suggestion to rename the branch to `0.2.0-beta` — advice that
    // would have skipped 0.1.0 entirely.
    //
    // The guard exists to protect people who have already installed a stable
    // release. Where none has ever been published there is nobody to protect,
    // the comparison is against a number nothing ever shipped, and the branch
    // name is the only real evidence in the room.
    if (tagged && Bun.semver.order(implied, declared.base) > 0) {
      throw new PlanRefusal(
        `branch '${branch}' declares ${declared.base}, but the commits since ` +
          `${since} imply ${implied} (${bump}).\n` +
          `        Rename the branch to ${implied}-${declared.channel}, or pass ` +
          'the version explicitly if the branch is right.',
      )
    }

    const declaredNext = withStage(declared.base, declared.channel, current)
    if (declaredNext === current) {
      return { kind: 'nothing', why: `${current} is already the current version`, survey: s }
    }
    return {
      kind: 'release',
      version: declaredNext,
      from: current,
      why: `declared by branch '${branch}'`,
      survey: s,
    }
  }

  // A branch named `beta` supplies the channel and nothing else, so the base
  // is computed exactly as a stable release would be. An explicit `--beta` or
  // `--rc` still wins: the flag was typed just now and the branch was named
  // once, months ago.
  const fromBranch = match.kind === 'channel' ? match.channel : null
  const effective = channel ?? fromBranch

  // The base is measured from the last stable release, not from `current` and
  // not from the last tag. `nextVersion`'s comment documents why both of those
  // are wrong; its two lines are inlined here only so the channel can be a
  // configured name rather than the ported `Channel` union.
  const base = applyBump(from, bump)
  const version = effective ? withStage(base, effective, current) : base

  // A computed version equal to the current one means there is nothing to
  // release — that number is already spent, and npm will never accept it twice.
  //
  // This is not hypothetical. A tagging workflow that pushes the branch and the
  // tag in one command still triggers per ref, so the run can start before the
  // tag is visible. The tag lookup then finds nothing, measures across the
  // whole history, and lands back on the version already in the manifests.
  // Guarding on the version rather than on a clean tree also makes the check
  // immune to unrelated dirt, which is what CI was really tripping over.
  if (version === current) {
    return {
      kind: 'nothing',
      why: `${version} is already the current version`,
      survey: s,
    }
  }

  return {
    kind: 'release',
    version,
    from: current,
    why:
      `${bump}${effective ? `, ${effective}` : ''}` +
      // Say where the channel came from when it was not asked for on the
      // command line. A `-beta.0` appearing because of a branch name is
      // otherwise the sort of thing you notice after publishing it.
      (!channel && fromBranch ? ` from branch '${branch}'` : ''),
    survey: s,
  }
}
