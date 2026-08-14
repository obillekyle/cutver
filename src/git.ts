/**
 * The git this tool needs, and nothing else.
 *
 * Every function takes the repository root explicitly. `cutver` is run *at* a
 * repository rather than from inside its own, so an implicit `process.cwd()`
 * anywhere here is a bug waiting for the first `--cwd` invocation.
 *
 * Nothing here writes. The commit and the tag are left to the caller — see the
 * note at the end of `cli.ts` for why the tool stops where it does.
 */
import { run } from './run'
import type { Commit } from './version-from-commits'

export async function isGitRepo(root: string): Promise<boolean> {
  const { ok, out } = await run(['git', 'rev-parse', '--is-inside-work-tree'], root)
  return ok && out === 'true'
}

/**
 * The newest **stable** tag reachable from HEAD, or `null` if there is none.
 *
 * Stable specifically — `git describe --abbrev=0` would hand back
 * `v1.3.0-beta.2`, and measuring commits from there is how a breaking change
 * that lands mid-beta gets released as a minor. See `nextVersion`.
 */
export async function lastStableTag(root: string, rev = 'HEAD'): Promise<string | null> {
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
export async function lastAnyTag(root: string, rev = 'HEAD'): Promise<string | null> {
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
  found.sort((a, b) => b.when - a.when || Bun.semver.order(b.name.slice(1), a.name.slice(1)))
  return found[0]?.name ?? null
}

/** Commits in `range`, newest first. `range` is a git revision range or `HEAD`. */
export async function commitsIn(range: string, root: string): Promise<Commit[]> {
  // \x1e between records, \x1f between fields: a commit body can contain
  // anything, newlines included, so the separators have to be bytes that
  // cannot appear in one.
  const { out } = await run(['git', 'log', range, '--format=%s%x1f%b%x1e'], root)

  return out
    .split('\x1e')
    .map(r => r.trim())
    .filter(Boolean)
    .map(r => {
      const [subject = '', body = ''] = r.split('\x1f')
      return { subject, body: body.trim() }
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
  const configured = await run(['git', 'config', '--get', 'core.hooksPath'], root)
  if (configured.ok && configured.out) return configured.out.replaceAll('\\', '/')

  const { ok, out } = await run(['git', 'rev-parse', '--git-path', 'hooks'], root)
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
