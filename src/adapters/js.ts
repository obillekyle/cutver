/**
 * npm: the root `package.json`, every workspace package, and `bun.lock`.
 *
 * The third one is the part that is easy to leave out and expensive to leave
 * out — see `syncLock` below.
 */
import { detectEol, detectIndent, withEol } from '../text'
import type { Target } from '../registry'
import { AdapterError, type Adapter, type Change } from './types'
import { exists, glob, readText, write } from '../runtime'

interface Manifest {
  name?: string
  version?: string
  private?: boolean
  workspaces?: string[] | { packages?: string[] }
  /** `"o/c"` shorthand or `{ url }` — npm accepts both. */
  repository?: string | { url?: string }
}

function repositoryOf(json: Manifest): string | null {
  const repo = json.repository
  if (typeof repo === 'string') return repo
  return repo?.url ?? null
}

async function readManifest(
  path: string,
): Promise<{ json: Manifest; text: string }> {
  const text = await readText(path)
  try {
    return { json: JSON.parse(text) as Manifest, text }
  } catch (e) {
    throw new AdapterError(`${path} is not valid JSON: ${(e as Error).message}`)
  }
}

/**
 * Write a manifest back with its own indentation and line endings.
 *
 * `JSON.stringify(json, null, 2)` is what the original did, and it is fine in a
 * repository whose manifests are already two-space LF. Pointed at someone
 * else's tab-indented, CRLF `package.json` it produces a version bump whose
 * diff is the entire file.
 */
async function writeManifest(
  path: string,
  json: Manifest,
  original: string,
): Promise<void> {
  const body = JSON.stringify(json, null, detectIndent(original))
  const trailing = /\n$/.test(original) ? '\n' : ''
  await write(path, withEol(body + trailing, detectEol(original)))
}

/**
 * Add a devDependency, if the manifest does not already mention it.
 *
 * Used by `cutver init` to pin cutver itself. **Never overwrites an existing
 * declaration**, in either dependency block: a range already in there is a
 * decision somebody made, and a setup command silently changing which version
 * of the release tool runs is the exact class of surprise this whole project
 * is written against.
 *
 * Returns what happened, so the caller can say `bun install` out loud —
 * without it the manifest and the lockfile disagree, and the next CI run dies
 * on `--frozen-lockfile`.
 */
export async function addDevDependency(
  root: string,
  name: string,
  range: string,
  dryRun = false,
): Promise<'added' | 'present'> {
  const path = `${root}/package.json`
  const { json, text } = await readManifest(path)
  const manifest = json as Manifest & Record<string, unknown>

  for (const block of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
  ] as const) {
    const deps = manifest[block] as Record<string, string> | undefined
    if (deps && name in deps) return 'present'
  }

  const devDependencies = {
    ...((manifest.devDependencies as Record<string, string>) ?? {}),
  }
  devDependencies[name] = range
  // Sorted, because that is what every package manager rewrites it to anyway,
  // and an unsorted insert shows up as a spurious diff on the next install.
  manifest.devDependencies = Object.fromEntries(
    Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b)),
  )

  if (!dryRun) await writeManifest(path, manifest, text)
  return 'added'
}

function patterns(root: Manifest): string[] {
  const ws = root.workspaces
  if (Array.isArray(ws)) return ws
  if (ws && Array.isArray(ws.packages)) return ws.packages
  return []
}

/**
 * Workspace directories that hold a `package.json`, repo-relative and sorted.
 *
 * Sorted because the output is read by a person deciding whether to commit,
 * and glob order is neither stable across platforms nor meaningful anywhere.
 */
export async function workspaceDirs(root: string): Promise<string[]> {
  const { json } = await readManifest(`${root}/package.json`)
  const found = new Set<string>()

  for (const pattern of patterns(json)) {
    const hits = await glob(`${pattern.replace(/\/+$/, '')}/package.json`, root)
    for (const rel of hits) {
      // A `**` pattern will happily walk into an installed dependency, and a
      // vendored copy of some package is not this repository's to version.
      if (rel.split('/').includes('node_modules')) continue
      found.add(rel.replace(/\/package\.json$/, ''))
    }
  }

  return [...found].sort()
}

/**
 * Carry the same version into `bun.lock`'s workspace entries.
 *
 * **This is what makes the published dependency ranges correct, and it shipped
 * broken.** `bun pm pack` expands `workspace:^` using the version recorded in
 * the *lockfile*, not the one in the sibling manifest — and CI installs with
 * `--frozen-lockfile`, so the lock still said 1.2.3 long after every manifest
 * said 2.0.0-alpha.2. All seven 2.0.0-alpha packages went to npm declaring
 * `@bakery-framework/core@^1.2.3`, so installing the alpha channel resolved a
 * *stable* core: the one version the alpha plugins cannot run against, and
 * (1.2.3 being the barrel-cycle release) one that cannot even be imported.
 *
 * Rewritten in place rather than regenerated. `bun install` alone will not do
 * it — bun rewrites the lock when the dependency *graph* changes and a version
 * bump is not a graph change — and deleting the lock first, which does work,
 * re-resolves every external dependency *after* the gates have already run,
 * publishing a tree that nothing tested. Only these lines may move, so only
 * these lines are touched.
 *
 * The missing-entry case is fatal rather than skipped. A workspace package with
 * no lock entry means the lockfile predates it, which is the same stale-lock
 * condition in a form that would otherwise pass silently.
 */
async function syncLock(
  root: string,
  dirs: string[],
  version: string,
  dryRun: boolean,
  /** Deferred writes. See `setVersion` — nothing is written until all of it parses. */
  pending: (() => Promise<void>)[],
): Promise<Change> {
  const path = `${root}/bun.lock`
  const lock = await readText(path).catch(() => '')

  if (!lock) {
    // A checkout that has never installed. Nothing to keep in sync, and the
    // next install writes the current versions anyway.
    return {
      file: 'bun.lock',
      state: 'absent',
      detail: 'no lockfile, nothing to sync',
    }
  }

  let patched = lock
  const stale: string[] = []

  for (const dir of dirs) {
    // Anchored to the workspace key so this cannot wander into the
    // `"packages"` section below, where a same-named entry would be a
    // resolved npm tarball rather than the local directory.
    const re = new RegExp(
      `("${dir}":\\s*\\{\\s*"name":\\s*"[^"]+",\\s*"version":\\s*")([^"]+)(")`,
    )
    const found = patched.match(re)
    if (!found)
      throw new AdapterError(`bun.lock has no workspace entry for ${dir}`)
    if (found[2] === version) continue
    stale.push(dir)
    patched = patched.replace(re, `$1${version}$3`)
  }

  if (!stale.length) {
    return {
      file: 'bun.lock',
      state: 'unchanged',
      detail: `already at ${version}`,
    }
  }

  if (!dryRun) pending.push(() => write(path, patched))
  return {
    file: 'bun.lock',
    state: 'updated',
    detail: `${stale.length} workspace ${stale.length === 1 ? 'entry' : 'entries'}`,
  }
}

/**
 * Lockfiles cutver does not maintain, reported rather than ignored.
 *
 * npm and pnpm record workspace versions too, and the bun.lock bug above is
 * exactly the shape of thing that would recur in them. Rewriting three
 * lockfile formats in place is not a promise worth making, so the honest move
 * is to name the file and say who has to deal with it.
 */
async function foreignLocks(root: string): Promise<Change[]> {
  const out: Change[] = []
  for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    if (await exists(`${root}/${name}`)) {
      out.push({
        file: name,
        state: 'unchanged',
        detail: 'not maintained by cutver — reinstall to refresh it',
      })
    }
  }
  return out
}

export const jsAdapter: Adapter = {
  id: 'js',
  registry: 'npm',
  manifest: 'package.json',

  async readVersion(root) {
    const { json } = await readManifest(`${root}/package.json`)
    if (typeof json.version !== 'string' || !json.version) {
      throw new AdapterError('package.json has no "version" field')
    }
    return json.version
  },

  async publishTargets(root) {
    const targets: Target[] = []

    // The root counts too, and is checked first. A single-package repository
    // has no `workspaces` at all and would otherwise report nothing to
    // publish — which is the shape cutver itself ships in.
    for (const dir of ['.', ...(await workspaceDirs(root))]) {
      const rel = dir === '.' ? 'package.json' : `${dir}/package.json`
      const { json } = await readManifest(`${root}/${rel}`)
      // `private: true` is npm's own refusal to publish. Asking the registry
      // about a package that can never reach it would report every private
      // workspace as an unpublished first release.
      if (json.private || !json.name) continue
      targets.push({
        name: json.name,
        dir,
        registry: 'npm',
        repository: repositoryOf(json),
      })
    }

    return targets
  },

  async setVersion({ root, version, dryRun }) {
    const changes: Change[] = []
    const bumped: string[] = []

    // **Nothing is written until everything has been read and checked.**
    //
    // This used to write each manifest as it went, and the check that fires
    // last is the one most likely to fire: `syncLock` refuses a lockfile with
    // no entry for a workspace package, which is what a repository looks like
    // when somebody added a package and has not re-run their install. By then
    // every manifest was already rewritten — six files bumped, the lockfile
    // untouched, exit 1, and a tree nobody asked for.
    //
    // Deferring the writes moves every read, every JSON parse and that refusal
    // in front of the first byte. It is not atomicity: a failure *during* the
    // flush still leaves part of it written, and closing that needs
    // temp-and-rename in the runtime layer. It closes the window that actually
    // opens.
    const pending: (() => Promise<void>)[] = []

    for (const dir of await workspaceDirs(root)) {
      const rel = `${dir}/package.json`
      const { json, text } = await readManifest(`${root}/${rel}`)

      // Private packages are the example apps and the fixtures. They are not
      // published, nobody resolves a range against them, and dragging them
      // along makes the diff of a release larger than the release.
      if (json.private) {
        changes.push({
          file: rel,
          state: 'unchanged',
          detail: 'private — left alone',
        })
        continue
      }
      if (typeof json.version !== 'string') {
        changes.push({
          file: rel,
          state: 'unchanged',
          detail: 'no version field',
        })
        continue
      }

      bumped.push(dir)
      if (json.version === version) {
        changes.push({
          file: rel,
          state: 'unchanged',
          detail: `already ${version}`,
        })
        continue
      }

      const from = json.version
      json.version = version
      if (!dryRun)
        pending.push(() => writeManifest(`${root}/${rel}`, json, text))
      changes.push({
        file: rel,
        state: 'updated',
        detail: `${from} -> ${version}`,
      })
    }

    // The root last, and even when it is private: it is the version of record,
    // the number the tag is cut from, and letting it drift away from the
    // packages it contains is how a monorepo ends up with two answers.
    {
      const { json, text } = await readManifest(`${root}/package.json`)
      const from = json.version
      if (from === version) {
        changes.push({
          file: 'package.json',
          state: 'unchanged',
          detail: `already ${version}`,
        })
      } else {
        json.version = version
        if (!dryRun)
          pending.push(() => writeManifest(`${root}/package.json`, json, text))
        changes.push({
          file: 'package.json',
          state: 'updated',
          detail: `${from} -> ${version}`,
        })
      }
    }

    // Every workspace package gets its lock entry checked, not only the ones
    // whose manifest moved. The failure this guards against is precisely a
    // manifest that was already right and a lock that was not.
    if (bumped.length)
      changes.push(await syncLock(root, bumped, version, dryRun, pending))
    changes.push(...(await foreignLocks(root)))

    // Everything parsed and every refusal passed. Now write.
    for (const flush of pending) await flush()

    return changes
  },
}
