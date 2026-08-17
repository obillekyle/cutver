/**
 * Commits grouped into changelog sections.
 *
 * **Off unless a repository asks for it, and that is not timidity.** The rest
 * of this tool argues that generated release notes are a downgrade from prose,
 * and `changelog.ts` still says so. That argument is about *subject lines*:
 * `fix: stuff` in a list under a heading tells a reader nothing they could not
 * get from `git log`, and its presence makes the section look written when it
 * is not.
 *
 * What changes the calculation is the **body**. A commit body that explains why
 * a limitation is deliberate, what a fix cost, what was reversed — that is
 * release-note prose already, written at the moment the author had the context.
 * Refusing to carry it into the changelog does not produce better notes; it
 * produces the same words typed twice, or more often, not at all.
 *
 * So this takes the first paragraph of the body, not the whole of it. The first
 * paragraph of a well-written body is the thesis; the rest is evidence, which
 * belongs in `git show` rather than in a file people skim. A commit with no
 * body contributes its subject alone, and reads exactly as thin as it is —
 * which is honest, and is its own argument for writing one.
 *
 * **Two renderings, and they feed different readers.** `renderNotes` is the
 * changelog: headings, bullets, linked shas, one paragraph of body each.
 * `rawCommits` is the summariser's input — the same commits with none of that
 * shape, because a model handed rendered markdown rebuilds the shape it was
 * given instead of writing from the material.
 */
import type { Commit } from '../version-from-commits'

/** `type(scope)!: subject` — the same shape `classify` parses, re-read here for the parts it discards. */
const HEADER =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?: (?<rest>.*)$/

/**
 * The sections a config may ask for, and what each is called in the file.
 *
 * `breaking` is not a commit type — it is the `!` marker or a `BREAKING
 * CHANGE:` footer, across every type. It is listed first by default because it
 * is the only section a reader must not miss.
 */
export const SECTIONS: Record<string, string> = {
  breaking: 'Breaking Changes',
  feat: 'New Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Refactor',
  docs: 'Docs',
  build: 'Build',
  ci: 'CI',
  test: 'Tests',
  style: 'Style',
  chore: 'Chores',
  revert: 'Reverts',
}

/** Default order when the config asks for notes without naming sections. */
export const DEFAULT_SECTIONS = [
  'breaking',
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
] as const

export interface Entry {
  /** `dashboard`, or null when the commit declared no scope. */
  scope: string | null
  /** The subject with `type(scope)!: ` removed. */
  title: string
  /** First paragraph of the body, or null. */
  lead: string | null
  /**
   * Abbreviated sha, or null when the caller had none.
   *
   * Null is a real case rather than a defect: `renderNotes` is pure and its
   * tests build entries by hand. A note without a sha is a note that says less,
   * not one that is wrong — so it renders without the reference rather than
   * with an empty pair of brackets.
   */
  sha: string | null
}

/** Which section a commit belongs to, or `null` for one no section claims. */
export function sectionOf(commit: Commit): string | null {
  const m = HEADER.exec(commit.subject)
  if (!m?.groups) return null

  // Breaking wins over the type, and a breaking commit appears **once**.
  // Listing a `feat!` under both New Features and Breaking Changes reads as two
  // changes to anyone skimming, which is the opposite of what the section is
  // for.
  if (m.groups.bang || /^BREAKING[ -]CHANGE:/m.test(commit.body))
    return 'breaking'
  // This project's own major marker. It declares an intent rather than
  // describing a diff, so `Breaking Changes` is where a reader expects it.
  if (m.groups.type === 'release') return 'breaking'
  return m.groups.type ?? null
}

export function entryOf(commit: Commit & { sha?: string }): Entry | null {
  const m = HEADER.exec(commit.subject)
  if (!m?.groups) return null

  // Everything up to the first blank line. `\r\n` included, because a commit
  // made on Windows carries them and a stray `\r` inside a markdown bullet
  // renders as a broken line rather than as nothing.
  const paragraphs = commit.body.split(/\r?\n\s*\r?\n/)
  const flatten = (p: string | undefined) =>
    (p ?? '')
      .split(/\r?\n/)
      .map(l => l.trim())
      .join(' ')
      .trim()

  let lead = flatten(paragraphs[0])

  // **A paragraph ending in a colon is introducing something**, and stopping
  // there leaves the entry dangling — "could not copy a binary that was sitting
  // right there:" and then nothing. Measured on this project's own history,
  // where bodies routinely lead into a code block or a list. The second
  // paragraph comes along in that one case, kept as its own block so an
  // indented snippet still renders as one.
  if (lead.endsWith(':') && paragraphs[1]) {
    const next = (paragraphs[1] ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\n+$/, '')
    lead = `${lead}\n\n${next}`
  }

  return {
    scope: m.groups.scope?.trim() || null,
    title: (m.groups.rest ?? '').trim(),
    // `null`, not `''`. A commit with no body contributes its subject alone,
    // and the renderer decides that by asking whether there is a lead at all.
    lead: lead || null,
    sha: commit.sha || null,
  }
}

/**
 * A `chore(release):` commit is the release itself and never a note about one.
 *
 * It only appears in a range at all when a previous release was cut and the
 * next one measures across it, but when it does it would otherwise sit in
 * `Chores` announcing the version the reader is already looking at.
 */
const RELEASE_COMMIT = /^chore\(release\):/

export interface DiffRange {
  /** Abbreviated sha of the last release, or of the first commit. */
  from: string
  /** Abbreviated sha of what is being released. */
  to: string
  /** `owner/repo` on a known host, for a compare link. Plain text without one. */
  repo?: string | null
}

/**
 * `a1b2c3`, linked to the commit when the host is one whose URL is known.
 *
 * Same restraint as `diffLine`: only github is linked. Everything else gets the
 * bare sha, which still resolves under `git show` and never pretends to be a
 * URL somebody can click.
 */
export function commitRef(sha: string, repo?: string | null): string {
  return repo?.startsWith('github.com/')
    ? `[${sha}](https://${repo}/commit/${sha})`
    : sha
}

/**
 * `diff: a1b2c3...d4e5f6`, linked when the remote is one with a compare view.
 *
 * Short shas rather than tag names, because the range is written *before* the
 * tag exists — the release commit has not been made yet, let alone tagged, so
 * `v1.1.1...v1.2.0` would name a ref that resolves for nobody until later.
 * Shas resolve the moment they are printed and never stop.
 *
 * Degrades to plain text rather than to nothing: a repository with no remote,
 * or one on a host whose compare URL is unknown, still gets a range someone can
 * paste into `git diff`.
 */
export function diffLine({ from, to, repo }: DiffRange): string {
  const range = `${from}...${to}`
  // Only github is linked, and deliberately: gitlab uses `/-/compare`, gitea
  // and forgejo differ again, and a link built from the wrong template is worse
  // than the text — it looks checkable and is not.
  const link = repo?.startsWith('github.com/')
    ? `https://${repo}/compare/${range}`
    : null
  const text = link ? `diff: [${range}](${link})` : `diff: ${range}`

  // **`<sub>` because this is a footnote at the top of the page.** It is a
  // provenance line — where these notes came from — and set at body size it
  // competes with the sentence that says what the release is for. GitHub
  // renders `<sub>` in both release bodies and markdown files, and a reader
  // with no renderer still sees the range and the URL either side of a tag.
  return `<sub>${text}</sub>`
}

/**
 * One release's section, pulled back out of a changelog.
 *
 * **In here rather than as `awk` in the generated workflow**, and the reason is
 * upgrades rather than tidiness. Anything baked into `publish.yml` is frozen at
 * `init` time for every repository that already ran it: improving it later
 * means asking every user to regenerate a file they have since hand-edited,
 * which nobody does. Logic belongs in the tool, where `bunx cutver` picks it up
 * on the next release; the generated file should carry the invocation and
 * nothing else.
 *
 * A leading `v` is accepted because the caller usually has a tag rather than a
 * version, and passing `$TAG` straight through is the obvious thing to write.
 */
export function sectionFor(changelog: string, version: string): string {
  const want = `## [${version.replace(/^v/, '')}]`
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex(line => line.startsWith(want))
  if (start === -1) return ''

  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    // The next release ends this one. `### ` subsections belong to it.
    if (line.startsWith('## ')) break
    body.push(line)
  }

  return body.join('\n').trim()
}

export interface ReleaseSection {
  /** `1.2.0` — no leading `v`, matching the heading format. */
  version: string
  /** ISO-8601, as every heading in this file already uses. */
  date: string
  /** Rendered body: the diff line and the sections. */
  notes: string
}

/** The generated file's preamble. Says what wrote it, because something did. */
const PREAMBLE = `# Changelog

Generated by [cutver](https://cutver.okyle.dev) from the commit messages. Each
entry is a commit subject and the first paragraph of its body, so the changelog
is only ever as good as the commits — which is the point.

**This file is rewritten on every release.** Edits to it do not survive; put the
explanation in the commit body, where it is also visible in \`git log\`, in a
pull request, and on the release page.`

/**
 * The whole file, every time.
 *
 * **cutver owns this file rather than editing it**, and that is the entire
 * reason the mode is safe. Splicing into a document someone else also writes
 * means parsing it — finding a marker, locating a section end, deciding what to
 * trim — and every one of those steps is a way for a changelog nobody has
 * looked at in a year to break a release. Regenerating reads nothing, so a
 * malformed, truncated or hand-mangled file costs nothing: it is replaced.
 *
 * The trade is real and worth stating plainly. A regenerated changelog can only
 * ever describe what is *still* in the history, so a squash or a rebase changes
 * what an old release says. Git tags and the GitHub release pages are the
 * durable record; this file is a view of them.
 */
export function renderChangelog(
  releases: readonly ReleaseSection[],
  keep: number | null,
): string {
  const kept = keep && keep > 0 ? releases.slice(0, keep) : releases
  const parts = [PREAMBLE]

  for (const release of kept) {
    parts.push(`## [${release.version}] — ${release.date}\n\n${release.notes}`)
  }

  // A pointer rather than a silent truncation. The sections that fell off are
  // still in the tags and on the releases page, and a changelog that simply
  // ends is indistinguishable from one that lost its history to a bad merge.
  if (kept.length < releases.length) {
    parts.push(`Older releases are in the git tags and on the releases page.`)
  }

  return `${parts.join('\n\n')}\n`
}

/**
 * The commits themselves, in order, with no markdown around them.
 *
 * **The summariser's input, where `renderNotes` is the changelog's.**
 * Everything `renderNotes` does — grouping into sections, writing bullets,
 * linking shas, indenting bodies — is shaping the model then has to see through
 * and redo. It was reading formatted markdown and being asked to produce
 * formatted markdown, with the first shape leaking into the second: `### New
 * Features` in, one bullet per input bullet out.
 *
 * This gives it the material and nothing else. Which commits appear is still
 * decided here rather than by the model — the section filter and the
 * `chore(release):` skip are mechanical and stay that way — but their *shape*
 * is the model's to choose. The conventional-commit type is left on the subject
 * line, because that is what tells it a `fix:` belongs under Fixes.
 *
 * Order is `git log`'s: newest first, which is what the superseded rule means
 * by reverse-chronological.
 */
export function rawCommits({ commits, sections }: NotesOptions): string {
  const kept = new Map<string, string[]>()

  for (const commit of commits) {
    if (RELEASE_COMMIT.test(commit.subject)) continue
    const key = sectionOf(commit)
    if (!key || !sections.includes(key)) continue

    // Sha first on its own line so it cannot be mistaken for part of the
    // subject, and bare rather than linked — a link is the renderer's job and
    // the model only needs the identifier to hand back.
    //
    // **`section:` is stated rather than left to be derived**, and that line is
    // the whole point. Asked to read the type off the subject, one model put
    // the same `fix(changelog):` commit under New Features four runs running —
    // and asked why, quoted the mapping rule back verbatim, named `### Fixes`
    // as the right answer, and called its own output "an error in execution
    // rather than a deliberate weighing of the rule". A rule a model can recite
    // and still not apply is not a rule worth rewording. `sectionOf` has never
    // been wrong here, because a type prefix is a fact rather than a judgement.
    const sha = 'sha' in commit && commit.sha ? `${commit.sha}\n` : ''
    const body = commit.body.replace(/\r\n/g, '\n').trim()
    const entry = `${sha}section: ${SECTIONS[key] ?? key}\n${commit.subject}${body ? `\n\n${body}` : ''}`

    const list = kept.get(key)
    if (list) list.push(entry)
    else kept.set(key, [entry])
  }

  // Grouped in config order as well as labelled, so the commits arrive in the
  // order their headings belong in. Belt and braces: the label says where each
  // one goes, and the ordering means emitting them in the order they were read
  // already produces that order.
  const ordered: string[] = []
  for (const key of sections) ordered.push(...(kept.get(key) ?? []))

  // No diff line here. It is a fact to be copied verbatim, not something to
  // summarise, so it travels in `<metadata>` — see `payload`. Mixing the two
  // is what made the first version emit a `---` with nothing above it.
  return ordered.join('\n\n---\n\n')
}

export interface NotesOptions {
  commits: readonly (Commit & { sha?: string })[]
  /** Section keys, in the order they should appear. */
  sections: readonly string[]
  /** Prepended as a `diff:` line when the shas are known. */
  range?: DiffRange | null
}

/**
 * The markdown block, or `''` when nothing in the range belongs in it.
 *
 * Empty is a real answer and the caller writes nothing at all: a release whose
 * commits are all `chore` should not gain a heading with nothing under it.
 */
export function renderNotes({
  commits,
  sections,
  range,
}: NotesOptions): string {
  const grouped = new Map<string, Entry[]>()

  for (const commit of commits) {
    if (RELEASE_COMMIT.test(commit.subject)) continue
    const key = sectionOf(commit)
    if (!key || !sections.includes(key)) continue
    const entry = entryOf(commit)
    if (!entry) continue
    const list = grouped.get(key)
    if (list) list.push(entry)
    else grouped.set(key, [entry])
  }

  // Nothing to say, and therefore nothing written — not even the diff line. A
  // heading followed only by a range is a section that looks written and is
  // not.
  if (!grouped.size) return ''

  const out: string[] = []
  if (range) out.push(diffLine(range), '')

  // Config order, not commit order: the sections are a reading order chosen
  // once, and `breaking` first is the whole reason that choice exists.
  for (const key of sections) {
    const entries = grouped.get(key)
    if (!entries?.length) continue

    out.push(`### ${SECTIONS[key] ?? key}`, '')
    for (const entry of entries) {
      const head = entry.scope
        ? `**${entry.scope}:** ${entry.title}`
        : entry.title
      // The sha trails the subject rather than leading it: the change is what a
      // reader is scanning for, and the reference is what they reach for once
      // one entry has already caught their eye. Linked where the remote has a
      // commit view, and bare text otherwise — same rule as the diff line, for
      // the same reason: a link built from the wrong template looks checkable
      // and is not.
      const ref = entry.sha ? ` (${commitRef(entry.sha, range?.repo)})` : ''
      out.push(`- ${head}${ref}`)

      // Indented to four spaces so it stays inside the bullet in every markdown
      // renderer, GitHub's included. Blank lines are left bare rather than
      // indented — trailing whitespace is what a linter strips and a diff
      // argues about.
      if (entry.lead) {
        const indented = entry.lead
          .split('\n')
          .map(line => (line.trim() ? `    ${line}` : ''))
          .join('\n')
        out.push('', indented, '')
      }
    }
    // A section whose last entry had no body needs the blank line the body
    // would have contributed.
    if (out[out.length - 1] !== '') out.push('')
  }

  return out.join('\n').trimEnd()
}
