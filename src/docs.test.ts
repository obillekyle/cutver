import { describe, expect, test } from 'bun:test'
import { allFlags, COMMANDS } from './cli/help'
import { parseConfig } from './config/load'
import { Glob } from 'bun'

/**
 * Documentation that cannot rot the usual way.
 *
 * The repository this was extracted from compiles every code block in its docs
 * against the real packages, so a broken example fails on the commit that
 * breaks it rather than on the reader six months later. cutver's docs are
 * prose, links, YAML and flags instead of TypeScript, so the same idea points
 * at those: every internal link resolves, every heading an anchor claims
 * exists, every YAML block parses, and the CLI reference lists exactly the
 * flags the CLI actually has — no more, and no fewer.
 *
 * The flag check is the one that earns its place. A new option is added in the
 * command table and documented nowhere, or an option is removed and its row
 * lives on forever; both are silent, and both are the normal way a reference
 * page stops being one.
 */

const DOCS = new URL('../docs/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
)

async function pages(): Promise<string[]> {
  const out: string[] = []
  for await (const hit of new Glob('**/*.md').scan({ cwd: DOCS })) {
    out.push(hit.replaceAll('\\', '/'))
  }
  return out.sort()
}

const read = (rel: string) => Bun.file(`${DOCS}${rel}`).text()

/** GitHub's heading-slug rules, which is what the site's anchors use. */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')

/** Strip fenced code before scanning prose, so an example link is not a real one. */
const prose = (md: string) => md.replace(/```[\s\S]*?```/g, '')

function headings(md: string): string[] {
  return [...prose(md).matchAll(/^#{1,6} +(.+?) *$/gm)].map(m =>
    slug(m[1] as string),
  )
}

/** Resolve `../a/b.md` against the directory of `from`. */
function resolve(from: string, href: string): string {
  const dir = from.includes('/') ? from.replace(/\/[^/]+$/, '') : ''
  const parts = [...dir.split('/').filter(Boolean), ...href.split('/')]
  const out: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

describe('every page', () => {
  test('exists at all', async () => {
    // A guard on the guard: if the glob ever returns nothing, every test below
    // passes vacuously and the whole file becomes decoration.
    expect((await pages()).length).toBeGreaterThan(8)
  })

  test('opens with a single h1', async () => {
    for (const page of await pages()) {
      const h1 = [...prose(await read(page)).matchAll(/^# +(.+)$/gm)]
      expect(h1.length, page).toBe(1)
    }
  })

  test('links to a file that is there', async () => {
    for (const page of await pages()) {
      const md = prose(await read(page))
      for (const [, href] of md.matchAll(/\]\(([^)]+)\)/g)) {
        const link = href as string
        // `?v=1.1.0#/` is this same page at another version — a query and a
        // hash route, not a path to a file. Resolving it against the directory
        // would look for a file named after the query string.
        if (/^(https?:|mailto:|[#?])/.test(link)) continue

        const [path, anchor] = link.split('#')
        const target = resolve(page, path as string)
        expect(
          await Bun.file(`${DOCS}${target}`).exists(),
          `${page} -> ${link}`,
        ).toBe(true)

        // An anchor into a page that exists but has no such heading is the
        // rot that survives a file-existence check: rename a heading and
        // every deep link to it lands at the top of the page in silence.
        if (anchor) {
          expect(headings(await read(target)), `${page} -> ${link}`).toContain(
            anchor,
          )
        }
      }
    }
  })

  test('links to its own headings correctly', async () => {
    for (const page of await pages()) {
      const md = prose(await read(page))
      const own = headings(await read(page))
      for (const [, anchor] of md.matchAll(/\]\(#([^)]+)\)/g)) {
        expect(own, `${page} -> #${anchor}`).toContain(anchor as string)
      }
    }
  })

  test('has YAML blocks that parse', async () => {
    for (const page of await pages()) {
      const md = await read(page)
      for (const [, body] of md.matchAll(/```yaml\n([\s\S]*?)```/g)) {
        // Workflow fragments are steps rather than whole documents, so they
        // are wrapped before parsing. What is being checked is that the
        // indentation and quoting in the docs are real YAML, not that a
        // fragment is a complete workflow.
        const text = (body as string).replace(/^ {6}/gm, '  ')
        expect(() => Bun.YAML.parse(text), `${page}`).not.toThrow()
      }
    }
  })
})

describe('the CLI reference', () => {
  /**
   * Every flag the CLI has, from the table that defines them.
   *
   * **Imported rather than scraped.** This used to regex a `HELP` template
   * literal out of the source, which worked only while the help was one string
   * — and 2.0 made it a rendering of a command table, where a per-command flag
   * never appears in the top-level text at all. Importing `help.ts` is safe in
   * a way importing the entry is not: it declares data and runs no CLI.
   */
  const realFlags = () => new Set(allFlags())

  const flags = (s: string) =>
    new Set([...s.matchAll(/--[a-z][a-z-]+/g)].map(m => m[0]))

  /** Just the Options table of the reference page. */
  async function optionsTable(): Promise<string> {
    const md = await read('reference/cli.md')
    const from = md.indexOf('## Options')
    const to = md.indexOf('\n## ', from + 1)
    return md.slice(from, to < 0 ? undefined : to)
  }

  test('documents every flag the CLI has', async () => {
    const documented = flags(await optionsTable())
    for (const flag of realFlags()) {
      expect(
        [...documented],
        `${flag} is in --help but not in reference/cli.md`,
      ).toContain(flag)
    }
  })

  /**
   * The command list, checked the way the flags are.
   *
   * The page claims to be generated from the same table it is checked against,
   * and only half of that was true: nothing compared the command list to
   * `COMMANDS`, so `version` shipped in `cutver help` and in the dispatcher
   * while appearing in neither the synopsis nor the table on this page.
   */
  test('lists every command the CLI has', async () => {
    const md = await read('reference/cli.md')
    for (const { name } of COMMANDS) {
      expect(
        md,
        `\`cutver ${name}\` is in --help but not in reference/cli.md`,
      ).toContain(`cutver ${name}`)
    }
  })

  test('documents no flag the CLI does not have', async () => {
    const real = realFlags()
    for (const flag of flags(await optionsTable())) {
      expect([...real], `${flag} is documented but not in --help`).toContain(
        flag,
      )
    }
  })

  /**
   * The sidebar, read as data.
   *
   * It used to be scraped out of `index.html` with a regex over a literal.
   * `pages.json` exists so an older tag can describe its own sidebar, and the
   * happy side effect is that this check parses the file rather than pattern-
   * matching source — the previous version broke silently the moment the
   * literal moved, and passed a suite that had stopped checking anything.
   */
  async function navEntries(): Promise<string[]> {
    const groups = (await Bun.file(`${DOCS}pages.json`).json()) as {
      title: string
      items: [string, string][]
    }[]
    return groups.flatMap(g => g.items.map(([page]) => page))
  }

  test('the site nav points at pages that exist', async () => {
    // The nav is hand-written, on purpose — sidebar order is an editorial
    // decision. Which means a renamed file leaves a dead entry.
    const entries = await navEntries()

    expect(entries.length).toBeGreaterThan(8)
    for (const entry of entries) {
      expect(
        await Bun.file(`${DOCS}${entry}.md`).exists(),
        `nav: ${entry}`,
      ).toBe(true)
    }
  })

  test('every page is reachable from the nav', async () => {
    // The other direction: a page nobody links to is a page nobody reads.
    const entries = new Set((await navEntries()).map(p => `${p}.md`))
    entries.add('README.md')

    for (const page of await pages()) {
      expect([...entries], `${page} is not in the nav`).toContain(page)
    }
  })

  test('index.html reads the nav from pages.json, not from a literal', async () => {
    // The pair of checks above is only meaningful if the site reads the same
    // file they do. A literal reintroduced in the shell would leave them
    // passing while the sidebar came from somewhere else entirely.
    const html = await Bun.file(`${DOCS}index.html`).text()
    expect(html).toContain("fetch('pages.json')")
    expect(html).toContain('docs/pages.json')
    expect(html).not.toContain('const NAV = [')
  })
})

describe('what the docs tell you to run and write', () => {
  /**
   * **Parsing is not loading, and that gap is how a page came to document a
   * key the loader rejects.** The YAML check above proves a block is
   * well-formed; nothing proved cutver would accept it. So `artifacts.enabled`
   * survived in the reference page for as long as it did with every assertion
   * green — the example parsed perfectly and was refused by the tool.
   *
   * A block counts as a config when it names at least one top-level key. That
   * skips workflow fragments and snippets of prose without needing a marker,
   * and still catches the case that matters, since a wrong *sub*-key always
   * sits under a right top-level one.
   */
  const TOP_LEVEL = [
    'schema',
    'target',
    'publish',
    'artifacts',
    'changelog',
    'summarizer',
    'channels',
  ]

  async function configBlocks(
    page: string,
  ): Promise<{ text: string; doc: unknown }[]> {
    const out: { text: string; doc: unknown }[] = []
    for (const [, body] of (await read(page)).matchAll(
      /```yaml\n([\s\S]*?)```/g,
    )) {
      let doc: unknown
      try {
        doc = Bun.YAML.parse(body as string)
      } catch {
        continue // the YAML test above owns this failure
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue
      if (!Object.keys(doc).some(k => TOP_LEVEL.includes(k))) continue
      out.push({ text: body as string, doc })
    }
    return out
  }

  /**
   * The root README, which no check has ever covered.
   *
   * `pages()` globs `docs/` only — and the README is the npm page, so it was
   * simultaneously the least guarded file and the most public one. It drifted
   * furthest for exactly that reason: it documented `cutver [version]` and
   * framed `stage` as a prerelease subcommand long after neither was true.
   *
   * It is onboarding now rather than a second reference, so there is little
   * surface left to rot. This covers what remains: every command it shows must
   * be one the CLI has.
   */
  /**
   * **Fenced `bash` blocks only.** Scanning whole files matched prose — "the
   * only input cutver reads" parses as `cutver reads` — and the install line
   * `curl -L -o cutver https://…` as `cutver https`. A command is something
   * someone can copy and run, which is exactly what a shell fence marks.
   *
   * The first word after `cutver` is captured whatever it looks like, not just
   * `[a-z-]+`. Restricting it to letters is how `cutver 1.4.0` — the pre-2.0
   * invocation, which now exits 1 — sat in two guide pages unnoticed: a version
   * number simply did not match, so there was nothing to compare against the
   * command list.
   */
  function commandsShown(md: string): string[] {
    return [...md.matchAll(/```bash\n([\s\S]*?)```/g)]
      .flatMap(([, body]) => (body as string).split('\n'))
      .map(line =>
        /^(?:bunx |npx --yes )?cutver(?: +(\S+))?\s*$|^(?:bunx |npx --yes )?cutver +(?!https?:)(\S+)/.exec(
          line.trim(),
        ),
      )
      .map(m => (m ? (m[1] ?? m[2] ?? '') : null))
      .filter((w): w is string => w !== null && !w.startsWith('-'))
  }

  test('no page shows a command the CLI does not have', async () => {
    const names = new Set(COMMANDS.map(c => c.name))
    const readme = await Bun.file(
      new URL('../README.md', import.meta.url),
    ).text()

    const sources: [string, string][] = [['README.md', readme]]
    for (const page of await pages()) sources.push([page, await read(page)])

    let checked = 0
    for (const [where, md] of sources) {
      for (const word of commandsShown(md)) {
        checked++
        // The empty string is a bare `cutver` on its own line. It was the
        // release invocation before 2.0 and is now the help — including in the
        // one place a guide used it as the last step of graduating a
        // prerelease, where it did nothing at all and exited 1 in CI.
        expect(
          [...names],
          word
            ? `${where} shows \`cutver ${word}\``
            : `${where} shows a bare \`cutver\`, which prints help`,
        ).toContain(word)
      }
    }

    expect(
      checked,
      'no cutver commands found — has the regex stopped matching?',
    ).toBeGreaterThan(10)
  })

  /**
   * **Every page, not the reference page.**
   *
   * Both checks below used to run over a hand-written `['reference/config.md']`,
   * which is the same shape of mistake they exist to catch: the reference page
   * documented the current spelling while `guides/changelog.md` taught the
   * deprecated one for as long as nobody read both in the same sitting. A guide
   * is where somebody copies a block from, so it is the page that most needs
   * checking.
   */
  test('every documented config example is one cutver accepts', async () => {
    let checked = 0

    for (const page of await pages()) {
      for (const { text, doc } of await configBlocks(page)) {
        checked++
        expect(() => parseConfig(doc, page), `${page}:\n${text}`).not.toThrow()
      }
    }

    // A guard on the guard: a regex that stops matching would pass this file
    // silently, which is exactly the failure it exists to prevent.
    expect(checked).toBeGreaterThan(3)
  })

  test('no config example uses a spelling the docs should not teach', async () => {
    // Deprecated shapes still parse — that is the point of deprecating rather
    // than removing them — so `not.toThrow()` cannot catch one. The warnings
    // the loader collects can.
    for (const page of await pages()) {
      for (const { text, doc } of await configBlocks(page)) {
        expect(parseConfig(doc, page).warnings, `${page}:\n${text}`).toEqual([])
      }
    }
  })
})
