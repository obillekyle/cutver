/**
 * `cutver init <cargo|node|bun>` — write the release workflows into a
 * repository that does not have them.
 *
 * **The split is the thing being scaffolded, not the convenience.** Two
 * workflows, always: one that computes a version and pushes a tag, one that
 * publishes and only ever fires on a tag. Handing someone a single
 * "release.yml" that does both would be easier to generate and would throw
 * away the one property that matters — publishing is irreversible, so it gets
 * its own trigger and its own credentials.
 *
 * Both files carry the two gotchas that cost real releases to learn, as
 * comments rather than as folklore:
 *
 *   - A tag pushed with the default `GITHUB_TOKEN` cannot start another
 *     workflow. GitHub blocks it to prevent recursion, so the tagging job has
 *     to dispatch the publishing one explicitly.
 *   - The signal for "a release happened" is whether the version moved, never
 *     whether the tree is dirty.
 *
 * Nothing here is overwritten without `--force`. An `init` that clobbers a
 * workflow someone has been editing for a year is not a helper.
 *
 * **This file decides what to write; `workflows.ts` is what gets written.** The
 * YAML lives there as templates, and the two lists a workflow cannot derive at
 * run time — its branch triggers and its dist-tag arms — live in `triggers.ts`,
 * where `drift.ts` can reach the same derivation rather than a second copy of
 * the rules.
 */

import { addDevDependency } from '../adapters/js'
import { HOOK_NAME, installHook } from '../hook'
import {
  DEFAULT_CONFIG,
  ECOSYSTEMS,
  producesArtifacts,
  publishesToRegistry,
  type Config,
  type Ecosystem,
} from '../config/schema'
import { ADAPTER_FOR } from '../adapters'
import { parseConfig } from '../config/load'
import { configTemplate } from '../config/template'
import { publishWorkflow, versionWorkflow } from './workflows'
import { exists, parseYaml, remove, write } from '../runtime'
import { detectPublishes } from './detect'

// Declared once, in `config/schema.ts`, because `target:` in the config names
// the same set. Two copies type-checked only because the unions happened to be
// identical — the day one gained an entry the other did not, the error would
// have surfaced somewhere unrelated to either.
export { ECOSYSTEMS, type Ecosystem }

// Re-exported so `./init` stays the one import for everything scaffolding-
// related. `drift.ts` wants the two derivations; the CLI wants the runner
// matrix to probe.
export { branchTriggers, distTagArms } from './triggers'
export { CARGO_RUNNERS } from './workflows'
export { detectCi, detectEcosystem, detectPublishes, type Ci } from './detect'

export interface InitFile {
  /** Repo-relative path. */
  path: string
  /** The whole file, ready to write. */
  contents: string
  /** Only written when absent — a changelog with real notes in it is not ours. */
  onlyIfAbsent?: boolean
}

/** Whether this repository compiles its changelog rather than writing it by hand. */
function compilesNotes(config: Config): boolean {
  return (config.changelog?.sections.length ?? 0) > 0
}

/**
 * The changelog stub, which depends on who is going to write it.
 *
 * `## [Unreleased]` is a place to write by hand between releases. A repository
 * with `changelog:` set is having its sections compiled from the commits, so
 * scaffolding that heading would leave an empty one at the top of the file
 * forever, waiting for prose nobody is going to add.
 */
function changelogStub(config: Config): string {
  return compilesNotes(config)
    ? `# Changelog

Compiled from the commit messages by \`cutver\` — each entry is a commit subject
and the first paragraph of its body.

**Edits below this line are overwritten.** The file is rewritten whole from the
tags on every release, which is what keeps it in step with the history rather
than with whatever it said last time. Prose that should survive belongs in the
commit body, where it is compiled in and attributed to the change it describes.
`
    : `# Changelog

## [Unreleased]
`
}

/** Everything \`init\` would write, without touching the disk. */
export function initFiles(
  eco: Ecosystem,
  version?: string,
  config: Config = DEFAULT_CONFIG,
  publishes = true,
): InitFile[] {
  // A tag that produces nothing needs no workflow to produce it. Writing an
  // empty publish.yml would leave a file whose whole job is to be misread as
  // broken; `version.yml`'s handoff step is skipped to match.
  const registry = publishesToRegistry(ADAPTER_FOR[eco], config)
  const artifacts = producesArtifacts(ADAPTER_FOR[eco], config)

  return [
    {
      path: '.github/workflows/version.yml',
      contents: versionWorkflow(eco, config, version),
    },
    ...(registry || artifacts
      ? [
          {
            path: '.github/workflows/publish.yml',
            contents: publishWorkflow(
              eco,
              config,
              version,
              registry,
              artifacts,
            ),
          },
        ]
      : []),
    // Only if absent, and never with content: a changelog is prose someone
    // writes. cutver opens the heading and fills in nothing.
    {
      path: 'CHANGELOG.md',
      contents: changelogStub(config),
      onlyIfAbsent: true,
    },
    // Also only if absent. A config already in the tree is the repository's
    // release policy; replacing it would change version numbers with no commit
    // to blame, which is the one thing this whole tool is arranged against.
    {
      path: 'cutver.yml',
      contents: configTemplate(eco, publishes),
      onlyIfAbsent: true,
    },
  ]
}

export interface InitResult {
  path: string
  state: 'written' | 'skipped' | 'stale'
  detail: string
}

/**
 * Files this config says should **not** exist.
 *
 * **A config change can un-generate a file, and nothing was noticing.** Set
 * `publish: false` and re-run `init`: the publish workflow drops off the list
 * above, so it is never rewritten — and never removed either. It stays on disk
 * triggered on `push: tags: v*`, still running `npm publish`, while the
 * regenerated `version.yml` says in a comment that there is no publish.yml to
 * dispatch. Three statements about one file, two of them wrong, and the file is
 * the one that reaches a registry.
 */
export function obsoleteFiles(eco: Ecosystem, config: Config): string[] {
  const registry = publishesToRegistry(ADAPTER_FOR[eco], config)
  const artifacts = producesArtifacts(ADAPTER_FOR[eco], config)

  return registry || artifacts ? [] : ['.github/workflows/publish.yml']
}

/**
 * The range to pin cutver at.
 *
 * Exact for a prerelease, caret for a stable release. `^0.1.0-beta.6` is not
 * the range anyone means — a caret on a 0.x prerelease matches only later
 * prereleases of that same 0.1.0, which reads as a range and behaves as a pin.
 * Being explicit about it beats being subtly narrow.
 */
export function pinFor(version: string): string {
  return version.includes('-') ? version : `^${version}`
}

export interface InitOptions {
  force?: boolean
  dryRun?: boolean
  /**
   * The repository's rules, so the generated triggers and dist-tag arms match
   * the config that is actually there rather than the defaults.
   */
  config?: Config
  /** Install the pre-push guard too. On by default: it is part of "set this up". */
  hook?: boolean
  /**
   * The running cutver's version, pinned into the manifest so the tool that
   * computes your version numbers does not float. `dev` (running from source)
   * pins nothing — there is no published version to name.
   */
  version?: string
}

export async function init(
  root: string,
  eco: Ecosystem,
  {
    force = false,
    dryRun = false,
    hook = true,
    version,
    config = DEFAULT_CONFIG,
  }: InitOptions = {},
): Promise<InitResult[]> {
  const out: InitResult[] = []

  // **The workflows must match the config this run is about to write**, not
  // the built-in defaults. Without this, `init` on a fresh repository writes a
  // `cutver.yml` saying one thing and an `on.push.branches` list derived from
  // another — and the disagreement is invisible until a branch silently fails
  // to trigger. When a config already exists it wins, because it is the
  // repository's actual policy.
  //
  // **And the config it writes has to match the manifest.** A `private: true`
  // package scaffolds `publish:` commented out, which makes `publishesToRegistry`
  // false, which is what stops `publish.yml` being written at all — so this has
  // to be resolved before the effective config is parsed, not after.
  const publishes = await detectPublishes(root)
  const effective = config.source
    ? config
    : parseConfig(parseYaml(configTemplate(eco, publishes)), 'cutver.yml')

  for (const file of initFiles(eco, version, effective, publishes)) {
    const full = `${root}/${file.path}`
    const present = await exists(full)

    if (present && (file.onlyIfAbsent || !force)) {
      out.push({
        path: file.path,
        state: 'skipped',
        detail: file.onlyIfAbsent
          ? 'already exists'
          : 'already exists — --force to replace',
      })
      continue
    }

    if (!dryRun) await write(full, file.contents)
    out.push({
      path: file.path,
      state: 'written',
      detail: present ? 'replaced' : 'created',
    })
  }

  // **The workflows and the hook both need a cutver to run, so pin one.**
  // Without this both reach for `bunx cutver`, which resolves `latest` from
  // the registry on every run — so the tool that decides your version numbers
  // floats, and a cutver release could change them without a commit in your
  // repository. A devDependency also makes `bunx`/`npx` prefer the local copy,
  // so nothing has to be re-fetched per run.
  //
  // Cargo repositories get no say here: there is no JavaScript manifest to pin
  // into, which is why the executable exists and why `init cargo` downloads it.
  if (eco !== 'cargo') {
    if (!version || version === 'dev') {
      out.push({
        path: 'package.json',
        state: 'skipped',
        detail: 'cutver is running from source — nothing to pin',
      })
    } else {
      const range = pinFor(version)
      const result = await addDevDependency(root, 'cutver', range, dryRun)
      out.push({
        path: 'package.json',
        state: result === 'added' ? 'written' : 'skipped',
        detail:
          result === 'added'
            ? `devDependency cutver@${range}`
            : 'already declares cutver — left alone',
      })
    }
  }

  if (hook) {
    // `init` deliberately works in a tree that is not a repository yet —
    // scaffolding before `git init` is a reasonable order to do things in —
    // so a missing hooks directory is reported rather than thrown. The
    // workflows are the valuable half and they have already been written by
    // this point; failing here would abort a command that mostly succeeded.
    const installed = await installHook(root, { force, dryRun, version }).catch(
      (e: Error) => ({
        state: 'skipped' as const,
        detail: `not installed — ${e.message}`,
      }),
    )

    out.push({
      path: `${HOOK_NAME} (git hook)`,
      state: installed.state,
      detail: installed.detail,
    })
  }

  // **Files this config un-generated, which nothing else would ever mention.**
  // Reported always; removed only under `--force`, on the same reasoning as
  // every other file here — a generated workflow is meant to be edited, and one
  // that has been is not cutver's to delete on a whim. But left unsaid it is
  // worse than a stale file: publish.yml still fires on `push: tags: v*` and
  // still runs a publish for a repository whose config says a tag produces
  // nothing.
  for (const path of obsoleteFiles(eco, effective)) {
    if (!(await exists(`${root}/${path}`))) continue

    if (force) {
      if (!dryRun) await remove(`${root}/${path}`)
      out.push({
        path,
        state: 'written',
        detail: 'removed — this config publishes nothing',
      })
    } else {
      out.push({
        path,
        state: 'stale',
        detail:
          'still here, still triggered on v* — this config publishes nothing.' +
          ' --force removes it',
      })
    }
  }

  return out
}
