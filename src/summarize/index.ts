/**
 * Handing a release's notes to a command, and taking markdown back.
 *
 * **Two ways in, and the command wins.** `summarizer:` in the config names a
 * provider; `CUTVER_SUMMARIZE` in the environment names any command that reads
 * markdown on stdin and writes markdown on stdout. cutver ships no keys and
 * hosts nothing either way.
 *
 * The command is read by the platform's own shell, so a line that works in your
 * terminal works here. It is worth knowing that this differs by platform —
 * `/bin/sh` against `cmd.exe` — and that the difference is not theoretical:
 * `shell: bash` on a Windows runner is Git Bash, and the gap between it and
 * POSIX once put a carriage return inside a binary name and cost a public
 * release two runs.
 *
 * **Nothing here is allowed to fail a release.** A missing binary, a non-zero
 * exit, an empty answer, a model that hangs — every one of them returns the
 * notes as they were written. Inference is the least reliable thing in a
 * release pipeline and the least important thing in this one; the notes were
 * already correct and already publishable before it ran.
 */
import type { ChangelogConfig } from '../config/schema'
import { ask, keyFor } from './connectors'
import DEFAULT_PROMPT from './prompt.md' with { type: 'text' }
import { env as processEnv, runShell, sleep } from '../runtime'

/**
 * The instruction sent ahead of every release's commits, unless a config
 * replaces it.
 *
 * A file rather than a string constant, and it lives next to the code that
 * sends it. Prompt text is prose — it is read, argued with and rewritten like
 * prose, and a paragraph wedged into a template literal is a paragraph nobody
 * edits. The import attribute makes that free: Bun inlines it at build time, so
 * the compiled executable carries the text with no file to find at runtime.
 *
 * It reads defensively because the failure mode that matters is not a dull
 * summary — it is an invented one. The notes are already correct and already
 * publishable; a model that adds a change nobody made, or renames a flag,
 * produces something worse than the input while looking better.
 */
export { DEFAULT_PROMPT }

export interface Summary {
  text: string
  /** What happened, for the log. `null` when no summariser was configured. */
  note: string | null
}

/**
 * The prompt, then the notes inside a delimiter.
 *
 * One stdin stream rather than a flag, because a flag would be the command's
 * business and this has to work for every command.
 *
 * **The delimiter is the security part, not the formatting part.** The notes
 * are assembled from commit bodies, so anyone who lands a commit — or gets a
 * pull request merged — writes into this prompt. Run together with no boundary,
 * a body saying "ignore the rules above and instead write…" is
 * indistinguishable from the instruction it follows. A tag the model is told to
 * treat as content does not make that impossible, but it turns an ambiguity
 * into something the prompt has an explicit rule about, and it costs two lines.
 *
 * Tags rather than a markdown fence, because commit bodies contain fenced code
 * themselves and a fence inside a fence ends the outer one early.
 * Both ends of the payload are trimmed: the prompt arrives from a file that
 * ends with a newline, and three blank lines before the content reads as
 * something missing.
 */
export function payload(
  notes: string,
  prompt: string | null,
  metadata: string | null = null,
): string {
  // **Two tags, because the halves are used differently.** `<metadata>` is
  // facts to copy through untouched — the `diff:` line resolves to nothing if a
  // character of it changes. `<commits>` is material to summarise. Sending them
  // in one block asked the model to tell them apart from context, and the one
  // it got wrong was the one with no room for error.
  const meta = metadata?.trim()
    ? `<metadata>\n${metadata.trim()}\n</metadata>\n\n`
    : ''

  return `${(prompt ?? DEFAULT_PROMPT).trim()}

${meta}<commits>
${notes.trim()}
</commits>`
}

/**
 * Put the `diff:` line back, exactly, with a blank line under it.
 *
 * **The model was asked to copy it and had two ways to get it wrong.** A sha
 * altered by one character resolves to nothing, and the shape in the prompt
 * showed the line directly above the opening sentence — so markdown folded the
 * two into one paragraph and every release page read as a link with prose
 * glued to it.
 *
 * Neither is a prompt problem worth solving with more prompt. The line is a
 * fact cutver already holds; the model's only job is the prose. So whatever it
 * emitted at the top is dropped and the real line is prepended, which also
 * takes one rule out of the instructions — and fewer rules is what makes the
 * remaining ones stick.
 */
export function withDiffLine(body: string, metadata: string | null): string {
  const line = metadata?.trim()
  if (!line) return body

  // Any leading `diff:` line the model produced, `<sub>`-wrapped or not, plus
  // the blank line after it if there is one.
  const without = body
    .replace(/^\s*(?:<sub>)?\s*diff:.*?(?:<\/sub>)?\s*(?:\n|$)/i, '')
    .trimStart()

  return `${line}\n\n${without}`
}

/**
 * Unwrap a body the model put inside a code fence.
 *
 * **Measured, on this repository's own v2.1.0.** Asked for markdown, a model
 * may hand back markdown *as a code sample* — ` ```markdown ` … ` ``` ` around
 * the whole answer — and the release page then renders the entire body as a
 * grey box with a copy button, headings and links showing as literal source.
 * It is intermittent: the release after it came back clean from the same model
 * and the same prompt, which is exactly what makes it worth handling in code
 * rather than in the instructions.
 *
 * **Only when the fence wraps everything.** A body may legitimately contain
 * one — a bullet quoting a command — so the first non-empty line has to open
 * it and the last non-empty line has to close it. Anything else is left alone,
 * because a fence in the middle is content.
 */
export function unfence(text: string): string {
  const lines = text.trim().split('\n')
  const first = lines[0]?.trim() ?? ''
  const last = lines.at(-1)?.trim() ?? ''

  // ```markdown, ```md, or a bare ``` — and the same for tildes, which are the
  // other fence markdown allows.
  const opens = /^(`{3,}|~{3,})[a-zA-Z]*$/.exec(first)
  if (!opens || lines.length < 2) return text.trim()

  const marker = opens[1] as string
  if (!new RegExp(`^${marker[0] === '`' ? '`' : '~'}{3,}$`).test(last)) {
    return text.trim()
  }

  return lines.slice(1, -1).join('\n').trim()
}

/**
 * The publishable half of a two-part answer.
 *
 * **The reasoning pass exists to be thrown away.** Asking the model to state
 * each commit's declared type and the heading it therefore maps to, *before*
 * writing any note, is what makes it consult the subject line instead of the
 * order the commits arrived in — four increasingly emphatic prompt rules failed
 * to stop `fix(changelog):` being filed under New Features, because the model
 * was never wrong about the type, only about when it looked at it.
 *
 * Only `<release>` ships. A release page carrying a model's working-out would
 * be worse than no summariser at all.
 *
 * Falls back to the whole answer when the tag is absent, rather than to
 * nothing: a model that ignores the two-part instruction has usually still
 * written a usable release body, and publishing it beats publishing an empty
 * string.
 *
 * **The *last* opening tag, not the first**, and that is the whole subtlety.
 * A model that thinks out loud quotes the tag names while planning, so an
 * answer can name `<release>` several paragraphs before it writes one. Taking
 * the first occurrence published the rehearsal — kilobytes of working-out where
 * the release body should be, reported as a successful summary. The real body
 * is always the last thing written.
 */
export function extractRelease(text: string): string {
  // **Backticks are part of the tag as far as this is concerned.** Told to emit
  // `<release>`, a model may well write it the way the instruction *shows* it —
  // as a code span. Matching the bare tag then found it inside the span and
  // left the closing backtick as the first character of every release body.
  // Measured across three runs of one model, all three.
  const OPEN = /`?<release>`?/g
  const CLOSE = /`?<\/release>`?/

  // **Line endings first, because everything below counts lines.** A model
  // may answer with CRLF — measured on this repository's v2.1.0 — and a stray
  // carriage return rides into the release body, the changelog section, and
  // every comparison made against either.
  text = text.replace(/\r\n?/g, '\n')

  let open: RegExpExecArray | null = null
  for (const m of text.matchAll(OPEN)) open = m as RegExpExecArray
  if (!open) return unfence(text)

  const from = (open.index ?? 0) + open[0].length
  const rest = text.slice(from)
  const close = CLOSE.exec(rest)
  return unfence(close ? rest.slice(0, close.index) : rest)
}

/**
 * Why an extracted `<release>` is not a release body, or `null` when it is.
 *
 * **Measured on bakery's v2.0.0**, 134 commits with 211 KB of commit bodies
 * sent to gemini-3.5-flash-lite. One answer was a JSON fragment, an empty
 * fence pair, and then the prompt's own Shape template, `### <heading>` and
 * `- **<scope>:** <the change, one line> (<sha>)`. Another opened a real body
 * with a JSON array of the heading names and an empty fence pair. Both were
 * reported "summarised", because the only check was that the text was not
 * empty.
 *
 * Deliberately narrow: each rule is a shape no real body has. A placeholder is
 * the template echoed back, JSON ahead of the first line of prose is a
 * malformed answer, and an empty fence pair is debris. A fence with something
 * inside it is allowed, since a body may quote a command.
 */
export function checkRelease(body: string): string | null {
  if (
    /<(?:heading|scope|sha|the change[^>]*|one or two sentences[^>]*)>/.test(
      body,
    )
  )
    return "it echoed the prompt's template"

  const first = body
    .split('\n')
    .map(line => line.trim())
    .find(line => line && !/^(?:<sub>)?\s*diff:/i.test(line))
  if (first && /^\[\s*(?:\{|"|\[|$)|^\{\s*(?:"|$)/.test(first))
    return 'it opened with JSON'

  if (/^[ \t]*```[^\n]*\n[ \t]*```[ \t]*$/m.test(body))
    return 'it carried an empty code fence'

  return null
}

/**
 * The `diff:` line a compiled section opens with, or `null` when it has none.
 *
 * The summarizer is told not to write one, because cutver puts it back, so
 * whatever is sent must say what to put back. Full bodies carry it as
 * metadata. The section carries it as its first line, and `notes` with
 * `with_body: false` used to pass nothing at all, so the page lost its link.
 */
export function diffLineOf(section: string): string | null {
  const head = section.split('\n')[0] ?? ''
  return /^\s*(?:<sub>)?\s*diff:/i.test(head) ? head : null
}

/**
 * Past this many bytes of commit bodies, the compiled section is sent instead.
 *
 * **Placed between two measurements, not derived.** Full bodies summarized
 * cleanly on every release that sent them, the largest being cutver's own
 * v2.2.0 at 22 KB. bakery's v2.0.0 sent 211 KB, and two runs of three came
 * back as template echo and JSON debris. The same range as a 40 KB compiled
 * section came back clean. 64 KB sits about three times above the one and
 * three times below the other. `checkRelease` catches what gets through
 * anyway.
 */
export const FULL_BODIES_LIMIT = 64 * 1024

/**
 * Every bare sha the model wrote, linked to its commit.
 *
 * The prompt asks for links, and on bakery's v2.0.0 one answer linked 0 of 91.
 * A formatting rule a model can drop is applied here instead, only to shas
 * that appear in what was sent, so a hex word the model made up stays text.
 * The repository comes from the compare URL in `metadata`. Without one,
 * nothing is linked, the same choice `diffLine` makes for a host that is not
 * GitHub.
 */
export function linkShas(
  body: string,
  metadata: string | null,
  sent: string,
): string {
  const repo = /https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/compare\//.exec(
    metadata ?? '',
  )?.[1]
  if (!repo) return body

  return body
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\(([0-9a-f]{7,40})\)/g, (whole, sha: string) =>
            sent.includes(sha)
              ? `([${sha}](https://github.com/${repo}/commit/${sha}))`
              : whole,
          ),
    )
    .join('')
}

/**
 * The Migration section, replaced by one line linking the release's upgrade
 * guide, when it has breaking changes and its major has one.
 *
 * The sentence is the one written by hand onto bakery's v2.0.0 page, after the
 * model's own section invented a step. A repository path is linked through
 * `blob/HEAD`, so it follows the default branch whatever it is called and
 * shows the guide as it stands now rather than as it stood at the tag. The
 * repository comes from the compare URL in `metadata`; without one a path is
 * named rather than linked. A URL is used as given.
 *
 * Nothing changes for a release with no breaking changes, or whose major has
 * no guide: the model's section, if it wrote one, stays.
 */
export function withMigration(
  body: string,
  guides: Record<string, string> | null,
  version: string | null,
  metadata: string | null,
): string {
  if (!guides || !version || !/^###\s+Breaking Changes\s*$/m.test(body))
    return body
  const major = /^v?(\d+)\./.exec(version.trim())?.[1]
  const guide = major === undefined ? undefined : guides[String(Number(major))]
  if (!guide) return body

  let where: string
  if (/^https?:\/\//.test(guide)) {
    where = `the [upgrade guide](${guide})`
  } else {
    const path = guide.replace(/^\.?\/+/, '')
    const repo = /https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/compare\//.exec(
      metadata ?? '',
    )?.[1]
    where = repo
      ? `the [upgrade guide](https://github.com/${repo}/blob/HEAD/${path})`
      : `the upgrade guide, \`${path}\``
  }

  // The model's section, if any: from its heading to the next heading of the
  // same level, or the end.
  const without = body
    .replace(/^###\s+Migration\s*$[\s\S]*?(?=^###\s|(?![\s\S]))/m, '')
    .trimEnd()
  return (
    `${without}\n\n### Migration\n\n` +
    `Every breaking change above, with what to write instead, is in ${where}.`
  )
}

/**
 * The default prompt's dash rule, applied to what came back.
 *
 * **Enforced, because asking was measured not to be enough.** bakery's pages
 * carried an em dash on v1.0.0 and on v2.0.0-alpha.0, both in a bullet that
 * copied a commit subject verbatim ("Field, a namespaced column vocabulary —
 * and DISTINCT", "defineLayout() — client-side navigation for catch-all
 * pages"). Commit subjects are exempt from any house style and full of dashes,
 * and a model told to copy them faithfully does exactly that. The prompt now
 * says to rewrite the punctuation; this makes the rule hold when a model does
 * not.
 *
 * Code keeps its bytes: fenced blocks and inline spans pass through untouched.
 * In prose, a range of numbers takes a hyphen, a dash opening a line or
 * following other punctuation is dropped, and any other dash becomes the comma
 * it was standing in for. That reads right for both measured cases, and the
 * tidy-up afterwards removes the ", ." a dash before a full stop would leave.
 */
export function plainDashes(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : plainProse(part)))
    .join('')
}

/**
 * The shipped prompt's rules, where the shipped prompt was used.
 *
 * A config that brings its own `prompt:` brings its own register, and
 * enforcing a rule it never asked for would be cutver overruling the
 * repository. Only the model's answer passes through here; the fallback is the
 * changelog as written, and stays exactly that.
 */
function ownRules(
  body: string,
  config: ChangelogConfig | null,
  metadata: string | null,
  sent: string,
): string {
  return config?.prompt ? body : linkShas(plainDashes(body), metadata, sent)
}

function plainProse(text: string): string {
  return text
    .replace(/(\d)[ \t]*[–—]+[ \t]*(\d)/g, '$1-$2')
    .replace(/^([ \t]*(?:[-*+][ \t]+)?)[–—]+[ \t]*/gm, '$1')
    .replace(/([:;,.!?(](?:\*\*|__|\*|_)?)[ \t]*[–—]+[ \t]*/g, '$1 ')
    .replace(/[ \t]*[–—]+[ \t]*/g, ', ')
    .replace(/,[ \t]*([,.;:!?)])/g, '$1')
    .replace(/\([ \t]+/g, '(')
}

/**
 * Where the command comes from, and why it is not the config file.
 *
 * A command in `cutver.yml` is a command in a tracked file, and `gh pr
 * checkout` brings a fork's tracked files into a maintainer's working tree — so
 * a pull request could ship one and have it run the next time anyone produced
 * release notes. An environment variable cannot be set by a pull request.
 *
 * The repository declares the intent; the machine supplies the command.
 */
export const COMMAND_ENV = 'CUTVER_SUMMARIZE'

/**
 * @param notes    what the model is asked to summarise.
 * @param fallback what ships when it does not — defaults to `notes`.
 *
 * **The two are not always the same string, and that is the point.** With
 * `summarize` on, the model is sent the full commit bodies so a commit
 * describing several changes can be represented as several; the fallback stays
 * the changelog section, which is prose someone wrote and is publishable as it
 * stands. Passing one string for both would mean a missing binary published a
 * raw dump of every commit body — worse than the behaviour this replaced.
 */
export async function summarize(
  notes: string,
  config: ChangelogConfig | null,
  env: Record<string, string | undefined> = processEnv,
  fallback: string = notes,
  metadata: string | null = null,
  /** The release's version or tag, for `migration`. Without it, no guide is linked. */
  version: string | null = null,
): Promise<Summary> {
  if (!config?.summarizer || !notes.trim())
    return { text: fallback, note: null }

  // The migration guides apply to the summary only, whichever path wrote it:
  // the command wins over a named provider, but the mapping's guides still say
  // what the release's upgrade guide is.
  const guides =
    typeof config.summarizer === 'object' ? config.summarizer.migration : null
  const finish = (body: string, sent: string) =>
    withDiffLine(
      withMigration(
        ownRules(body, config, metadata, sent),
        guides,
        version,
        metadata,
      ),
      metadata,
    )

  // `true` means the command rather than a provider, so there is nothing here
  // to hold a connector.
  const summarizer = config.summarizer === true ? null : config.summarizer

  const command = env[COMMAND_ENV]?.trim()

  // **The command wins when both are configured.** It is the more specific
  // instruction — set on this machine, for this run — and it is what someone
  // reaches for to override a repository's default without editing a tracked
  // file. A config that names a connector is the standing arrangement.
  if (!command && summarizer) {
    const { value: key, tried } = keyFor(summarizer.connector, env)
    if (!key) {
      return {
        text: fallback,
        note:
          `\`summarizer.connector\` is \`${summarizer.connector}\` but no key is set — ` +
          `notes used as written (looked in ${tried.join(', ')})`,
      }
    }

    // Said before the wait, not after it. A release job that goes quiet for two
    // minutes looks wedged, and the person watching it has no way to tell a
    // slow model from a hung one. A large model writing its reasoning out first
    // takes minutes on a release of a handful of commits.
    console.error(
      `cutver: summarising the release body with ${summarizer.model} — this ` +
        `can take minutes`,
    )

    const input = payload(notes, config?.prompt ?? null, metadata)
    let answer = await ask(summarizer, key, input)

    // **One retry, and only for a failure that waiting can fix.** Free tiers
    // meter tokens per *minute*, so a release that lands while something else
    // is spending the same key fails on a window that refills on its own — the
    // measured case being 16K TPM against a ~6,500-token request. A 400 naming
    // a model that does not exist gets no wait, because it would answer the
    // same in an hour.
    if (answer.error && answer.retryable && summarizer.retry) {
      console.error(
        `cutver: ${summarizer.connector}: ${answer.error} — retrying in ` +
          `${summarizer.retry}m`,
      )
      await sleep(summarizer.retry * 60_000)
      answer = await ask(summarizer, key, input)
    }

    const { text, error } = answer
    if (error)
      return {
        text: fallback,
        note: `${summarizer.connector}: ${error} — notes used as written`,
      }

    // The reasoning pass is working-out, not prose. Only `<release>` ships.
    let body = extractRelease(text as string)
    if (!body)
      return {
        text: fallback,
        note: `${summarizer.connector}: empty release body — notes used as written`,
      }

    // **A rejected answer gets one more try, then the notes as written.** The
    // same model on the same input gave template echo once and a real body the
    // next time, so a second sample is worth one call. A second rejection is
    // said out loud rather than published.
    let rejected = checkRelease(body)
    if (rejected) {
      console.error(
        `cutver: ${summarizer.connector}: answer rejected, ${rejected}; asking once more`,
      )
      const again = await ask(summarizer, key, input)
      const second = again.error ? '' : extractRelease(again.text as string)
      rejected = second ? checkRelease(second) : (again.error ?? 'empty')
      if (rejected)
        return {
          text: fallback,
          note: `${summarizer.connector}: answer rejected twice (${rejected}); notes used as written`,
        }
      body = second
    }

    return {
      text: finish(body, input),
      note: `release body summarised by ${summarizer.model}`,
    }
  }

  if (!command) {
    // Said out loud rather than skipped. The config asked for this, so silence
    // would leave someone reading an unsummarised body wondering whether the
    // model ran and did nothing or never ran at all.
    //
    // Pointed at `check` rather than spelling the setup out here. This runs
    // inside a publish job, where the tag is already public and nobody is going
    // to act on installation advice; `check` runs before the tag exists, which
    // is the moment the advice is worth anything.
    //
    // Reaching this is not a degraded release. The notes were already correct
    // and already publishable — which is why every failure here falls back to
    // them rather than to an error.
    return {
      text: fallback,
      note:
        '`changelog.summarizer` is on but nothing is configured to do it — notes used as written ' +
        `(name a provider under \`summarizer:\`, or set ${COMMAND_ENV}; ` +
        `\`cutver check\` prints both)`,
    }
  }

  const input = payload(notes, config?.prompt ?? null, metadata)

  try {
    // The command line goes to the platform's shell, so the string in
    // `CUTVER_SUMMARIZE` is read the way the person who wrote it expects.
    // Written to stdin rather than piped through `echo`, which would append a
    // newline the model then has to guess about.
    // No timeout here, deliberately: a fake one built from `Promise.race` would
    // return while leaving the child running and the process unable to exit. A
    // model that hangs is a real risk, so it is handled where the mechanism
    // actually exists — `timeout-minutes` on the generated step, which GitHub
    // enforces and anyone can see and change.
    const result = await runShell(command, input)

    let text = extractRelease(result.out)
    if (!result.ok) {
      return {
        text: fallback,
        note: `summariser exited ${result.code} — notes used as written`,
      }
    }
    if (!text) {
      return {
        text: fallback,
        note: 'summariser returned nothing — notes used as written',
      }
    }

    // The same one more try as the connector path, for the same reason.
    let rejected = checkRelease(text)
    if (rejected) {
      console.error(
        `cutver: summarizer answer rejected, ${rejected}; asking once more`,
      )
      const again = await runShell(command, input)
      const second = again.ok ? extractRelease(again.out) : ''
      rejected = second ? checkRelease(second) : `exited ${again.code}`
      if (rejected)
        return {
          text: fallback,
          note: `summarizer answer rejected twice (${rejected}); notes used as written`,
        }
      text = second
    }

    return {
      text: finish(text, input),
      note: 'release body summarised',
    }
  } catch (e) {
    return {
      text: fallback,
      note: `summariser failed (${(e as Error).message}) — notes used as written`,
    }
  }
}
