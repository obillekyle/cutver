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

  let open: RegExpExecArray | null = null
  for (const m of text.matchAll(OPEN)) open = m as RegExpExecArray
  if (!open) return text.trim()

  const from = (open.index ?? 0) + open[0].length
  const rest = text.slice(from)
  const close = CLOSE.exec(rest)
  return (close ? rest.slice(0, close.index) : rest).trim()
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
): Promise<Summary> {
  if (!config?.summarizer || !notes.trim())
    return { text: fallback, note: null }

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
    const body = extractRelease(text as string)
    if (!body)
      return {
        text: fallback,
        note: `${summarizer.connector}: empty release body — notes used as written`,
      }
    return {
      text: body,
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
        '`changelog.summarize` is on but nothing is configured to do it — notes used as written ' +
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

    const text = extractRelease(result.out)
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
    return { text, note: 'release body summarised' }
  } catch (e) {
    return {
      text: fallback,
      note: `summariser failed (${(e as Error).message}) — notes used as written`,
    }
  }
}
