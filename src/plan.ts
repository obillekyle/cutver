/**
 * Decide the number, without deciding anything about files or the terminal.
 *
 * `version-from-commits.ts` is the arithmetic; this is the policy that feeds
 * it — where the baseline comes from, when a branch name wins, and what
 * counts as "nothing to release". Kept out of `cli.ts` so it can be tested
 * without a process, which is the same reason the arithmetic was kept out of
 * the original release script.
 */
import { lastStableTag, commitsIn } from './git'
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
}

export interface Tally {
  level: Exclude<Bump, null>
  subjects: string[]
}

export interface Survey {
  /** What the range was measured from — a tag, or `the first commit`. */
  since: string
  total: number
  tally: Tally[]
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
 */
async function baseline(root: string, current: string): Promise<{ from: string; since: string }> {
  const tag = await lastStableTag(root)
  return tag
    ? { from: tag.slice(1), since: tag }
    : { from: stableCore(current), since: 'the first commit' }
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
}: PlanInput): Promise<Plan> {
  if (explicit) {
    if (explicit === current) {
      return { kind: 'nothing', why: `${explicit} is already the current version`, survey: null }
    }
    return { kind: 'release', version: explicit, from: current, why: 'given explicitly', survey: null }
  }

  const { from, since } = await baseline(root, current)
  const tag = since === 'the first commit' ? null : since
  const range = tag ? `${tag}..HEAD` : 'HEAD'

  const commits = (await commitsIn(range, root)).map(c => ({ ...c, bump: classify(c) }))
  const driving = commits.filter(c => c.bump)
  const s = survey(commits, since)

  if (!driving.length) {
    return {
      kind: 'nothing',
      why: `no feat/fix/perf or breaking commit since ${since}`,
      survey: s,
    }
  }

  const bump = highestBump(commits)
  if (!bump) throw new Error('unreachable: driving commits but no bump')

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
    if (Bun.semver.order(implied, declared.base) > 0) {
      throw new Error(
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
