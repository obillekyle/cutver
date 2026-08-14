/**
 * Roll `## [Unreleased]` into a dated heading, and open a fresh one.
 *
 * Ecosystem-agnostic, so it lives here rather than in an adapter: a
 * `CHANGELOG.md` with a Keep a Changelog `## [Unreleased]` section is the same
 * file whether the repository ships crates or packages.
 *
 * **What it deliberately does not do is write the notes.** Every tool in this
 * space generates release notes by listing commit subjects, and for a changelog
 * that explains *why* things are the way they are — which limitation is
 * deliberate, what a fix cost, what was reversed — that would be a downgrade.
 * No generator produces that from a subject line. The version number is
 * mechanical and worth automating; the prose is the actual work, and this only
 * opens the heading for it.
 */
import { detectEol, withEol } from './text'
import type { Change } from './adapters/types'

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
  const rolled = text.replace(MARKER, withEol(`${MARKER}\n\n## [${version}] — ${today}`, eol))
  if (!dryRun) await Bun.write(path, rolled)

  return {
    file: 'CHANGELOG.md',
    state: 'updated',
    detail: `new heading [${version}] — ${today}`,
  }
}
