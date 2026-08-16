/**
 * The changelog, in one of two modes that share nothing but a filename.
 *
 * **Hand-written (the default).** `## [Unreleased]` is rolled into a dated
 * heading and a fresh one opened above it. Nothing else is touched and no notes
 * are written, because every tool in this space generates release notes by
 * listing commit subjects — and for a changelog that explains *why* things are
 * the way they are, which limitation is deliberate, what a fix cost, what was
 * reversed, that is a downgrade. The version number is mechanical and worth
 * automating; the prose is the actual work.
 *
 * **Compiled (`changelog:` in the config).** cutver owns the file and rewrites
 * it whole on every release, from the tags and the commit bodies. There is no
 * `## [Unreleased]`, because there is nothing to write there.
 *
 * The two do not blend, and the reason is the interesting part. A mode that
 * *edited* the file would have to parse it — find a marker, locate where a
 * section ends, decide what to trim — and each of those is a way for a
 * changelog nobody has read in a year to break a release. Rewriting reads
 * nothing, so a malformed file costs nothing. Editing someone else's document
 * safely and rewriting your own are different jobs, and trying to do both at
 * once gets the worst of each.
 */
import { detectEol, withEol } from '../text'
import type { Change } from '../adapters/types'
import { renderChangelog, type ReleaseSection } from './notes'

const MARKER = '## [Unreleased]'

export interface RollOptions {
  root: string
  version: string
  dryRun: boolean
  /**
   * ISO date for the heading. Injected rather than read from the clock so the
   * test is not a function of the day it runs — and formatted ISO-8601, never
   * `toLocaleDateString`: a release note that reads differently depending on
   * who cut it is a small lie.
   */
  today: string
}

/**
 * Roll `## [Unreleased]` into a dated heading, and open a fresh one.
 *
 * `null` when there is no changelog at all — which is not an error. A crate
 * repository that keeps its history in git and its notes on the releases page
 * is a normal repository, and refusing to cut a version for it would be this
 * tool inventing a requirement.
 */
export async function rollChangelog({
  root,
  version,
  dryRun,
  today,
}: RollOptions): Promise<Change | null> {
  const path = `${root}/CHANGELOG.md`
  const text = await Bun.file(path)
    .text()
    .catch(() => null)

  if (text === null) return null

  // A changelog that exists but has no `## [Unreleased]` is left untouched and
  // said out loud. Silence here would be the worst option: the file is
  // evidence that someone *wants* release notes, so failing to roll it is
  // news, and dying over a heading would block a release for a formatting
  // convention the repository never agreed to.
  if (!text.includes(MARKER)) {
    return {
      file: 'CHANGELOG.md',
      state: 'unchanged',
      detail: `no \`${MARKER}\` heading — left alone`,
    }
  }

  const eol = detectEol(text)
  const rolled = text.replace(
    MARKER,
    withEol(`${MARKER}\n\n## [${version}] — ${today}`, eol),
  )
  if (!dryRun) await Bun.write(path, rolled)

  return {
    file: 'CHANGELOG.md',
    state: 'updated',
    detail: `new heading [${version}] — ${today}`,
  }
}

export interface WriteOptions {
  root: string
  dryRun: boolean
  /** Newest first. The release being cut is the first entry. */
  releases: readonly ReleaseSection[]
  /** How many to keep. `null` keeps every one. */
  keep: number | null
}

/**
 * Rewrite the whole changelog from the compiled sections.
 *
 * **The existing file is never read.** Not to find where to insert, not to
 * detect its line endings, not to check whether it parses — a file this owns
 * has nothing to learn from its previous contents, and reading it would be the
 * first step back towards the parsing this mode exists to avoid. Written LF,
 * like every other file generated here.
 */
export async function writeChangelog({
  root,
  dryRun,
  releases,
  keep,
}: WriteOptions): Promise<Change> {
  const kept =
    keep && keep > 0 ? Math.min(keep, releases.length) : releases.length

  if (!dryRun)
    await Bun.write(`${root}/CHANGELOG.md`, renderChangelog(releases, keep))

  return {
    file: 'CHANGELOG.md',
    state: 'updated',
    detail:
      `rewritten — ${kept} release${kept === 1 ? '' : 's'}` +
      (kept < releases.length ? ` of ${releases.length}` : ''),
  }
}
