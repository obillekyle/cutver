/**
 * The version list a docs site can offer, written where the tags are known.
 *
 * **A file rather than a lookup, and cutver's job rather than a workflow's.**
 * A versioned docs site needs to know which versions exist. Reading them at
 * page load means GitHub's tags API and its 60 unauthenticated requests an hour
 * *per IP* — shared by every reader behind one corporate NAT — and reading them
 * from a registry ties the site to having published a package, which a Rust
 * workspace shipping binaries has not.
 *
 * The first attempt was a step in the generated `version.yml`: `git tag --list`
 * piped through `jq`. That is the wrong layer three times over. It is a third
 * copy of the tag list to keep in step, it adds a `jq` dependency to every
 * workflow cutver writes, and it would land in every repository cutver
 * scaffolds — most of which have no `docs/` at all.
 *
 * cutver already reads these tags to work out the number, and already writes
 * files at stage time. So it writes this one too.
 *
 * **The file's presence is the opt-in.** No config key: a repository that wants
 * it commits an empty `[]` once and cutver keeps it current; one that does not
 * never sees the feature. That is the same shape as `changelog.file`, minus a
 * key, and it means `init` has nothing new to scaffold and `drift` has nothing
 * new to check.
 */
import type { Change } from './adapters/types'
import { releaseTags } from './git'
import { exists, readText, semverOrder, write } from './runtime'

/** Where a docs site looks. Fixed, because a configurable path is a key. */
export const VERSIONS_FILE = 'docs/versions.json'

interface Doc {
  /** The newest tag, prerelease or not — what the badge shows. */
  latest: string | null
  /** Every released version, newest first. */
  versions: string[]
}

/**
 * `latest` is the newest tag, prerelease and all.
 *
 * Not "the newest stable". A project living on `2.0.0-alpha.9` should say so
 * rather than showing a release it left behind — which is the case npm's
 * `latest` gets wrong, since it is pinned on a package's first publish whatever
 * `--tag` said.
 */
export function buildVersions(tags: string[], cutting?: string): Doc {
  const versions = [...new Set([...(cutting ? [cutting] : []), ...tags])]
    // `semverOrder` is the same comparison the rest of this tool uses, so a
    // prerelease sorts under the release it precedes rather than above it —
    // which `git --sort=-v:refname` and `sort -V` both get wrong.
    .sort((a, b) => semverOrder(b, a))

  return { latest: versions[0] ?? null, versions }
}

/**
 * Rewrite `docs/versions.json`, if this repository keeps one.
 *
 * @returns the change, or `null` when there is no file to keep current.
 */
export async function writeVersions({
  root,
  version,
  dryRun = false,
}: {
  root: string
  version: string
  dryRun?: boolean
}): Promise<Change | null> {
  const path = `${root}/${VERSIONS_FILE}`
  if (!(await exists(path))) return null

  // The tag for the version being cut does not exist yet — it is created after
  // this, by the caller or by the workflow — so it is added here.
  const tags = (await releaseTags(root)).map(t => t.version)
  const doc = buildVersions(tags, version)
  const next = `${JSON.stringify(doc, null, 2)}\n`

  const before = await readText(path).catch(() => '')
  if (before === next) {
    return {
      file: VERSIONS_FILE,
      state: 'unchanged',
      detail: 'already current',
    }
  }

  if (!dryRun) await write(path, next)
  return {
    file: VERSIONS_FILE,
    state: 'updated',
    detail: `${doc.versions.length} version${doc.versions.length === 1 ? '' : 's'}, latest ${doc.latest}`,
  }
}
