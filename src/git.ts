/**
 * The git this tool needs, and nothing else.
 *
 * Every function takes the repository root explicitly. `cutver` is run *at* a
 * repository rather than from inside its own, so an implicit `process.cwd()`
 * anywhere here is a bug waiting for the first `--cwd` invocation.
 *
 * Nothing here writes. The commit and the tag are left to the caller — see the
 * note at the end of `cli/index.ts` for why the tool stops where it does.
 */
import { run } from './run'
import type { Commit } from './version-from-commits'
import { semverOrder } from './runtime'

export async function isGitRepo(root: string): Promise<boolean> {
  const { ok, out } = await run(
    ['git', 'rev-parse', '--is-inside-work-tree'],
    root,
  )
  return ok && out === 'true'
}

/**
 * The newest **stable** tag reachable from HEAD, or `null` if there is none.
 *
 * Stable specifically — `git describe --abbrev=0` would hand back
 * `v1.3.0-beta.2`, and measuring commits from there is how a breaking change
 * that lands mid-beta gets released as a minor. See `nextVersion`.
 */
export async function lastStableTag(
  root: string,
  rev = 'HEAD',
): Promise<string | null> {
  const { out } = await run(
    ['git', 'tag', '--list', 'v*', '--merged', rev, '--sort=-v:refname'],
    root,
  )
  return out.split('\n').find(t => /^v\d+\.\d+\.\d+$/.test(t.trim())) ?? null
}

/**
 * The newest tag of **any** kind reachable from HEAD — prereleases included.
 *
 * The counterpart to `lastStableTag`, and the two answer different questions.
 * This one answers "what was released last", which is what decides whether
 * there is anything new to release at all. The stable one answers "what is the
 * base", which must ignore prereleases or a break landing mid-beta ships as a
 * minor.
 *
 * Sorted here rather than by `git tag --sort=-v:refname`. Git's version sort
 * places a prerelease *after* its own release unless `versionsort.suffix` is
 * configured — so `v1.0.0-beta.1` would read as newer than `v1.0.0`, and a
 * release tool would be depending on a git config nobody set.
 */
export async function lastAnyTag(
  root: string,
  rev = 'HEAD',
): Promise<string | null> {
  // **Ordered by when the tag was made, with semver only as a tiebreak.**
  //
  // Sorting by semver precedence alone is correct only while the channels are
  // alpha/beta/rc, because that order happens to be both chronological and
  // alphabetical. A repository that configures `canary` breaks the coincidence:
  // release `1.3.0-rc.0` and then `1.3.0-canary.6`, and precedence calls the
  // *rc* the newest, widening the freshness range and re-cutting work that
  // already shipped.
  //
  // `creatordate` has one-second granularity, so tags made in the same second
  // tie — which is exactly when semver is the right answer, and why it stays as
  // the secondary key rather than being replaced.
  const { out } = await run(
    [
      'git',
      'tag',
      '--list',
      'v*',
      '--merged',
      rev,
      '--format=%(refname:strip=2) %(creatordate:unix)',
    ],
    root,
  )

  const found = out
    .split('\n')
    .map(line => {
      const [name = '', when = '0'] = line.trim().split(' ')
      return { name, when: Number(when) || 0 }
    })
    .filter(t => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(t.name))

  if (!found.length) return null
  found.sort(
    (a, b) => b.when - a.when || semverOrder(b.name.slice(1), a.name.slice(1)),
  )
  return found[0]?.name ?? null
}

/**
 * A commit with the sha it came from.
 *
 * **Declared here rather than added to `Commit`.** That interface lives in
 * `version-from-commits.ts`, which is a verbatim port and stays byte-identical;
 * extending it is how the notes get a sha without reaching into it. Everything
 * that decides a *version* reads `Commit` and is untouched by this — the sha is
 * only ever a thing to link to.
 */
export interface ShaCommit extends Commit {
  /** Abbreviated, as `%h` gives it — long enough to resolve, short enough to read. */
  sha: string
}

/** Commits in `range`, newest first. `range` is a git revision range or `HEAD`. */
export async function commitsIn(
  range: string,
  root: string,
): Promise<ShaCommit[]> {
  // \x1e between records, \x1f between fields: a commit body can contain
  // anything, newlines included, so the separators have to be bytes that
  // cannot appear in one.
  //
  // `%h` last of the three would be ambiguous — a body ends wherever the record
  // separator says it does, so the sha goes first where its field is fixed.
  const { out } = await run(
    ['git', 'log', range, '--format=%h%x1f%s%x1f%b%x1e'],
    root,
  )

  return out
    .split('\x1e')
    .map(r => r.trim())
    .filter(Boolean)
    .map(r => {
      const [sha = '', subject = '', body = ''] = r.split('\x1f')
      return { sha: sha.trim(), subject, body: body.trim() }
    })
}

/**
 * The current branch name, or `'HEAD'` on a detached checkout.
 *
 * CI often checks out a detached HEAD, where this answers the literal string
 * `HEAD` and the real branch exists only in the event payload — which is why
 * `--branch=` exists rather than relying on detection alone.
 */
export async function currentBranch(root: string): Promise<string> {
  const { out } = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], root)
  return out
}

/**
 * Where this repository keeps its hooks.
 *
 * `core.hooksPath` first, because a repository that sets it has moved its hooks
 * somewhere tracked on purpose and writing into `.git/hooks` would install a
 * hook git never runs — the worst possible outcome for a guard.
 *
 * Otherwise `git rev-parse --git-path hooks`, not a hand-built `.git/hooks`:
 * in a worktree `.git` is a *file* pointing elsewhere, and the literal path
 * does not exist.
 */
export async function hooksDir(root: string): Promise<string | null> {
  const configured = await run(
    ['git', 'config', '--get', 'core.hooksPath'],
    root,
  )
  if (configured.ok && configured.out)
    return configured.out.replaceAll('\\', '/')

  const { ok, out } = await run(
    ['git', 'rev-parse', '--git-path', 'hooks'],
    root,
  )
  return ok && out ? out.replaceAll('\\', '/') : null
}

/** Porcelain status — empty means clean. */
export async function status(root: string): Promise<string> {
  const { out } = await run(['git', 'status', '--porcelain'], root)
  return out
}

/**
 * The `origin` remote's URL, or `null` when there is none.
 *
 * Used to check that a manifest names the repository it is being built from —
 * npm refuses a provenance publish when those disagree. A checkout with no
 * remote is normal (a fresh `git init`, a mirror) and reports nothing rather
 * than complaining.
 */
export async function remoteUrl(root: string): Promise<string | null> {
  const { ok, out } = await run(['git', 'remote', 'get-url', 'origin'], root)
  return ok && out ? out : null
}

/**
 * A commit's abbreviated sha, or `null` when the rev does not resolve.
 *
 * `--short` rather than a fixed slice: git picks a length that is unambiguous
 * in *this* repository, which is the only length that is actually a reference.
 */
export async function shortSha(
  rev: string,
  root: string,
): Promise<string | null> {
  const { ok, out } = await run(['git', 'rev-parse', '--short', rev], root)
  return ok && out ? out : null
}

/**
 * The first commit reachable from `rev`, for a range that has no earlier tag.
 *
 * `--max-parents=0` rather than the last line of a full log: a repository with
 * grafted or merged histories has more than one root, and the oldest of them is
 * where "since the first commit" actually starts.
 */
export async function rootCommit(root: string, rev = 'HEAD'): Promise<string> {
  const { ok, out } = await run(
    ['git', 'rev-list', '--max-parents=0', rev],
    root,
  )
  const first = ok ? out.split('\n').filter(Boolean).pop() : null
  return first?.trim() || rev
}

export interface ReleaseTag {
  /** `v1.2.0`, as written. */
  tag: string
  /** `1.2.0` — what a changelog heading uses. */
  version: string
  /** ISO-8601 date the tag was created. */
  date: string
}

/**
 * Every `v*` tag, newest first, with the date it was made.
 *
 * **Ordered by creation, not by version.** Semver order among prereleases is
 * alphabetical, which is right only by accident — the same trap `lastAnyTag`
 * documents. A changelog reads in the order releases happened, and that is what
 * `creatordate` reports.
 *
 * `%(creatordate:short)` is the tag's own date for an annotated tag and the
 * commit's for a lightweight one, which is the right answer in both cases.
 */
export async function releaseTags(root: string): Promise<ReleaseTag[]> {
  const { ok, out } = await run(
    [
      'git',
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(refname:short)%09%(creatordate:short)',
      'refs/tags/v*',
    ],
    root,
  )
  if (!ok || !out) return []

  return out
    .split('\n')
    .map(line => line.split('\t'))
    .filter(([tag]) => tag && /^v\d+\.\d+\.\d+/.test(tag))
    .map(([tag, date]) => ({
      tag: tag as string,
      version: (tag as string).slice(1),
      date: (date ?? '').trim(),
    }))
}
