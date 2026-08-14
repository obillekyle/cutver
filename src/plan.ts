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
import {
  applyBump,
  classify,
  highestBump,
  nextVersion,
  versionFromBranch,
  withChannel,
  type Bump,
  type Channel,
} from './version-from-commits'

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
  channel: Channel | null
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
async function baseline(
  root: string,
  current: string,
  rev: string,
): Promise<{ from: string; since: string; tagged: boolean }> {
  const tag = await lastStableTag(root, rev)
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
}: PlanInput): Promise<Plan> {
  if (explicit) {
    if (explicit === current) {
      return { kind: 'nothing', why: `${explicit} is already the current version`, survey: null }
    }
    return { kind: 'release', version: explicit, from: current, why: 'given explicitly', survey: null }
  }

  const { from, since, tagged } = await baseline(root, current, rev)

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
  const lastAny = await lastAnyTag(root, rev)
  const freshSince = lastAny ?? 'the first commit'
  const freshRange = lastAny ? `${lastAny}..${rev}` : rev

  const fresh = (await commitsIn(freshRange, root)).map(c => ({ ...c, bump: classify(c) }))
  const commits =
    baseRange === freshRange
      ? fresh
      : (await commitsIn(baseRange, root)).map(c => ({ ...c, bump: classify(c) }))

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
  const declared = versionFromBranch(branch)
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

    const declaredNext = withChannel(declared.base, declared.channel, current)
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

  // The base is measured from the last stable release, not from `current` and
  // not from the last tag. `nextVersion` documents why both of those are wrong.
  const version = nextVersion({ lastStable: from, bump, channel, current })

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
    why: `${bump}${channel ? `, ${channel}` : ''}`,
    survey: s,
  }
}
