import { describe, expect, test } from 'bun:test'
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
 * The flag check is the one that earns its place. A new option is added in
 * `cli.ts` and documented nowhere, or an option is removed and its row lives
 * on forever; both are silent, and both are the normal way a reference page
 * stops being one.
 */

const DOCS = new URL('../docs/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

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
  return [...prose(md).matchAll(/^#{1,6} +(.+?) *$/gm)].map(m => slug(m[1] as string))
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
        if (/^(https?:|mailto:|#)/.test(link)) continue

        const [path, anchor] = link.split('#')
        const target = resolve(page, path as string)
        expect(await Bun.file(`${DOCS}${target}`).exists(), `${page} -> ${link}`).toBe(true)

        // An anchor into a page that exists but has no such heading is the
        // rot that survives a file-existence check: rename a heading and
        // every deep link to it lands at the top of the page in silence.
        if (anchor) {
          expect(headings(await read(target)), `${page} -> ${link}`).toContain(anchor)
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
  /** `HELP` read as text — importing cli.ts would run the CLI. */
  async function helpText(): Promise<string> {
    const src = await Bun.file(`${SRC}cli.ts`).text()
    const m = /const HELP = `([\s\S]*?)`\n/.exec(src)
    if (!m?.[1]) throw new Error('could not find HELP in cli.ts')
    return m[1]
  }

  const flags = (s: string) => new Set([...s.matchAll(/--[a-z][a-z-]+/g)].map(m => m[0]))

  /** Just the Options table of the reference page. */
  async function optionsTable(): Promise<string> {
    const md = await read('reference/cli.md')
    const from = md.indexOf('## Options')
    const to = md.indexOf('\n## ', from + 1)
    return md.slice(from, to < 0 ? undefined : to)
  }

  test('documents every flag the CLI has', async () => {
    const documented = flags(await optionsTable())
    for (const flag of flags(await helpText())) {
      expect([...documented], `${flag} is in --help but not in reference/cli.md`).toContain(flag)
    }
  })

  test('documents no flag the CLI does not have', async () => {
    const real = flags(await helpText())
    for (const flag of flags(await optionsTable())) {
      expect([...real], `${flag} is documented but not in --help`).toContain(flag)
    }
  })

  test('the site nav points at pages that exist', async () => {
    // The nav is hand-written in index.html, on purpose — sidebar order is an
    // editorial decision. Which means a renamed file leaves a dead entry.
    const html = await Bun.file(`${DOCS}index.html`).text()
    const nav = html.slice(html.indexOf('const NAV = ['), html.indexOf(']\nconst FLAT'))
    const entries = [...nav.matchAll(/\['([^']+)',\s*'[^']*'\]/g)].map(m => m[1] as string)

    expect(entries.length).toBeGreaterThan(8)
    for (const entry of entries) {
      expect(await Bun.file(`${DOCS}${entry}.md`).exists(), `nav: ${entry}`).toBe(true)
    }
  })

  test('every page is reachable from the nav', async () => {
    // The other direction: a page nobody links to is a page nobody reads.
    const html = await Bun.file(`${DOCS}index.html`).text()
    const nav = html.slice(html.indexOf('const NAV = ['), html.indexOf(']\nconst FLAT'))
    const entries = new Set([...nav.matchAll(/\['([^']+)',/g)].map(m => `${m[1]}.md`))
    entries.add('README.md')

    for (const page of await pages()) {
      expect([...entries], `${page} is not in the nav`).toContain(page)
    }
  })
})
