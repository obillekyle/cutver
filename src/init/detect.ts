/**
 * What this repository already is, before `init` writes anything into it.
 *
 * **Two questions, and getting either wrong writes a file that cannot work.**
 * Which ecosystem's manifest to bump, and whose CI this is. Both were answered
 * by assumption until 2.0: the ecosystem had to be typed out every time, and
 * the CI provider was never asked at all — `init` wrote GitHub Actions
 * workflows into a GitLab repository as readily as into a GitHub one, where
 * they sit in a directory nothing reads.
 */
import { exists, readText } from '../runtime'

/** The CI systems worth telling apart, and the file that gives each away. */
const CI_MARKERS = [
  { id: 'github', name: 'GitHub Actions', path: '.github/workflows' },
  { id: 'gitlab', name: 'GitLab CI', path: '.gitlab-ci.yml' },
  { id: 'circleci', name: 'CircleCI', path: '.circleci/config.yml' },
  { id: 'azure', name: 'Azure Pipelines', path: 'azure-pipelines.yml' },
  { id: 'woodpecker', name: 'Woodpecker', path: '.woodpecker.yml' },
  { id: 'jenkins', name: 'Jenkins', path: 'Jenkinsfile' },
] as const

export type CiProvider = (typeof CI_MARKERS)[number]['id']

/** What was found, and what to call it in a message. */
export interface Ci {
  id: CiProvider
  name: string
  /** The file or directory that gave it away, for saying *why* it was decided. */
  path: string
}

/**
 * The CI provider this repository uses, or `null` for a tree with none.
 *
 * **GitHub wins when several are present**, and that is not arbitrary: it is
 * the one cutver can actually generate for, and a repository carrying both a
 * `.github/workflows` and a `.gitlab-ci.yml` is usually mirrored rather than
 * undecided. Refusing there would block the case that works.
 *
 * `null` means nothing was found, which is the ordinary state of a fresh
 * repository and not a problem — it is the reason `init` exists.
 */
export async function detectCi(root: string): Promise<Ci | null> {
  for (const marker of CI_MARKERS) {
    // A directory is not a file, and `exists(dir)` answers false for
    // one. `.github/workflows` is the marker that matters most, so it is probed
    // through its stat rather than through the file API.
    const found = await exists(`${root}/${marker.path}`).catch(() => false)

    if (found || (await isDirectory(`${root}/${marker.path}`))) {
      return { id: marker.id, name: marker.name, path: marker.path }
    }
  }
  return null
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises')
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** What `init` writes for, when nobody said. */
export type Detected = 'cargo' | 'node' | 'bun'

/**
 * The ecosystem, from the manifests that are there.
 *
 * `null` when it cannot be settled — no manifest at all, or both — because
 * those are the two cases where guessing bumps the wrong file. A repository
 * with a `Cargo.toml` *and* a `package.json` is common enough that the refusal
 * is the feature.
 *
 * **`bun` against `node` is decided by the lockfile**, since they share a
 * manifest and cutver's only interest in the difference is which runner the
 * generated workflow sets up. Absent a bun lockfile, `node` is the safer
 * answer: a Node runner installs a Bun project's dependencies, and a Bun runner
 * in a repository that has never seen Bun is a surprise in someone else's CI.
 */
export async function detectEcosystem(root: string): Promise<Detected | null> {
  const [cargo, npm] = await Promise.all([
    exists(`${root}/Cargo.toml`),
    exists(`${root}/package.json`),
  ])

  if (cargo && npm) return null
  if (cargo) return 'cargo'
  if (!npm) return null

  const [lockb, lock] = await Promise.all([
    exists(`${root}/bun.lockb`),
    exists(`${root}/bun.lock`),
  ])
  return lockb || lock ? 'bun' : 'node'
}

/**
 * Whether a tag here should reach a registry, from what the manifest already
 * says.
 *
 * **`private: true` is npm's own refusal to publish, and cutver already trusts
 * it everywhere except the one place it decides anything.** `adapters/js.ts`
 * uses it to skip the registry lookup, to leave a package's version alone, and
 * to answer what would reach the registry at all. `init` never read it — so an
 * application scaffolded `publish: true` and got a `publish.yml` carrying
 * `id-token: write` and an `npm publish` that npm would refuse. `doctor` then
 * said nothing was wrong, because the package it would have checked had been
 * filtered out for being private.
 *
 * Cargo has scaffolded the careful way since 2.0 — `config/schema.ts` makes the
 * argument, that a Rust workspace is more often an application than a library.
 * This is that argument applied where the manifest states the answer outright
 * rather than leaving it to a base rate.
 *
 * Absent or unreadable, the answer is `true`: that is the behaviour every
 * release before this had, and a missing manifest is not evidence of intent.
 */
export async function detectPublishes(root: string): Promise<boolean> {
  try {
    const raw = await readText(`${root}/package.json`)
    return (JSON.parse(raw) as { private?: boolean }).private !== true
  } catch {
    // Missing, or a manifest that will not parse. Neither is this function's to
    // report — `stage` and `doctor` both say so in terms — and neither is
    // evidence of intent, so the long-standing default stands.
    return true
  }
}
