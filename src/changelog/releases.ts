/**
 * Pushing compiled sections back onto the GitHub releases that already exist.
 *
 * **`cutver changelog` rewrites the file; the release pages keep whatever they
 * were given at the time.** A project that adopts `changelog:` after twenty
 * releases ends up with a good `CHANGELOG.md` and twenty release pages that
 * still say whatever `--generate-notes` produced, or nothing at all. This is the
 * half that catches them up.
 *
 * **Nothing anyone wrote is ever overwritten**, and that rule is the whole
 * design rather than a precaution. A release body is published prose, often the
 * only announcement a version ever got, and it cannot be recovered once
 * replaced — GitHub keeps no history of it. So a body is replaced only when it
 * is provably not authored: empty, or the version repeated back, or GitHub's own
 * generated list. Everything else is reported and left alone.
 */
import { remoteUrl } from '../git'
import { normaliseRepo } from '../registry'

/** What happened to one release, for the report. */
export interface ReleaseUpdate {
  tag: string
  state: 'updated' | 'skipped' | 'unchanged' | 'missing'
  /** Why it was skipped, or what changed. */
  detail: string
}

/**
 * Whether a body can be replaced without losing something a person wrote.
 *
 * Three shapes count as unauthored:
 *
 * - nothing at all, which is what a tag pushed by hand gets;
 * - the version or tag repeated, which is what a script that had to put
 *   *something* in the field produces;
 * - GitHub's generated notes — a `## What's Changed` list of merged pull
 *   requests, closed with a `**Full Changelog**` link. That is exactly the
 *   output `--generate-notes` writes, and it is the thing this command exists to
 *   replace.
 *
 * Anything else is treated as authored, including a body that merely *contains*
 * a generated section: someone who added a paragraph above GitHub's list wrote
 * that paragraph, and replacing the lot would take it with them.
 */
export function isUnauthored(
  body: string | null | undefined,
  tag: string,
): boolean {
  const text = (body ?? '').trim()
  if (!text) return true

  const version = tag.replace(/^v/, '')
  if (
    text === tag ||
    text === version ||
    text === `# ${tag}` ||
    text === `# ${version}`
  ) {
    return true
  }

  // GitHub's generated notes, and nothing around them.
  const generated =
    /^##\s+What's Changed/i.test(text) ||
    /^\*\*Full Changelog\*\*:/m.test(text.split('\n')[0] ?? '')
  if (!generated) return false

  // Every line has to belong to that generated block for this to be safe.
  return text
    .split('\n')
    .every(
      line =>
        /^\s*$/.test(line) ||
        /^##\s+What's Changed/i.test(line) ||
        /^\*\s|^-\s/.test(line) ||
        /^\*\*Full Changelog\*\*:/.test(line) ||
        /^##\s+New Contributors/i.test(line),
    )
}

/** `owner/repo` for the checkout, or `null` when there is no GitHub remote. */
export async function githubRepo(root: string): Promise<string | null> {
  const short = normaliseRepo(await remoteUrl(root))
  if (!short?.startsWith('github.com/')) return null
  return short.slice('github.com/'.length)
}

/**
 * The token, from the environment only.
 *
 * The same argument as the summariser's key: a token in a tracked file is a
 * token published. `GITHUB_TOKEN` is present in every Actions run without being
 * asked for, and `GH_TOKEN` is what `gh auth` exports locally.
 */
export function tokenFor(
  env: Record<string, string | undefined>,
): string | null {
  return env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || null
}

interface Release {
  id: number
  body: string | null
}

async function api(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
}

/**
 * Bring one release page in line with its compiled section.
 *
 * Never throws. Every failure — no release for the tag, a refused token, a
 * network that is not there — comes back as a row in the report, because this
 * runs over every tag in a repository and one unreachable release must not
 * abandon the other nineteen.
 */
export async function updateRelease(
  repo: string,
  token: string,
  tag: string,
  /**
   * The new body, or a function producing it.
   *
   * **A function, because producing it can cost minutes.** With a summariser
   * configured the body is a model call, and the decision to skip a release
   * needs only the *old* body — so a re-run over twenty pages that are all
   * left alone would otherwise pay twenty model calls to reach twenty skips.
   * Nothing is produced until this release is known to be eligible.
   */
  body: string | (() => Promise<string>),
  dryRun: boolean,
  /** Replace a body somebody wrote. Never set without a person asking twice. */
  force = false,
): Promise<ReleaseUpdate> {
  const found = await api(`/repos/${repo}/releases/tags/${tag}`, token).catch(
    () => null,
  )

  if (!found) return { tag, state: 'missing', detail: 'could not reach GitHub' }
  if (found.status === 404) {
    return { tag, state: 'missing', detail: 'no GitHub release for this tag' }
  }
  if (!found.ok) {
    return { tag, state: 'missing', detail: `GitHub answered ${found.status}` }
  }

  const release = (await found.json()) as Release
  const current = (release.body ?? '').trim()

  // **The free comparison first, so a second run is quiet.** A page cutver
  // already filled in reads as authored — it is prose, and nothing marks it as
  // machine-written — so without this an unchanged re-run would report every
  // page as "has a written body" and recommend `--force` for a no-op.
  //
  // Only possible when the body is already in hand. Behind a summariser it is
  // not, and could not be compared anyway: two runs of a model produce two
  // different paragraphs from the same commits.
  if (typeof body === 'string' && current === body.trim()) {
    return { tag, state: 'unchanged', detail: 'already matches the changelog' }
  }

  // Decided before the body is produced, so a skip costs nothing.
  const authored = !isUnauthored(release.body, tag)
  if (authored && !force) {
    return {
      tag,
      state: 'skipped',
      detail: 'has a written body — left alone (--force replaces it)',
    }
  }

  // Answered before the body is produced too. A dry run exists to say which
  // pages this would touch, and behind a summariser producing them costs a
  // model call each to reach the same answer — a preview nobody expects to be
  // billed for.
  if (dryRun) {
    return {
      tag,
      state: 'updated',
      detail: authored
        ? 'would replace a WRITTEN body (dry run)'
        : 'would be replaced (dry run)',
    }
  }

  const next = typeof body === 'string' ? body : await body()
  if (current === next.trim()) {
    return { tag, state: 'unchanged', detail: 'already matches the changelog' }
  }

  const patched = await api(`/repos/${repo}/releases/${release.id}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ body: next }),
  }).catch(() => null)

  if (!patched?.ok) {
    return {
      tag,
      state: 'missing',
      detail: `could not write it back${patched ? ` (${patched.status})` : ''}`,
    }
  }
  return {
    tag,
    state: 'updated',
    detail: authored
      ? 'replaced a written body'
      : current
        ? 'replaced'
        : 'was empty',
  }
}
