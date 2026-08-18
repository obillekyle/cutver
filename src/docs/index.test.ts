import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  defaultSite,
  docsFiles,
  parseSite,
  isIconUrl,
  render,
  renderSite,
  slugOf,
  type SiteConfig,
} from './index'

const SITE: SiteConfig = {
  name: 'Example',
  description: 'A description.',
  icon: '📘',
  repo: 'https://github.com/someone/example',
}

/** The declarations inside every `--brand`-carrying block, in source order. */
function brandBlocks(css: string): string[] {
  return [...css.matchAll(/ {2}--brand: ([^;]+);\n {2}--brand-soft: ([^;]+);/g)].map(
    m => `${m[1]}/${m[2]}`,
  )
}

describe('render', () => {
  test('leaves no placeholder behind', () => {
    expect(render(SITE)).not.toMatch(/\{\{\w+\}\}/)
  })

  test('is pure', () => {
    expect(render(SITE)).toBe(render(SITE))
  })

  test('puts the name in the title, the header and the page title', () => {
    const html = render(SITE)
    expect(html).toContain('<title>Example</title>')
    expect(html).toContain('> Example</a>')
    expect(renderSite(SITE).js).toContain("|| 'Example'} | Example`")
  })

  test('carries the description and the repository', () => {
    const html = render(SITE)
    expect(html).toContain('content="A description."')
    expect(renderSite(SITE).js).toContain("const REPO = 'https://github.com/someone/example'")
  })

  test('drops a trailing slash on the repository', () => {
    expect(renderSite({ ...SITE, repo: 'https://github.com/a/b/' }).js).toContain(
      "const REPO = 'https://github.com/a/b'",
    )
  })

  /**
   * The regression this whole module exists for.
   *
   * `:root[data-theme="dark"]` and the `prefers-color-scheme` block are two
   * statements of one palette, and they were once different: the shell had been
   * copied from another project and only the explicit-toggle block re-themed,
   * so the site rendered in that project's orange for anyone whose OS was dark
   * and who never touched the control. They come from one placeholder now, and
   * this fails if that is ever unpicked.
   */
  test('both dark blocks say the same thing', () => {
    const blocks = brandBlocks(renderSite(SITE).css)
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toBe(blocks[2] as string)
  })

  test('theme overrides apply to both dark blocks at once', () => {
    const blocks = brandBlocks(
      renderSite({ ...SITE, theme: { dark: { brand: '#ffa800', 'brand-soft': '#ffbb3d' } } }).css,
    )
    expect(blocks[1]).toBe('#ffa800/#ffbb3d')
    expect(blocks[2]).toBe('#ffa800/#ffbb3d')
  })

  test('an override adds without removing the defaults it did not mention', () => {
    const html = renderSite({ ...SITE, theme: { light: { 'bg-alt': '#fbf7f0' } } }).css
    expect(html).toContain('--bg-alt: #fbf7f0;')
    // Untouched, because the config said nothing about it.
    expect(html).toContain('--brand: #0f766e;')
  })

  test('storage keys are namespaced, so two sites on one origin do not collide', () => {
    const js = renderSite(SITE).js
    for (const key of ['-theme', '-docs-version', '-docs-default-ref']) {
      expect(js).toContain(`'example${key}'`)
    }
  })

  test('an emoji icon survives the favicon as itself', () => {
    // `encodeURIComponent` would leave `%E2%9C%82` in a file people read, and
    // an emoji needs no encoding in a data URI.
    expect(render({ ...SITE, icon: '✂️' })).toContain("font-size='90'>✂️<")
  })

  test('an icon that would break out of the SVG cannot', () => {
    const html = render({ ...SITE, icon: '<script>' })
    expect(html).not.toContain("font-size='90'><script>")
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('an icon that is a URL', () => {
  const withIcon = (icon: string) => render({ ...SITE, icon })

  test.each([
    'assets/logo.svg',
    './logo.png',
    '/logo.svg',
    'https://cdn.example/logo.png',
    'http://cdn.example/logo.png',
    'data:image/svg+xml,<svg/>',
    'LOGO.SVG',
  ])('%p is treated as one', icon => {
    expect(isIconUrl(icon)).toBe(true)
  })

  test.each(['✂️', '📘', '🥐', 'A'])('%p is not', icon => {
    expect(isIconUrl(icon)).toBe(false)
  })

  test('the favicon points straight at it', () => {
    expect(withIcon('assets/logo.svg')).toContain(
      '<link rel="icon" href="assets/logo.svg">',
    )
  })

  test('the header shows it as an image', () => {
    expect(withIcon('assets/logo.svg')).toContain(
      '<img src="assets/logo.svg" alt="">',
    )
  })

  test('nothing is left wrapped in an SVG text node', () => {
    const html = withIcon('assets/logo.svg')
    expect(html).not.toContain('data:image/svg+xml')
    expect(html).not.toContain("font-size='90'")
  })

  test('the alt is empty, since the wordmark is in the same link', () => {
    // A screen reader reading "cutver cutver" is what naming it twice sounds
    // like.
    expect(withIcon('/logo.svg')).not.toContain('alt="Example"')
  })

  test('a quote in the URL cannot end the attribute', () => {
    const html = withIcon('/a".svg')
    expect(html).toContain('&quot;')
    expect(html).not.toContain('src="/a".svg"')
  })

  test('the shell can size it', () => {
    // Without a rule the image renders at its intrinsic size, which for a
    // 915px mark is the whole header.
    expect(renderSite({ ...SITE, icon: '/logo.svg' }).css).toContain('.brand img {')
  })
})

describe('slugOf', () => {
  test.each([
    ['cutver', 'cutver'],
    ['Bakery', 'bakery'],
    ['@scope/pkg', 'scope-pkg'],
    ['  ', 'docs'],
    ['!!!', 'docs'],
  ])('%p becomes %p', (input, want) => {
    expect(slugOf(input as string)).toBe(want)
  })
})

describe('parseSite', () => {
  test('accepts a minimal config', () => {
    expect(parseSite(JSON.stringify(SITE), 'x').name).toBe('Example')
  })

  test.each([
    ['not json at all', /not valid JSON/],
    ['[]', /expected an object/],
    ['{"description":"d","icon":"i","repo":"r"}', /`name` is required/],
    ['{"name":" ","description":"d","icon":"i","repo":"r"}', /`name` is required/],
    [`{"name":"n","description":"d","icon":"i","repo":"r","theme":[]}`, /`theme` must be/],
    [
      `{"name":"n","description":"d","icon":"i","repo":"r","theme":{"dark":{"brand":1}}}`,
      /theme\.dark\.brand` must be a string/,
    ],
  ])('rejects %p', (text, message) => {
    expect(() => parseSite(text as string, 'site.json')).toThrow(
      message as RegExp,
    )
  })

  test('names the file it was reading', () => {
    expect(() => parseSite('{', 'docs/site.json')).toThrow(/^docs\/site\.json:/)
  })
})

describe('docsFiles', () => {
  test('only the shell is rewritten without a flag', () => {
    const replaceable = docsFiles(SITE)
      .filter(f => f.own === 'generated')
      .map(f => f.path)
    expect(replaceable).toEqual([
      'docs/index.html',
      'docs/docs.css',
      'docs/404.html',
      'docs/docs.js',
    ])
  })

  test('site.json round-trips through the parser it will be read by', () => {
    const written = docsFiles(SITE).find(f => f.path === 'docs/site.json')
    expect(parseSite(written?.contents as string, 'x')).toEqual(SITE)
  })

  test('defaultSite needs no arguments beyond what git can answer', () => {
    const site = defaultSite('thing', 'https://github.com/a/thing')
    expect(() => parseSite(JSON.stringify(site), 'x')).not.toThrow()
  })
})

/**
 * cutver's own site is an artifact of this module, so it is also the largest
 * test of it: if the shell or the renderer changes and `docs/index.html` is not
 * regenerated, the site cutver publishes stops matching the one it would
 * scaffold for anybody else.
 */
test("cutver's own site is in step with the templates", () => {
  const root = new URL('../..', import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    '$1',
  )
  const site = parseSite(
    readFileSync(`${root}/docs/site.json`, 'utf8'),
    'docs/site.json',
  )
  const out = renderSite(site)
  for (const [file, want] of [
    ['index.html', out.html],
    ['docs.css', out.css],
    ['docs.js', out.js],
  ] as const) {
    expect(readFileSync(`${root}/docs/${file}`, 'utf8'), file).toBe(want)
  }
})

describe('ownership', () => {
  const own = (path: string) =>
    docsFiles(SITE, []).find(f => f.path === path)?.own

  test('the shell is cutverature', () => {
    expect(own('docs/index.html')).toBe('generated')
  })

  test.each(['docs/site.json', 'docs/versions.json'])(
    '%s is a cutver format holding your values',
    path => {
      expect(own(path)).toBe('config')
    },
  )

  /**
   * The line `--force` must not cross. These are the site; a scaffolder has no
   * undo, so a flag that replaced them would be data loss with a switch in
   * front of it.
   */
  test.each([
    'docs/pages.json',
    'docs/README.md',
    'docs/getting-started/install.md',
  ])('%s is yours and no flag reaches it', path => {
    expect(own(path)).toBe('yours')
  })

  test('every file declares one of the three', () => {
    for (const f of docsFiles(SITE, [])) {
      expect(['generated', 'config', 'yours']).toContain(f.own)
    }
  })
})

describe('the seeded version list', () => {
  test('is built from the tags it is given', () => {
    const f = docsFiles(SITE, ['1.1.0', '1.0.0']).find(
      x => x.path === 'docs/versions.json',
    )
    expect(JSON.parse(f?.contents as string)).toEqual({
      latest: '1.1.0',
      versions: ['1.1.0', '1.0.0'],
    })
  })

  test('is still valid for a repository with no tags yet', () => {
    const f = docsFiles(SITE, []).find(x => x.path === 'docs/versions.json')
    expect(JSON.parse(f?.contents as string)).toEqual({
      latest: null,
      versions: [],
    })
  })
})
