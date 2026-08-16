/**
 * The config says one thing; the generated workflow was written before it.
 *
 * `cutver init` derives the branch triggers and the dist-tag arms from the
 * config, which is what stops them being nine hard-coded literals — but it does
 * that **once**, and nothing has ever checked that a workflow still matches the
 * config it was generated from. Add a channel, forget to regenerate, and the
 * publish reaches its last step and dies on the catch-all *after the tag and
 * the release commit are already public*. That failure is described in
 * `init.ts` as the reason the arms are derived at all; this is the part that
 * notices.
 *
 * **Two rules about where this runs, and both matter more than the check.**
 *
 * It is not in the pre-push hook. `cutver check` runs on every branch of every
 * push and refuses only for the branch-declaration case; widening it to CI
 * drift would block ordinary feature-branch work for something unrelated to the
 * commit being pushed. Worse, a hand-maintained workflow is legitimate — the
 * repository this tool was extracted from must *never* regenerate
 * `publish.yml`, because npm's trusted-publisher configuration names that exact
 * file — and a blocking check there would wedge it forever behind
 * `--no-verify`.
 *
 * It runs at release time instead, before the tag exists. A refusal there costs
 * a re-run; the same refusal ten seconds later costs a version number that can
 * never be reused.
 *
 * **Only one thing is a refusal.** A channel the publish workflow cannot name a
 * dist-tag for is certainly fatal and certainly after the fact. Everything else
 * is a warning, because everything else is either recoverable or a deliberate
 * choice someone made about their own CI.
 */
import { branchTriggers, distTagArms } from './init'
import { producesArtifacts, type Config } from './config/schema'
import { parseYaml, readText } from './runtime'

const DOCS = 'https://cutver.okyle.dev'

export interface Drift {
  level: 'refuse' | 'warn'
  message: string
  /**
   * Where to read more.
   *
   * Every finding has one. The lines to paste fix *this* occurrence; the page
   * explains why the thing exists, which is what stops the next person hitting
   * it again for a slightly different reason and pasting the wrong fix.
   */
  docs: string
}

export interface Workflows {
  /** Raw `version.yml`, or `null` when there is none. */
  version: string | null
  /** Raw `publish.yml`, or `null` when there is none. */
  publish: string | null
}

/**
 * The prerelease channel in a version, or `null` for a stable one.
 *
 * `1.3.0-canary.0` -> `canary`. The counter is required: `1.3.0-canary` without
 * one is not a shape cutver produces, and matching it would report drift for a
 * version that will never be published.
 */
export function channelOf(version: string): string | null {
  return /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)\.\d+$/.exec(version)?.[1] ?? null
}

/**
 * Findings for a release about to be cut.
 *
 * Pure, so the awkward cases are testable without a repository — and there are
 * more of them than the check looks like it has, because every one has to be
 * silent when the answer is "this repository does its CI differently".
 */
export function inspect(
  files: Workflows,
  config: Config,
  version: string,
  /**
   * The adapter, already resolved.
   *
   * **Deriving it from `config.target` here was wrong in the one case that
   * matters.** `target` is `null` whenever a repository lets detection decide,
   * so a Cargo workspace with no `target:` key was judged `js` — and
   * `DEFAULT_ARTIFACTS.js` is `false`, which meant the "publish.yml builds no
   * artifacts" warning could never fire on the ecosystem where artifacts are
   * the default. Silently, which is the worst way for a check to be wrong.
   *
   * Both real callers already hold the resolved id and were throwing it away.
   * The fallback stays for tests that construct a config directly.
   */
  adapter: 'js' | 'cargo' = config.target === 'cargo' ? 'cargo' : 'js',
): Drift[] {
  const found: Drift[] = []

  // No workflows at all is not drift. A repository releasing from a laptop, or
  // from CI cutver did not generate, is a normal repository — and a tool that
  // complained about a file it was never asked to write would be inventing a
  // requirement.
  if (files.publish) {
    // Only meaningful when this workflow actually resolves a dist-tag. An
    // artifacts-only cargo release has no dist-tag at all and needs no arms.
    //
    // **Not `esac`.** That was the first attempt and it matched the *other*
    // case in the same file — the one that decides whether a tag is marked as
    // a prerelease — so every artifacts-only Rust workspace was told its three
    // default channels had no arms. The step's `id` and the catch-all's own
    // wording are what actually identify a dist-tag resolver, and both err
    // toward silence on a workflow written by hand.
    const hasCase =
      files.publish.includes('disttag') ||
      files.publish.includes('unrecognised prerelease')
    const channel = channelOf(version)

    if (hasCase && channel && !files.publish.includes(`*-${channel}.`)) {
      found.push({
        level: 'refuse',
        message:
          `publish.yml has no dist-tag arm for \`${channel}\`, and this release is ` +
          `${version}.\n` +
          '        Its catch-all refuses an unrecognised prerelease rather than\n' +
          '        defaulting it to `latest` — so the publish would fail after the tag\n' +
          '        and the release commit are already public.\n' +
          '\n' +
          '        Add this arm above the `*-*)` line in publish.yml:\n' +
          `          *-${channel}.*)  tag=${channel} ;;`,
        docs: `${DOCS}/#/reference/config`,
      })
    }

    // Channels that are declared but unnameable. Not this release's problem,
    // and that is exactly why it is a warning: the day someone cuts one, it is.
    if (hasCase) {
      const missing = distTagArms(config)
        .map(arm => /\*-([a-z-]+)\./.exec(arm)?.[1])
        .filter(
          (c): c is string =>
            !!c && c !== channel && !files.publish?.includes(`*-${c}.`),
        )

      if (missing.length) {
        found.push({
          level: 'warn',
          message:
            `publish.yml has no dist-tag arm for ${missing.map(c => `\`${c}\``).join(', ')}. ` +
            'A release in one of those channels would fail after its tag is public.\n' +
            '        Add above the `*-*)` line in publish.yml:\n' +
            missing.map(c => `          *-${c}.*)  tag=${c} ;;`).join('\n'),
          docs: `${DOCS}/#/reference/config`,
        })
      }
    }

    // **Two shapes, because the generated one is not the only correct one.**
    // `init` writes a build matrix that hands binaries to a release job through
    // `upload-artifact`; this repository's own hand-written workflow builds and
    // attaches in a single job with `gh release upload`. Testing only for the
    // generated shape reported a false positive against the very project that
    // wrote the check.
    const attaches =
      files.publish.includes('upload-artifact') ||
      files.publish.includes('release upload')

    const wantsArtifacts = producesArtifacts(adapter, config)
    if (wantsArtifacts && !attaches) {
      found.push({
        level: 'warn',
        message:
          'the config asks a tag to produce artifacts, but publish.yml builds none, ' +
          'so the release will carry no binaries.\n' +
          '        The job is too long to print here — generate one into an empty\n' +
          '        directory and copy it across, or drop `artifacts` from `publish`:\n' +
          '          cutver init <ecosystem> --cwd /tmp/scratch --no-hook',
        docs: `${DOCS}/#/guides/artifacts`,
      })
    }

    // **Opted in, and nothing to run it with.** `changelog.summarize: true` is
    // the repository saying it wants a summarised body; the command that does
    // the summarising deliberately does not live in the config, so turning the
    // switch on is only half of it. Nothing warns you about the other half —
    // the release simply goes out with the notes as written, which is a correct
    // release and therefore one nobody looks twice at.
    //
    // A warning, never a refusal. Notes as written were always the fallback and
    // are always publishable; refusing a release because a model is missing
    // would make inference the most load-bearing thing in the pipeline, which
    // is the opposite of how it is wired everywhere else.
    // `true` means "use the command", so this fires only when the workflow has
    // no command either. A mapping names a provider and needs nothing from the
    // workflow but a key.
    if (
      config.changelog?.summarizer === true &&
      !hasSummarizer(files.publish)
    ) {
      found.push({
        level: 'warn',
        message:
          '`changelog.summarize` is on, but nothing is configured to do it — ' +
          'the release body goes out as written.\n' +
          '        Name a provider in cutver.yml:\n' +
          '          summarizer:\n' +
          '            connector: gemini      # or anthropic, openai-compatible\n' +
          '            model: gemini-3.5-flash\n' +
          '        and set the key in your CI secrets as `CUTVER_SUMMARIZE_KEY`.\n' +
          '        There is no key in the config: this file is committed and published.\n' +
          '\n' +
          '        `CUTVER_SUMMARIZE` in the environment still works and still wins —\n' +
          '        any command reading markdown on stdin and writing it on stdout.',
        docs: `${DOCS}/#/guides/changelog`,
      })
    }

    // A workflow older than `cutver notes` carries the extraction itself, so it
    // cannot pick up `changelog.summarize` or anything else added since.
    // **Only where a release body exists to extract.** `cutver notes` runs in
    // the job that creates the GitHub release, which `init` writes only for
    // `artifacts`. A registry-only workflow has no release page and no notes
    // step, and warning that it "extracts the release body itself" told every
    // such repository to add a step to a job that does not exist.
    const makesRelease = files.publish.includes('gh release')
    if (
      config.changelog &&
      makesRelease &&
      !files.publish.includes('notes "$TAG"')
    ) {
      found.push({
        level: 'warn',
        message:
          'publish.yml extracts the release body itself, so changelog settings in ' +
          'your config never reach it.\n' +
          '        Replace that step with:\n' +
          '          - name: Release notes\n' +
          '            timeout-minutes: 15\n' +
          '            continue-on-error: true\n' +
          '            run: cutver notes "$TAG" > notes.md',
        docs: `${DOCS}/#/guides/changelog`,
      })
    }
  }

  // **A workflow written before 2.0 releases nothing, and says nothing.**
  // Releasing used to be the bare invocation, so every generated `version.yml`
  // runs `cutver --if-needed`. That is now a command-less invocation: it prints
  // the command list and exits non-zero in CI, which is loud — but a workflow
  // with `continue-on-error`, or one whose step is `|| true`, swallows it and
  // goes green having released nothing.
  //
  // Matched on `cutver` followed directly by a flag, which no correct
  // invocation produces. `npx --yes cutver stage` does not match: the flag
  // there precedes the word.
  for (const [name, text] of [
    ['version.yml', files.version],
    ['publish.yml', files.publish],
  ] as const) {
    if (text && /cutver\s+--(?!version\b|help\b)/.test(text)) {
      found.push({
        level: 'warn',
        message:
          `${name} runs cutver with no command, which is the pre-2.0 shape.\n` +
          '        Releasing is `cutver stage` now, so that step releases nothing.\n' +
          '        Change the line to `cutver stage --if-needed …`, or re-run\n' +
          '          cutver init --force',
        docs: `${DOCS}/#/getting-started/ci`,
      })
    }
  }

  if (files.version) {
    // **Parsed, not searched.** `includes(branch)` was the first attempt and it
    // is wrong in both directions: `main` is a substring of `domain`, `beta` of
    // `*-beta`, and — measured on this project — `**` matched a bold-markdown
    // `**word**` inside a comment, so the check silently passed on a workflow
    // that was genuinely missing a trigger. A workflow that will not parse is
    // skipped rather than reported: it is not this check's business, and the
    // release run is the wrong place to find out.
    const expected = branchTriggers(config)
    const declared = triggerBranches(files.version)
    const missing =
      declared === null ? [] : expected.filter(b => !declared.includes(b))
    if (missing.length) {
      found.push({
        level: 'warn',
        message:
          `version.yml does not trigger on ${missing.map(b => `\`${b}\``).join(', ')}. ` +
          'A push to one of those releases nothing, with no error to notice.\n' +
          '        Add under `on.push.branches` in version.yml:\n' +
          missing
            .map(b => `          - ${/^[*?]/.test(b) ? `'${b}'` : b}`)
            .join('\n'),
        docs: `${DOCS}/#/getting-started/ci`,
      })
    }
  }

  return found
}

/**
 * Whether `publish.yml` has a summariser command, rather than the seam for one.
 *
 * `init` writes `CUTVER_SUMMARIZE: ''` — the key is there so the comment
 * explaining it has somewhere to live, which means presence of the name proves
 * nothing. The empty forms are what a generated-but-unconfigured workflow looks
 * like, and they are the case worth reporting.
 */
function hasSummarizer(publish: string): boolean {
  const line = /^[ \t]*CUTVER_SUMMARIZE:[ \t]*(.*)$/m.exec(publish)
  if (!line) return false
  const value = (line[1] ?? '').trim()
  return value !== '' && value !== "''" && value !== '""'
}

/**
 * `on.push.branches`, or `null` when the file will not parse or has no such
 * key.
 *
 * `null` means "do not report", which is the right answer for a workflow this
 * check does not understand. A repository is allowed to trigger its release job
 * however it likes.
 */
export function triggerBranches(yaml: string): string[] | null {
  try {
    const doc = parseYaml(yaml) as Record<string, any>
    // `on` is the YAML 1.1 boolean `true`, which is why it can arrive under
    // either key depending on the parser. Both are checked rather than assumed.
    const on = doc?.on ?? doc?.true
    const branches = on?.push?.branches
    return Array.isArray(branches) ? branches.map(String) : null
  } catch {
    return null
  }
}

/** Read both workflows. Absent is `null`, and never an error. */
export async function readWorkflows(root: string): Promise<Workflows> {
  const read = (name: string) =>
    readText(`${root}/.github/workflows/${name}`).catch(() => null)

  const [version, publish] = await Promise.all([
    read('version.yml'),
    read('publish.yml'),
  ])
  return { version, publish }
}
