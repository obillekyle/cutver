/**
 * Ask a registry what it already has, and ask the environment how it intends
 * to authenticate — **before** anything is written.
 *
 * Both questions exist because of the same failure, which is not recoverable
 * once you are in it: **npm trusted publishing cannot perform a package's
 * first publish.** There is nowhere for npm to attach a trusted publisher
 * until the package exists, so release one has to go out by hand with a local
 * token. A pipeline that does not know this bumps every manifest, commits,
 * tags, and then 403s at the last step — leaving a tag that promises a version
 * nobody can install, and a version number that can never be reused.
 *
 * Finding out costs one HTTP GET per package, before the first byte is
 * written. That is the whole argument for doing it here.
 */

export type Registry = 'npm' | 'crates'

export interface Target {
  /** The name the registry knows it by — `@scope/pkg`, `alloyfs-cli`. */
  name: string
  /** Repo-relative directory holding its manifest. */
  dir: string
  registry: Registry
  /** Whatever the manifest declares as its repository, unnormalised. */
  repository: string | null
}

/**
 * Reduce the many spellings of one repository URL to a comparable form.
 *
 * `git+https://github.com/o/c.git`, `git@github.com:o/c.git`,
 * `https://github.com/o/c` and `github:o/c` are the same repository, and npm
 * compares them after its own normalisation. Anything unrecognised is returned
 * lowercased rather than discarded — two odd URLs that match each other are
 * still a match, and refusing to compare would be worse than comparing badly.
 */
export function normaliseRepo(url: string | null | undefined): string | null {
  if (!url) return null
  return url
    .trim()
    .replace(/^git\+/, '')
    .replace(/^github:/, 'github.com/')
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?=[^/])/, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Does the manifest name the repository the release is being built from?
 *
 * **This is a publish-time requirement that only exists under trusted
 * publishing.** A provenance statement attests which repository produced the
 * tarball, so npm refuses one whose manifest disagrees — or, since it
 * normalises a missing field to the empty string, one that says nothing at
 * all. cutver hit it on its own first automated release: OIDC token minted,
 * tarball built, provenance signed and written to the transparency log, then
 * `422 … "repository.url" is ""`. The release before it went out by hand with
 * a token and sailed straight past.
 *
 * **Reported, never written.** cutver could derive the field from
 * `git remote get-url origin`, and on a fork that writes the fork's URL — which
 * passes this check locally and fails identically upstream. A wrong answer
 * written into someone's manifest is harder to notice than a missing one, and
 * a version tool editing unrelated metadata is not a thing to do quietly.
 */
export function repositoryMatches(declared: string | null, remote: string | null): boolean {
  const a = normaliseRepo(declared)
  const b = normaliseRepo(remote)
  // No remote to compare against: nothing to disagree with, so nothing to say.
  return !b || a === b
}

export interface Presence {
  target: Target
  /** `true` published, `false` never published, `null` the registry did not answer. */
  published: boolean | null
  /** Latest version the registry reports, when it answered. */
  latest?: string
  /** Why the answer is `null`. */
  error?: string
}

const TIMEOUT_MS = 8000

function url(target: Target): string {
  return target.registry === 'npm'
    ? // `@scope/pkg` -> `@scope%2Fpkg`: the slash is part of the name, not the path.
      `https://registry.npmjs.org/${target.name.replace('/', '%2F')}`
    : `https://crates.io/api/v1/crates/${target.name}`
}

async function probe(target: Target): Promise<Presence> {
  try {
    const res = await fetch(url(target), {
      // crates.io rejects a request with no User-Agent outright, and npm's
      // registry is friendlier to one. Naming the tool also means the traffic
      // is identifiable if it ever needs to be.
      headers: { 'user-agent': 'cutver (https://www.npmjs.com/package/cutver)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (res.status === 404) return { target, published: false }
    if (!res.ok) {
      return { target, published: null, error: `HTTP ${res.status}` }
    }

    const body = (await res.json()) as {
      'dist-tags'?: { latest?: string }
      crate?: { max_version?: string }
    }
    const latest =
      target.registry === 'npm' ? body['dist-tags']?.latest : body.crate?.max_version

    return latest ? { target, published: true, latest } : { target, published: true }
  } catch (e) {
    // Offline, DNS down, corporate proxy, timeout. **Never fatal** — a release
    // that cannot be cut because a laptop is on a train is a worse failure than
    // the one this check is trying to prevent, and `--offline` says so out loud.
    return { target, published: null, error: (e as Error).message }
  }
}

export async function checkRegistry(targets: Target[]): Promise<Presence[]> {
  return Promise.all(targets.map(probe))
}

export interface OidcStatus {
  /** Can this process mint an OIDC token right now? */
  available: boolean
  /** In CI at all? Distinguishes "no OIDC here" from "OIDC misconfigured". */
  ci: boolean
  detail: string
}

/**
 * Whether trusted publishing (OIDC) is actually available to this process.
 *
 * The middle case is the one worth detecting. A workflow that omits
 * `permissions: id-token: write` still runs, still installs, still packs, and
 * then fails at `npm publish` with an error about credentials rather than
 * about permissions — so the natural next move is to go looking for a missing
 * token, which is exactly the thing trusted publishing exists to not have.
 */
export function detectOidc(env: Record<string, string | undefined> = process.env): OidcStatus {
  const ci = env.GITHUB_ACTIONS === 'true'
  const endpoint = env.ACTIONS_ID_TOKEN_REQUEST_URL
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN

  if (endpoint && token) {
    return {
      available: true,
      ci: true,
      detail: 'GitHub Actions OIDC available — trusted publishing can authenticate',
    }
  }

  if (ci) {
    return {
      available: false,
      ci: true,
      detail:
        'in GitHub Actions but no OIDC token endpoint — the job is missing `permissions: id-token: write`',
    }
  }

  return {
    available: false,
    ci: false,
    detail: 'not in CI — publishing will use whatever credential npm finds locally',
  }
}
