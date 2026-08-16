/**
 * The corner of `Bun.Glob` this CLI uses, on `node:fs`.
 *
 * **Not a glob library, and it should not become one.** Exactly two callers
 * exist, both adapters, and both build the same shape: a workspace pattern from
 * a manifest with a literal filename stuck on the end — `packages/*​/package.json`,
 * `crates/*​/Cargo.toml`, sometimes `**​/package.json`. That is the whole
 * requirement, and matching it takes a directory walk rather than a dependency.
 *
 * `fs.glob` exists in Node 22 and would do, but it arrived experimental and
 * prints a warning on some versions — a release tool that emits
 * `ExperimentalWarning` into a CI log is answering a question nobody asked.
 */
import { promises as fsp } from 'node:fs'

/**
 * One path segment as a regular expression.
 *
 * `*` stops at a separator and `?` is a single character, which is what every
 * glob means by them. Everything else is escaped: a workspace named `app.v2`
 * has a dot in it, and an unescaped dot matches `appxv2` too.
 */
function segmentRe(segment: string): RegExp {
  const source = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${source}$`)
}

/**
 * A whole glob as one regular expression, for matching a string.
 *
 * **`**` crosses `/` and `*` does not**, which is the rule `Bun.Glob` and
 * GitHub Actions both follow — and the reason config globs are handed to
 * `on.push.branches` verbatim instead of being translated. A translation would
 * be a second place to be wrong about `release/*`.
 *
 * `**` is consumed before `*` can see it, and the trailing `/` of `**​/` is
 * made optional so `docs/**` matches `docs` itself, as both do.
 */
function patternRe(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
        continue
      }
      source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** Whether `name` matches `pattern`. No filesystem is touched. */
export function globMatch(pattern: string, name: string): boolean {
  return patternRe(pattern).test(name)
}

async function entries(dir: string) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    // A directory that cannot be listed contributes no matches. Unreadable
    // paths are common enough in a real tree — permissions, a broken symlink,
    // a race with something else — and none of them is worth failing a release.
    return []
  }
}

/**
 * Files under `cwd` matching `pattern`.
 *
 * Returns paths relative to `cwd`, separator-normalised to `/` so callers on
 * Windows and Linux compare the same strings — which is what `Bun.Glob` does,
 * and what the adapters' `replaceAll('\\', '/')` was already assuming.
 *
 * Symlinks are not followed, matching the `followSymlinks: false` both callers
 * pass: a workspace that symlinks a sibling should not have that sibling's
 * manifest bumped twice under two names.
 */
export async function globFiles(
  pattern: string,
  cwd: string,
): Promise<string[]> {
  const segments = pattern.split('/').filter(Boolean)
  const found: string[] = []

  /**
   * @param dir   absolute directory being listed
   * @param rel   its path relative to `cwd`, `/`-separated
   * @param index which pattern segment applies here
   */
  async function walk(dir: string, rel: string, index: number): Promise<void> {
    const segment = segments[index]
    if (segment === undefined) return
    const last = index === segments.length - 1

    // `**` matches any number of directories, including none — so the rest of
    // the pattern is tried right here as well as under every subdirectory.
    // Without the "including none" case, `**​/package.json` misses the one in
    // the root, which is the manifest most likely to exist.
    if (segment === '**') {
      await walk(dir, rel, index + 1)
      for (const entry of await entries(dir)) {
        if (!entry.isDirectory()) continue
        await walk(
          `${dir}/${entry.name}`,
          rel ? `${rel}/${entry.name}` : entry.name,
          index,
        )
      }
      return
    }

    const re = segmentRe(segment)
    for (const entry of await entries(dir)) {
      if (!re.test(entry.name)) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name

      if (last) {
        // `onlyFiles`. A directory named `package.json` is not a manifest.
        if (entry.isFile()) found.push(path)
        continue
      }
      if (entry.isDirectory())
        await walk(`${dir}/${entry.name}`, path, index + 1)
    }
  }

  await walk(cwd.replaceAll('\\', '/').replace(/\/$/, ''), '', 0)

  // A `**` pattern can reach the same file by more than one route — matching
  // zero directories at one level and one at the next — so the same manifest
  // would be bumped twice.
  return [...new Set(found)]
}
