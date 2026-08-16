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
import { exists } from '../runtime'

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
