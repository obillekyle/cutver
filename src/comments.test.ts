import { expect, test, describe } from 'bun:test'
import { readdirSync, readFileSync, existsSync } from 'node:fs'

/**
 * The comments, held to the code the way `docs.test.ts` holds the docs.
 *
 * **This repository is 38% comment by line and nothing checked a word of it.**
 * `docs.test.ts` fails the build if the reference page names a flag the CLI
 * does not have, or misses one it does — in both directions, across every page.
 * The 3,900 comment lines in `src/` had no equivalent, which made them the
 * largest unverified prose surface here and the one most likely to be believed,
 * because a comment sits next to the code it is describing.
 *
 * The failure mode is not comments that are wrong about behaviour — those are
 * rare and this cannot catch them. It is comments left behind by a rename.
 * Found on the first run, all five from refactors that updated the code and not
 * the paragraph:
 *
 *   - `HELP` renders it            — became `help(version)`
 *   - described in `init.ts`       — became `init/index.ts`
 *   - `Bun.write` does not set…    — became the `node:fs` wrapper
 *   - the parity test in `runtime.test.ts` — is `runtime/index.test.ts`
 *   - kept out of `cli/release.ts` — landed as `cli/stage.ts`
 *
 * and one worse than a rename: `inspect`'s docblock said "both real callers
 * already hold the resolved id", when one of the two was still dropping it —
 * prose asserting a fix that had half landed.
 *
 * **Backticked names only.** A comment is prose and most of it cannot be
 * checked; the backticks are the author saying "this is a name, not a word",
 * which is exactly the part that can be. Anything a reader could paste — a
 * symbol, a file — has to resolve to something.
 */

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * Names that are real but live outside this repository.
 *
 * **Every entry needs a reason, because the allowlist is how this test dies.**
 * A list that grows whenever something fails stops being a check and becomes a
 * record of what was easier to ignore. The bar: it must be a name a reader can
 * look up somewhere, just not here.
 */
const EXTERNAL = new Set([
  // Manifests and configs cutver reads or writes in *other* repositories. They
  // are named constantly here and none of them is a file in this tree.
  'Cargo.toml',
  'Cargo.lock',
  'cutver.json',
  // Node, Bun and JavaScript itself.
  'ExperimentalWarning',
  'toLocaleDateString', // named to say it is deliberately *not* used
  // git, GitHub and registry vocabulary.
  'versionsort.suffix',
  'target_commitish',
  'Latest', // the badge GitHub puts on a release
  'v1beta2/interactions', // a Gemini endpoint path
  'eval', // the shell builtin, in a note about redirecting completions
  // Other people's crates, from the repositories the rules were measured on.
  'libfuse',
  'winfsp-sys',
  // Files in the bakery repository, which `version-from-commits.ts` is a
  // verbatim port from. Its header says so in the first paragraph.
  'release.ts',
  'template.ts',
  'prompt.ts',
  // Words and formats quoted as examples rather than referenced as code.
  'domain', // "`main` is a substring of `domain`"
  'base-channel.n',
  'rc-9',
  'h-t-t-p-server',
  'owner/repo',
  // Named in the past tense, as the thing that used to be there.
  'HELP',
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

interface Ref {
  file: string
  line: number
  id: string
}

/**
 * Split every `.ts` file into the code and the names its comments mention.
 *
 * One pass, because the code half is what the names are checked against and
 * reading it twice would let them disagree.
 */
function scan(): { code: string; refs: Ref[] } {
  const refs: Ref[] = []
  let code = ''

  for (const file of walk(`${ROOT}/src`)) {
    // **This file is excluded from its own check**, and it has to be: the
    // docblock above lists the stale names that motivated it, so scanning it
    // would report every one of them as still broken.
    if (!file.endsWith('.ts') || file.endsWith('comments.test.ts')) continue
    let block = false

    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((raw, i) => {
        const l = raw.trim()
        let comment = false

        if (block) {
          comment = true
          if (l.includes('*/')) block = false
        } else if (l.startsWith('/*')) {
          comment = true
          if (!l.includes('*/')) block = true
        } else if (l.startsWith('//') || l.startsWith('*')) {
          comment = true
        }

        if (!comment) {
          code += `${raw}\n`
          return
        }
        for (const m of raw.matchAll(/`([A-Za-z_$][A-Za-z0-9_$./-]*)`/g)) {
          const id = m[1] as string
          // `$TAG`, `$schema` — a shell or JSON-schema variable, not a name in
          // this codebase. And `c3f6866` — a commit sha quoted as evidence.
          if (id.includes('$') || /^[0-9a-f]{7,40}$/.test(id)) continue
          refs.push({ file: file.slice(ROOT.length), line: i + 1, id })
        }
      })
  }
  return { code, refs }
}

const PATHISH = /\.(ts|md|json|yml|yaml|lock|toml)$/

describe('what the comments name', () => {
  test('every backticked name in src/ resolves to something', () => {
    const { code, refs } = scan()
    // The whole repository, not just `src/`: a comment may fairly name
    // `publish.yml`, which lives under `.github/workflows`, or a docs page.
    const paths = ['src', 'docs', '.github', 'scripts']
      .filter(d => existsSync(`${ROOT}/${d}`))
      .flatMap(d => walk(`${ROOT}/${d}`))
      .map(p => p.slice(ROOT.length + 1))

    const missing: string[] = []
    for (const { file, line, id } of refs) {
      if (EXTERNAL.has(id)) continue

      if (PATHISH.test(id)) {
        // A path, matched by suffix so `init/index.ts` and `index.ts` both
        // resolve. Repository files outside `src/` count too — a comment may
        // fairly name `Cargo.toml` or `publish.yml`.
        const hit =
          paths.some(p => p === id || p.endsWith(`/${id}`)) ||
          existsSync(`${ROOT}/${id}`) ||
          existsSync(`${ROOT}/docs/${id}`)
        if (!hit) missing.push(`${file}:${line}  \`${id}\``)
        continue
      }

      // A symbol. The first segment is what has to exist — `foo.bar` is
      // checked as `foo`, since a property may be anything at runtime and
      // pinning those would make this a type-checker instead of a rot check.
      const base = (id.split('.')[0] as string).split('/')[0] as string
      // Too short to be distinctive; `a` or `id` matches everything anyway.
      if (base.length < 3) continue
      if (!new RegExp(`\\b${base.replace(/[-$]/g, '\\$&')}\\b`).test(code)) {
        missing.push(`${file}:${line}  \`${id}\``)
      }
    }

    expect(
      missing,
      `${missing.length} comment(s) name something that no longer exists:\n  ` +
        `${missing.join('\n  ')}\n\nRename the reference, or add it to EXTERNAL with a reason.`,
    ).toEqual([])
  })

  test('the allowlist itself does not rot', () => {
    // An entry that no comment mentions any more is an entry nobody will
    // recognise as removable later — and the allowlist is the one part of this
    // check that can quietly grow until it means nothing.
    const { refs } = scan()
    const mentioned = new Set(refs.map(r => r.id))
    const unused = [...EXTERNAL].filter(id => !mentioned.has(id))

    expect(unused, `EXTERNAL entries nothing mentions: ${unused.join(', ')}`)
      .toEqual([])
  })
})
