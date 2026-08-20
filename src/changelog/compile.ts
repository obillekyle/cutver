/**
 * Turning ranges of git history into release sections.
 *
 * **Everything here answers the same question from a different direction:**
 * given a tag, a pair of tags, or a whole repository, what are the commits and
 * what do they render to. It sat in the CLI for as long as `cutver notes` was
 * the only caller, which put a `git log` walk and a tag-span calculation inside
 * the argument-parsing layer. Nothing here reads argv or exits a process — the
 * commands decide what to do with a section, including printing nothing.
 *
 * The advisory lines on stderr are deliberate and they are not errors. Every
 * function that can come back with less than it was asked for says why it did
 * on the way past, because the alternative is a release body that is quietly
 * empty and a person who finds out on the release page.
 */
import type { Config } from '../config/schema'
import {
  commitsIn,
  isAncestor,
  releaseTags,
  remoteUrl,
  rootCommit,
  shortSha,
  type ReleaseTag,
} from '../git'
import { normaliseRepo } from '../registry'
import {
  DEFAULT_SECTIONS,
  diffLine,
  rawCommits,
  renderNotes,
  sectionFor,
  type ReleaseSection,
} from './notes'
import { readText } from '../runtime'
import { warn } from '../style'

/**
 * A version carrying a prerelease component: `1.0.0-alpha.0`, not `1.0.0`.
 *
 * One definition because two callers depend on it agreeing with itself —
 * `compileReleases` uses it to decide which tags get a heading, and `channelOf`
 * to decide which of them are the same kind of release.
 */
const isPrerelease = (version: string) => version.includes('-')

/**
 * Which channel a version was cut in, read from the version itself.
 *
 * `1.0.0-alpha.0` is `alpha`, `1.2.0-rc.2` is `rc`, and anything without a
 * prerelease component is `release`. Read from the version rather than from the
 * config, because a tag outlives the branch that cut it: a channel renamed or
 * removed a year ago still has releases in the history, and they still have to
 * be grouped with their own.
 */
function channelOf(version: string): string {
  if (!isPrerelease(version)) return 'release'
  const identifier = version.split('-').slice(1).join('-').split('.')[0]
  return identifier || 'release'
}

/** What the summariser is sent: the material, and the facts to copy through. */
export interface RawRange {
  /** Every commit in the range, unrendered, grouped in section order. */
  commits: string
  /** Lines to reproduce verbatim rather than summarise — today, the diff link. */
  metadata: string
}

/**
 * The sections a config asks for, or the built-in set.
 *
 * One helper because three callers had the same `??` and a fourth would have
 * got it subtly wrong: `DEFAULT_SECTIONS` is readonly and spreading it at each
 * site is what keeps the returned array the caller's to hold.
 */
function sectionsOf(config: Config): readonly string[] {
  return config.changelog?.sections ?? [...DEFAULT_SECTIONS]
}

/**
 * The commits either side of a range, and the shas that name it.
 *
 * Four git calls that do not depend on each other, so they do not wait on each
 * other. `null` for the remote is ordinary — a clone with no origin is a clone
 * — and it costs the link in the diff line, not the line.
 */
async function walk(root: string, from: string, to: string) {
  const [commits, fromSha, toSha, remote] = await Promise.all([
    commitsIn(`${from}..${to}`, root),
    shortSha(from, root),
    shortSha(to, root),
    remoteUrl(root),
  ])

  return {
    commits,
    range:
      fromSha && toSha
        ? { from: fromSha, to: toSha, repo: normaliseRepo(remote) }
        : null,
  }
}

/**
 * Where a tag's own range begins: the release before it, or the first commit
 * when it is the first release there has ever been.
 *
 * `null` when the tag is not in this repository at all — a shallow clone, or a
 * name that was never a tag. Callers treat that as "say so and carry on", never
 * as a failure: this runs inside a publish job that has already tagged.
 */
async function spanStart(root: string, tag: string): Promise<string | null> {
  const tags = await releaseTags(root)
  const at = tags.findIndex(
    t => t.tag === tag || t.version === tag.replace(/^v/, ''),
  )
  if (at === -1) return null

  const describing = tags[at] as ReleaseTag
  const older = tags.slice(at + 1)

  /**
   * Reachable, not merely older.
   *
   * Two channels running at once interleave by date, so the tag before this one
   * can sit on a branch this one does not contain — and a range between two
   * branches reports whatever they do not share rather than what this release
   * added.
   */
  const behind = async (candidate: ReleaseTag) =>
    isAncestor(root, candidate.tag, describing.tag)

  // **The previous release *in this channel*.**
  //
  // `tags[at + 1]` was the neighbour by date whatever channel it belonged to,
  // and promoting a channel is where that fell over: cut 1.0.0-alpha.0 on
  // `alpha`, merge it to `main`, cut 1.0.0, and the range became
  // alpha.0..1.0.0 — the single commit made after the merge. Measured on a
  // fixture, the notes for 1.0.0 listed one fix and none of the three features
  // it shipped.
  //
  // Stable is a channel like any other here, so this states in one rule what
  // the file already does by hand: a stable release measures from the last
  // stable, because it contains its own prereleases. And an alpha measures from
  // the last alpha, so a beta cut in between does not truncate it.
  const mine = channelOf(describing.version)
  for (const candidate of older) {
    if (channelOf(candidate.version) !== mine) continue
    if (await behind(candidate)) return candidate.tag
  }

  // No previous release in this channel: the first alpha of a line measures
  // from whatever came last, which is the stable it is building on.
  for (const candidate of older) {
    if (await behind(candidate)) return candidate.tag
  }

  return await rootCommit(root)
}

/**
 * The rendered notes for an explicit range, from the commits alone.
 *
 * Never reads `CHANGELOG.md`. This is the form for a repository that keeps no
 * changelog, and for backfilling a release that predates one.
 */
export async function compileRange(
  root: string,
  from: string,
  to: string,
  config: Config,
): Promise<string> {
  const { commits, range } = await walk(root, from, to)

  if (!commits.length) {
    console.error(
      `cutver: no commits in ${from}..${to} — releasing without a body`,
    )
    return ''
  }

  return renderNotes({ commits, sections: sectionsOf(config), range })
}

/**
 * The changelog section for a tag, falling back to compiling its range.
 *
 * **The fallback is the useful half.** A repository with no changelog, or one
 * whose changelog predates the tag being published, would otherwise get an
 * empty release body — and an empty body next to five binaries is worse than a
 * mechanical list, because it reads as though nothing changed.
 */
export async function sectionOrCompile(
  root: string,
  tag: string,
  config: Config,
): Promise<string> {
  const changelog = await readText(`${root}/CHANGELOG.md`).catch(() => null)

  const section = changelog === null ? '' : sectionFor(changelog, tag)
  if (section) return section

  const why =
    changelog === null
      ? 'no CHANGELOG.md'
      : `no section for ${tag.replace(/^v/, '')}`
  const from = await spanStart(root, tag)
  if (!from) {
    console.error(
      `cutver: ${why}, and ${tag} is not a tag here — releasing without a body`,
    )
    return ''
  }

  console.error(
    `cutver: ${why} — compiling ${from}..${tag} from the commits instead`,
  )
  return compileRange(root, from, tag, config)
}

/**
 * The same range, with whole commit bodies rather than their leads.
 *
 * **The model reads more than the release does, because it is asked to do more
 * with it.** A rendered section is one paragraph per commit — the thesis, which
 * is what a changelog wants. The summariser's job is to give each distinct
 * change its own bullet, and the changes after the first live in the paragraphs
 * the thesis leaves behind. It cannot split what it never received.
 *
 * `null` when the range cannot be resolved — a tag that is not in this
 * repository, a shallow clone with no history behind it. The caller falls back
 * to the rendered section rather than failing: this is an improvement to the
 * summariser's input, and an improvement that can refuse is not one worth
 * stranding a release over.
 */
export async function fullBodies(
  root: string,
  first: string,
  second: string | undefined,
  config: Config,
): Promise<RawRange | null> {
  if (second) return rawRange(root, first, second, config)

  const from = await spanStart(root, first)
  return from ? rawRange(root, from, first, config) : null
}

/** The commits in a range, unformatted, and the diff line to copy through. */
export async function rawRange(
  root: string,
  from: string,
  to: string,
  config: Config,
): Promise<RawRange | null> {
  const { commits, range } = await walk(root, from, to)
  if (!commits.length) return null

  const body = rawCommits({ commits, sections: sectionsOf(config) })
  return body ? { commits: body, metadata: range ? diffLine(range) : '' } : null
}

/**
 * Every release as a compiled section, newest first.
 *
 * The whole history rather than the one being cut, because the file is
 * rewritten whole — see `index.ts` on why owning it beats editing it. Each
 * range runs from the previous tag to this one, and the newest runs from the
 * last tag to `HEAD`, which is the release about to be made.
 *
 * The `git log` calls do not wait on each other. A project with two hundred
 * tags spends two hundred cheap reads once per release, and the alternative —
 * trusting whatever the file said last time — is the parsing this mode exists
 * to avoid.
 *
 * @param pending      the release being cut, or `null` when regenerating. There
 *                     is no new version then, and inventing a heading for one
 *                     would put a release in the file that exists nowhere else.
 * @param prereleases  whether alpha/beta/rc tags get their own heading.
 */
export async function compileReleases(
  root: string,
  pending: { version: string; date: string } | null,
  sections: readonly string[],
  prereleases = false,
  /**
   * Compile only these versions, or all of them when absent.
   *
   * `changelog pages v1.2.0` needs one section and used to build every one to
   * find it — twice, because the caller compiled the file list first.
   */
  only?: Set<string>,
): Promise<ReleaseSection[]> {
  const [tags, remote, root0] = await Promise.all([
    releaseTags(root),
    remoteUrl(root),
    rootCommit(root),
  ])
  const repo = normaliseRepo(remote)

  // **Which tags get a heading, and what each one measures from.**
  //
  // With `prereleases: false` — the default — only stable tags are listed, and
  // each measures from the previous *stable* tag rather than the previous tag
  // of any kind. Widening the span is the whole of it: dropping the headings
  // alone would delete their commits from the file with nothing to say they
  // existed. Measured here, `v1.0.0` spans 2 commits from `v0.1.0-beta.12` and
  // 41 from the last stable point — the root commit, there being no stable
  // release before it. The other 39 are the beta series, and they shipped in
  // 1.0.0 whatever the tag history says.
  //
  // `plan.ts` already draws this distinction for a different question: any tag
  // decides *whether* to release, the last stable one decides *from what*.
  const listed = prereleases ? tags : tags.filter(t => !isPrerelease(t.version))

  // **The release being cut is filtered by the same rule as the tags.**
  //
  // It used to be added unconditionally, so with `prereleases: false` a beta
  // got a heading the moment it was cut — and lost it again on the next
  // regeneration, when the same version was a tag and the filter above caught
  // it. An entry that appears at release time and disappears later is worse
  // than either answer on its own.
  //
  // The span was wrong too, in a way that outlives the heading. A pending
  // prerelease measures from `listed[0]`, the last *stable* tag, so its section
  // listed every commit since that release — the same commits the eventual
  // stable version lists again when it lands. Two headings, one set of changes.
  const heads =
    pending && (prereleases || !isPrerelease(pending.version)) ? [pending] : []

  // `[being cut, newest tag, …]` paired with what each one measures from. The
  // oldest release measures from the first commit, which is not a tag.
  const spans = [
    ...heads.map(p => ({
      version: p.version,
      date: p.date,
      from: listed[0]?.tag ?? root0,
      to: 'HEAD',
    })),
    ...listed.map((t, i) => ({
      version: t.version,
      date: t.date,
      from: listed[i + 1]?.tag ?? root0,
      to: t.tag,
    })),
  ]

  // **Every span is worked out; only the wanted ones are read.** The spans
  // themselves are arithmetic over the tag list and cost nothing, and they have
  // to be computed in full because a release measures from the tag *before* it.
  // Reading them is what costs: a `git log` and two `rev-parse`s each, so a
  // repository with twenty-five tags spends fifty git invocations to write one
  // release page it was asked for by name.
  const wanted = only ? spans.filter(s => only.has(s.version)) : spans

  const built = await Promise.all(
    wanted.map(async span => {
      // Named as it goes. Regenerating walks every tag in the repository, and
      // on a project with a long history that is a silent minute — long enough
      // to wonder whether it is doing anything.
      //
      // **Dim, and through `warn` rather than `console.error`.** Thirty-eight
      // of these scroll past on a full regenerate, and they arrived red —
      // Bun wraps everything `console.error` prints in `\x1b[31m`, so a
      // command doing exactly what was asked looked like a wall of failures.
      // `warn` writes to stderr directly for that reason. The prose recedes
      // and the version — the only part that differs line to line — is the one
      // thing carrying colour.
      warn(`  %d· compiling%0 %cv${span.version}%0`)

      const [commits, from, to] = await Promise.all([
        commitsIn(`${span.from}..${span.to}`, root),
        shortSha(span.from, root),
        shortSha(span.to, root),
      ])

      return {
        version: span.version,
        date: span.date,
        notes: renderNotes({
          commits,
          sections,
          range: from && to ? { from, to, repo } : null,
        }),
      }
    }),
  )

  // A release whose commits are all `chore` compiles to nothing. Its heading
  // still belongs in the file — the version happened — so an empty one gets a
  // line rather than being dropped, which would leave a gap a reader would
  // read as a mistake.
  return built.map(r => ({
    ...r,
    notes: r.notes || '_No user-facing changes._',
  }))
}
