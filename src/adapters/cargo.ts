/**
 * Cargo: `[workspace.package] version` in `Cargo.toml`, then `Cargo.lock`.
 *
 * **Parsed with offsets and rewritten by splice, not re-serialised.** A TOML
 * round trip through any library reorders keys, normalises strings and drops
 * comments, and `Cargo.toml` is a file people write by hand and comment
 * heavily. The only edit a version bump is entitled to make is the seven-odd
 * characters between two quotes.
 *
 * **CRLF is expected, not tolerated grudgingly.** The repository this adapter
 * was written for is developed on Windows and its `Cargo.toml` is CRLF
 * throughout. Every pattern here therefore ends `[ \t]*\r?$` rather than
 * `[ \t]*$`, and — the part that actually bit — the version is read from
 * *between the quotes* rather than from the rest of the line, so a `\r` cannot
 * ride along on the value. A trailing `\r` in a parsed version had previously
 * been interpolated into a path there, and `alloyfs-0.1.0\r` is not a name
 * Windows will give a directory. `cargoVersion` is tested against a CRLF
 * fixture with that specific assertion.
 */
import { Glob } from 'bun'
import { run } from '../run'
import { AdapterError, type Adapter, type Change } from './types'

/** A `[section]` header on its own line. `[[array.of.tables]]` deliberately does not match. */
const HEADER = /^[ \t]*\[([^[\]\r\n]+)\][ \t]*\r?$/gm

/** `version = "1.2.3"`, with the value confined to what is inside the quotes. */
const VERSION = /^[ \t]*version[ \t]*=[ \t]*"([^"\r\n]*)"/m

export interface Located {
  /** The version string, quotes excluded — and therefore `\r` excluded. */
  value: string
  /** Offsets of the value within the whole document, for a splice. */
  start: number
  end: number
  /** Which table it was found in, for the error message when it is the wrong one. */
  section: string
}

/** Byte range of a named table's body: after its header line, up to the next header. */
function sectionBody(toml: string, name: string): { start: number; end: number } | null {
  HEADER.lastIndex = 0
  let start: number | null = null

  for (let m = HEADER.exec(toml); m; m = HEADER.exec(toml)) {
    if (start !== null) return { start, end: m.index }
    if (m[1]?.trim() === name) start = m.index + m[0].length
  }

  return start === null ? null : { start, end: toml.length }
}

/**
 * The workspace version and where it lives.
 *
 * `[workspace.package]` first, because that is where a workspace root keeps the
 * one version its members inherit with `version.workspace = true`. A plain
 * `[package]` is the fallback for a single-crate repository — the same tool
 * should work on one without a `[workspace]` table at all.
 */
export function cargoVersion(toml: string): Located | null {
  for (const section of ['workspace.package', 'package']) {
    const body = sectionBody(toml, section)
    if (!body) continue

    const slice = toml.slice(body.start, body.end)
    const m = VERSION.exec(slice)
    if (!m || m[1] === undefined) continue

    // The value starts one character past the opening quote of the match.
    const start = body.start + m.index + m[0].indexOf('"') + 1
    return { value: m[1], start, end: start + m[1].length, section }
  }

  return null
}

/** Replace the version in place, touching nothing else in the document. */
export function replaceCargoVersion(toml: string, at: Located, version: string): string {
  return toml.slice(0, at.start) + version + toml.slice(at.end)
}

/** Workspace member patterns from `[workspace] members = [...]`. */
export function members(toml: string): string[] {
  const body = sectionBody(toml, 'workspace')
  if (!body) return []

  const slice = toml.slice(body.start, body.end)
  const list = /^[ \t]*members[ \t]*=[ \t]*\[([^\]]*)\]/m.exec(slice)
  if (!list?.[1]) return []

  return [...list[1].matchAll(/"([^"]+)"/g)].map(m => m[1] as string)
}

const NAME = /^[ \t]*name[ \t]*=[ \t]*"([^"\r\n]*)"/m
const PUBLISH_FALSE = /^[ \t]*publish[ \t]*=[ \t]*false/m
/** Read between the quotes, like every other value here, so CRLF cannot ride along. */
const REPOSITORY = /^[ \t]*repository[ \t]*=[ \t]*"([^"\r\n]*)"/m

export interface Member {
  /** Repo-relative directory. */
  dir: string
  /** `[package] name`, when it has one. */
  name: string | null
  /** Pins a literal `version` in its own `[package]` rather than inheriting. */
  pinned: boolean
  /** `publish = false` — a member that exists only to be depended on or tested. */
  private: boolean
  /** Its own `repository`, when it does not inherit the workspace one. */
  repository: string | null
}

/**
 * Every workspace member, read once and reused.
 *
 * `members` may hold globs (`crates/*`), so the list is expanded against the
 * filesystem rather than trusted as paths. A single-crate repository has no
 * `[workspace]` table and yields nothing here; its root `[package]` is the
 * member, and callers handle that case explicitly.
 */
async function scanMembers(root: string, toml: string): Promise<Member[]> {
  const out: Member[] = []

  for (const pattern of members(toml)) {
    const glob = new Glob(`${pattern.replace(/\/+$/, '')}/Cargo.toml`)
    for await (const hit of glob.scan({ cwd: root, onlyFiles: true, followSymlinks: false })) {
      const rel = hit.replaceAll('\\', '/')
      // `target/` holds unpacked copies of dependencies' sources, each with a
      // real Cargo.toml. None of them are this workspace's to version.
      if (rel.split('/').includes('target')) continue

      const text = await Bun.file(`${root}/${rel}`).text()
      const body = sectionBody(text, 'package')
      if (!body) continue
      const section = text.slice(body.start, body.end)

      out.push({
        dir: rel.replace(/\/Cargo\.toml$/, ''),
        name: NAME.exec(section)?.[1] ?? null,
        pinned: VERSION.test(section),
        private: PUBLISH_FALSE.test(section),
        repository: REPOSITORY.exec(section)?.[1] ?? null,
      })
    }
  }

  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * Reconcile `Cargo.lock` with the manifest.
 *
 * `cargo update -w` and nothing broader. A bare `cargo update` re-resolves
 * every external dependency, which is the same mistake as deleting a lockfile
 * to refresh it: the tree that gets released is then not the tree the tests
 * ran against. `-w` only rewrites the workspace members' own entries, which is
 * precisely what a version bump invalidated.
 */
async function syncLock(root: string, dryRun: boolean): Promise<Change> {
  const exists = await Bun.file(`${root}/Cargo.lock`).exists()
  if (!exists) {
    return { file: 'Cargo.lock', state: 'absent', detail: 'no lockfile, nothing to reconcile' }
  }
  if (dryRun) {
    return { file: 'Cargo.lock', state: 'updated', detail: 'would run `cargo update -w`' }
  }

  const { ok, err } = await run(['cargo', 'update', '-w'], root)
  if (!ok) {
    // Not fatal, and deliberately so: the manifest is already written by this
    // point, and exiting here would leave a half-bumped tree with no advice.
    // The lockfile is one command away from correct, so say which command.
    return {
      file: 'Cargo.lock',
      state: 'unchanged',
      detail: `\`cargo update -w\` failed — run it by hand${err ? `: ${err.split('\n')[0]}` : ''}`,
    }
  }

  return { file: 'Cargo.lock', state: 'updated', detail: 'cargo update -w' }
}

export const cargoAdapter: Adapter = {
  id: 'cargo',
  registry: 'crates',
  manifest: 'Cargo.toml',

  async readVersion(root) {
    const toml = await Bun.file(`${root}/Cargo.toml`).text()
    const at = cargoVersion(toml)
    if (!at) {
      throw new AdapterError(
        'Cargo.toml declares no version under [workspace.package] or [package].\n' +
          '        A workspace root needs `[workspace.package] version = "…"`, with its\n' +
          '        members inheriting it via `version.workspace = true`.',
      )
    }
    return at.value
  },

  async publishTargets(root) {
    const toml = await Bun.file(`${root}/Cargo.toml`).text()
    const found = await scanMembers(root, toml)

    // A member usually inherits `repository.workspace = true`, so the
    // workspace table is the one that answers for all of them.
    const wsBody = sectionBody(toml, 'workspace.package')
    const workspaceRepo = wsBody ? (REPOSITORY.exec(toml.slice(wsBody.start, wsBody.end))?.[1] ?? null) : null

    // No `[workspace] members` at all: a single-crate repository, whose root
    // `[package]` is the thing that gets published.
    if (!found.length) {
      const body = sectionBody(toml, 'package')
      const section = body ? toml.slice(body.start, body.end) : ''
      const name = body ? NAME.exec(section)?.[1] : null
      const isPrivate = body ? PUBLISH_FALSE.test(section) : true
      const repository = REPOSITORY.exec(section)?.[1] ?? workspaceRepo ?? null
      return name && !isPrivate
        ? [{ name, dir: '.', registry: 'crates' as const, repository }]
        : []
    }

    return found
      .filter(m => m.name && !m.private)
      .map(m => ({
        name: m.name as string,
        dir: m.dir,
        registry: 'crates' as const,
        repository: m.repository ?? workspaceRepo,
      }))
  },

  async setVersion({ root, version, dryRun }) {
    const path = `${root}/Cargo.toml`
    const toml = await Bun.file(path).text()
    const at = cargoVersion(toml)
    if (!at) throw new AdapterError('Cargo.toml declares no version to replace')

    const changes: Change[] = []

    if (at.value === version) {
      changes.push({ file: 'Cargo.toml', state: 'unchanged', detail: `already ${version}` })
    } else {
      if (!dryRun) await Bun.write(path, replaceCargoVersion(toml, at, version))
      changes.push({
        file: 'Cargo.toml',
        state: 'updated',
        detail: `[${at.section}] ${at.value} -> ${version}`,
      })
    }

    // Members that pin their own version are reported, never rewritten. A
    // crate that says `version = "0.3.1"` in its own `[package]` has opted out
    // of lockstep on purpose, and quietly dragging it to the workspace number
    // would be the tool overruling a decision it cannot see the reason for.
    // Saying so is the useful half — this is the cargo-shaped version of a
    // manifest silently left behind, which is how the npm lockfile bug ran for
    // seven releases.
    for (const member of await scanMembers(root, toml)) {
      if (!member.pinned) continue
      changes.push({
        file: `${member.dir}/Cargo.toml`,
        state: 'unchanged',
        detail: 'pins its own version — left alone',
      })
    }

    changes.push(await syncLock(root, dryRun))
    return changes
  },
}
