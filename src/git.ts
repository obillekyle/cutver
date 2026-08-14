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
export async function lastStableTag(root: string): Promise<string | null> {
  const { out } = await run(
    ['git', 'tag', '--list', 'v*', '--merged', 'HEAD', '--sort=-v:refname'],
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
export async function lastAnyTag(root: string): Promise<string | null> {
  const { out } = await run(['git', 'tag', '--list', 'v*', '--merged', 'HEAD'], root)
  const found = out
    .split('\n')
    .map(t => t.trim())
    .filter(t => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(t))

  if (!found.length) return null
  return found.sort((a, b) => Bun.semver.order(b.slice(1), a.slice(1)))[0] ?? null
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
