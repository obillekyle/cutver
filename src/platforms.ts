/**
 * Which runners in the generated matrix are going to need a setup step.
 *
 * **The problem this exists for cost two release runs on a public tag.** The
 * generated cargo artifact job starts with three runners, and cutver has no way
 * to know whether a workspace can be built on all three: the thing that stops
 * it is a *system* library, and system libraries are not in any manifest.
 * `fuser` needs `libfuse`, `winfsp-sys` reads a Windows registry key — neither
 * appears as a dependency anybody can read.
 *
 * What *is* readable is how a crate goes looking. A build script that searches
 * for something already installed pulls in a helper to do the searching, and
 * that helper is an ordinary build-dependency in the graph. So the question
 * "will this row build" becomes "does anything on this row's graph search for a
 * preinstalled library", which `cargo metadata --filter-platform` answers
 * without compiling a line.
 *
 * **It reports what a crate looks for, never what a runner lacks**, and that
 * distinction is the whole accuracy story. Run against alloyfs it names all
 * three rows; the Linux one builds fine, because the ubuntu image already ships
 * libfuse. Over-reporting is the right side to err on here — the cost of a
 * false positive is reading a line, and the cost of a miss is a release that
 * fails after the tag is public.
 *
 * A crate that finds its library some way nobody can read from the graph is
 * still invisible. `winfsp-sys` looked like exactly that case — it reads a
 * Windows registry key — but it is caught anyway, because it uses `bindgen`
 * and so needs libclang regardless. That was luck rather than design, and the
 * design should not be described as if it were coverage.
 *
 * It never refuses. The output is a note beside files that were written.
 */
import { run } from './run'

/**
 * Build-dependencies whose whole job is locating a library that is expected to
 * be installed already.
 *
 * `cc` is deliberately absent, and it is the one people expect to see. It is
 * everywhere and almost always compiles vendored C that ships inside the crate,
 * needing nothing on the machine — flagging it would put a warning on half the
 * ecosystem and teach everyone to ignore this.
 */
export const SEARCHERS: Record<string, string> = {
  'pkg-config': 'searches for an installed library via pkg-config',
  'system-deps': 'searches for installed libraries via system-deps',
  vcpkg: 'searches for an installed library via vcpkg',
  bindgen: 'needs libclang at build time',
}

export interface SystemDep {
  /** The crate that does the searching. */
  crate: string
  /** Why it was flagged, in words that belong in a message. */
  why: string
}

/**
 * Crates on this platform's graph that look for something preinstalled.
 *
 * Pure, and takes the parsed `cargo metadata` document, so the awkward cases
 * are testable without a Rust toolchain or a network.
 */
export function systemDeps(metadata: unknown): SystemDep[] {
  const doc = metadata as { packages?: unknown }
  if (!Array.isArray(doc?.packages)) return []

  const found = new Map<string, SystemDep>()

  for (const pkg of doc.packages as Record<string, unknown>[]) {
    const name = typeof pkg.name === 'string' ? pkg.name : null
    if (!name || !Array.isArray(pkg.dependencies)) continue

    for (const dep of pkg.dependencies as Record<string, unknown>[]) {
      if (dep.kind !== 'build') continue
      const via = typeof dep.name === 'string' ? SEARCHERS[dep.name] : undefined
      if (!via) continue
      // Keyed by the crate doing the searching, not by the searcher: a
      // workspace with four crates all using pkg-config is one problem to
      // solve per crate, and naming them all is what makes it actionable.
      found.set(name, { crate: name, why: via })
    }
  }

  return [...found.values()].sort((a, b) => a.crate.localeCompare(b.crate))
}

export interface PlatformNote {
  target: string
  deps: SystemDep[]
}

/**
 * Resolve the dependency graph for one target and report what it will need.
 *
 * `--filter-platform` resolves *for* a platform without building for it, so
 * this answers the macOS question from a Windows laptop in seconds.
 *
 * Returns `null` rather than throwing when cargo is missing, offline, or
 * unhappy for any other reason. This runs inside `init`, whose job is writing
 * files; a probe that could fail the command it decorates would be a worse
 * trade than the warning is worth.
 */
export async function probeTarget(
  root: string,
  target: string,
): Promise<PlatformNote | null> {
  const { ok, out } = await run(
    ['cargo', 'metadata', '--format-version', '1', '--filter-platform', target],
    root,
  )
  if (!ok || !out) return null

  try {
    return { target, deps: systemDeps(JSON.parse(out)) }
  } catch {
    return null
  }
}

/** Every target at once — three cargo invocations that do not wait on each other. */
export async function probeTargets(
  root: string,
  targets: readonly string[],
): Promise<PlatformNote[]> {
  const notes = await Promise.all(targets.map(t => probeTarget(root, t)))
  return notes.filter((n): n is PlatformNote => n !== null && n.deps.length > 0)
}

/** The advice, as lines. Empty when there is nothing worth saying. */
export function platformAdvice(notes: PlatformNote[]): string[] {
  if (!notes.length) return []

  const lines = [
    '',
    '  the matrix in publish.yml starts with three runners, and:',
  ]
  for (const note of notes) {
    for (const dep of note.deps) {
      lines.push(`    ${note.target}`)
      lines.push(`      ${dep.crate} ${dep.why}`)
    }
  }
  lines.push(
    '',
    '  This is what they look for, not what a runner is missing — the ubuntu',
    '  image already ships many of them. Check the rows above before the first',
    '  tag: one that cannot build fails the whole release, because the job that',
    '  attaches the binaries waits on all of them.',
  )
  return lines
}
