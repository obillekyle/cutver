/**
 * `cutver docs install|update` — the documentation site, as a generated file.
 *
 * **The shell was being copied between repositories by hand, and copies rot.**
 * This one carries the evidence in its own source: the dark palette in
 * `:root[data-theme="dark"]` and the one in the `prefers-color-scheme` query
 * are required to agree, and for a while they did not, because the file had
 * been adapted from another project's and only half re-themed. The site
 * rendered in that project's orange for every reader whose OS was dark and who
 * never touched the toggle — a bug invisible to whoever made the copy, since
 * their explicit choice masked it.
 *
 * So the shell is a template here and the site is an artifact. Nothing in
 * `docs/index.html` is meant to be edited; `docs/site.json` holds the parts
 * that differ between projects, and `update` re-renders. The two dark blocks
 * come from a single placeholder substituted twice, which is what stops that
 * particular bug returning rather than merely fixing it.
 *
 * **What is yours and what is not.** The markdown and `pages.json` are the
 * site itself and are never replaced, by any flag. `site.json` and
 * `versions.json` are cutver formats holding your values, kept unless
 * `--force` says otherwise. `index.html` is ours, replaced on every `update`,
 * and that is the whole point of the command.
 */
import SHELL_MODULE from './shell.html' with { type: 'text' }
import STYLES_MODULE from './shell.css' with { type: 'text' }
import SCRIPT_MODULE from './shell.jstext' with { type: 'text' }
import { exists, readText, write } from '../runtime'
import { buildVersions, VERSIONS_FILE } from '../versions'

/**
 * The shell, inlined at build time.
 *
 * Cast, and not for want of a declaration. Bun's own types claim the `*.html`
 * wildcard for `HTMLBundle`, its bundler entrypoint, and a second ambient
 * declaration cannot outrank it — unlike `markdown.d.ts`, which works precisely
 * because nothing else wants `*.md`. The import attribute says `text`, so what
 * arrives at runtime is the file as a string and only the type is wrong.
 */
const SHELL = SHELL_MODULE as unknown as string
const STYLES = STYLES_MODULE as unknown as string
const SCRIPT = SCRIPT_MODULE as unknown as string

/** Where the site lives. Not configurable: GitHub Pages serves `/docs` or root. */
export const DOCS_DIR = 'docs'
export const SITE_FILE = `${DOCS_DIR}/site.json`

/**
 * The stylesheet and the script are separate files rather than two blocks
 * inside the page.
 *
 * A 54 kB `index.html` where 51 kB of it is style and behaviour is a file no
 * diff is readable in and no browser caches usefully: change one colour and the
 * whole thing is re-downloaded. Split, the page is under 4 kB and the two large
 * files only change when the shell itself does.
 */
export const CSS_FILE = `${DOCS_DIR}/docs.css`
export const JS_FILE = `${DOCS_DIR}/docs.js`
export const NOT_FOUND_FILE = `${DOCS_DIR}/404.html`

/**
 * Turns Jekyll off, which GitHub Pages otherwise runs over everything here.
 *
 * **Without it the markdown is the site, and the site is not.** Jekyll renders
 * every `docs/**` markdown file into a standalone page and serves it — measured
 * against a live deployment, `/guides/commits` answered **200** with a bare
 * themed page: no sidebar, no search, no version picker, none of the shell.
 * Google indexes those, and a reader who lands on one has no way back into the
 * actual documentation.
 *
 * It also quietly disabled `404.html`. That file only runs when Pages has
 * nothing to serve, and Jekyll had made something to serve for every path a
 * markdown file happened to sit at.
 *
 * The file is empty; its presence is the whole instruction.
 */
export const NOJEKYLL_FILE = `${DOCS_DIR}/.nojekyll`

/**
 * The per-project parts of the shell.
 *
 * Everything else about the site is the same in every repository, which is why
 * the list is this short: a knob that only ever holds one value is a knob that
 * drifts out of step with the template it configures.
 */
export interface SiteConfig {
  /** Shown in the tab, the header and every page title. */
  name: string
  /** The `<meta name="description">`, and what a link preview quotes. */
  description: string
  /**
   * An emoji, or the URL of an image.
   *
   * Either becomes the favicon and sits before the name in the header. A URL
   * may be absolute, root-relative or relative to `docs/`, so a project that
   * already has `assets/logo.svg` can point at it rather than settle for the
   * nearest emoji.
   */
  icon: string
  /** Repository URL, for the header link and the version picker's raw fetches. */
  repo: string
  /**
   * Where the site is deployed, origin only.
   *
   * Optional, and what it unlocks is the half of the head tags that cannot
   * be written without knowing it: the canonical link, `og:url`, and the
   * preview image, which Open Graph requires as an absolute URL.
   */
  url?: string
  /**
   * CSS custom properties, overriding the shell's defaults.
   *
   * Names go without the leading `--`. Anything the shell defines can be set,
   * not just the brand, and what is left out keeps the default — a project that
   * only wants its own accent colour writes one line rather than a palette.
   */
  theme?: {
    light?: Record<string, string>
    dark?: Record<string, string>
  }
}

/**
 * `localStorage` keys are namespaced by this.
 *
 * Derived rather than configured: two sites on one origin must not read each
 * other's theme and pinned version, and a docs site previewed on `localhost`
 * shares an origin with every other one on this machine.
 */
export function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'docs'
  )
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

/** For the attribute and title positions. A name with an `&` in it is not exotic. */
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ESCAPES[c] as string)

/**
 * Is this icon a picture to load, or a character to draw?
 *
 * An emoji is a character, and no character in one is `/` or `:`. A path is
 * neither an extension check nor a protocol check on its own: `logo.svg` has no
 * scheme, `https://…` has no dot before its first slash, and `data:…` has no
 * slash at all until well past the point that matters. So the rule is the union
 * of the three things a reader would actually write.
 */
export function isIconUrl(icon: string): boolean {
  return (
    /^(https?:|data:|\/|\.{0,2}\/)/.test(icon) ||
    /\.(svg|png|ico|jpe?g|webp|gif|avif)$/i.test(icon)
  )
}

/**
 * The favicon is an emoji inside an SVG inside a data URI inside an attribute,
 * so it has to survive three parsers.
 *
 * Only the characters that actually break one of them are touched. Running the
 * whole string through `encodeURIComponent` would be correct and would also
 * turn every emoji into percent-escapes — six bytes of `%E2%9C%82` where the
 * scissors used to be, in a file people read. Emoji need no encoding in a data
 * URI; `&<>` would end the SVG's text node, and `#%"` would end the URI or the
 * attribute. `%` goes first, or it would escape the escapes.
 */
const escapeIcon = (s: string) =>
  s
    .replace(/%/g, '%25')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '%22')
    .replace(/#/g, '%23')

/**
 * The two places the icon appears, rendered for whichever kind it is.
 *
 * A URL is used directly by the browser, so the favicon becomes an ordinary
 * `href` and the header an `<img>`; the type is left to the server rather than
 * guessed from the extension, since guessing wrong on a `.ico` served as PNG
 * breaks the tab icon in exactly the browsers that are strictest about it.
 *
 * An emoji has to be drawn, so it goes into an SVG `<text>` for the favicon and
 * stays a character in the header.
 */
function iconMarkup(icon: string): { favicon: string; brand: string } {
  if (isIconUrl(icon)) {
    const href = escapeHtml(icon)
    return {
      favicon: `<link rel="icon" href="${href}">`,
      // Empty alt, not the project name: the wordmark sits next to it in the
      // same link, so naming it again makes a screen reader say it twice.
      brand: `<img src="${href}" alt="">`,
    }
  }
  return {
    favicon:
      `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' ` +
      `viewBox='0 0 100 100'><text y='.9em' font-size='90'>${escapeIcon(icon)}</text></svg>">`,
    brand: `<span>${escapeHtml(icon)}</span>`,
  }
}

/**
 * The accent, when `site.json` does not say.
 *
 * Here once, rather than written into the three CSS blocks that need to agree.
 * That is the whole repair: the blocks used to each carry their own literal,
 * which is how two of them ended up a different colour from the third.
 */
const BRAND: Record<'light' | 'dark', Record<string, string>> = {
  light: { brand: '#0f766e', 'brand-soft': '#12857c' },
  dark: { brand: '#5eead4', 'brand-soft': '#2dd4bf' },
}

/**
 * One declaration per line, indented to sit inside a `:root` block.
 *
 * Two spaces in both dark blocks, though the nested one is written at four.
 * Being able to render the same declarations into both positions is worth more
 * than matching the indent of each, and the file is generated: nobody reads it
 * for its whitespace.
 */
function palette(
  mode: 'light' | 'dark',
  vars: Record<string, string> | undefined,
): string {
  const merged = { ...BRAND[mode], ...(vars ?? {}) }
  return Object.entries(merged)
    .map(([k, v]) => `  --${k.replace(/^--/, '')}: ${v};\n`)
    .join('')
}

/**
 * For a value landing inside a single-quoted JavaScript string.
 *
 * Not `escapeHtml`, which is what the single-file shell used for these and got
 * away with only because no project is called `O'Brien`. HTML escaping inside a
 * script is doubly wrong: an apostrophe would still end the string, and a `<`
 * would arrive at the reader as the literal five characters `&lt;`.
 */
const escapeJs = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/**
 * The head tags a link preview and a crawler read.
 *
 * Everything that can be said without knowing where the site is deployed is
 * said unconditionally. The rest — the canonical URL, `og:url`, and the image,
 * which Open Graph requires as an absolute URL — needs `url` in `site.json`,
 * and is left out rather than guessed when it is absent. A canonical pointing
 * at the wrong origin is worse than none.
 */
function metaTags(site: SiteConfig): string {
  const name = escapeHtml(site.name)
  const description = escapeHtml(site.description)
  const url = site.url?.replace(/\/+$/, '')
  const tag = (attr: string, key: string, value: string) =>
    `<meta ${attr}="${key}" content="${value}">`

  const out = [
    tag('property', 'og:type', 'website'),
    tag('property', 'og:site_name', name),
    tag('property', 'og:title', name),
    tag('property', 'og:description', description),
    // `summary_large_image` needs an image to be large about; without one the
    // card renders blank, so the plain summary is the honest default.
    tag('name', 'twitter:card', url && isIconUrl(site.icon) ? 'summary_large_image' : 'summary'),
    tag('name', 'twitter:title', name),
    tag('name', 'twitter:description', description),
  ]

  if (url) {
    const absolute = escapeHtml(url)
    out.unshift(`<link rel="canonical" href="${absolute}/">`)
    out.push(tag('property', 'og:url', `${absolute}/`))

    // Only a real file can be a preview image. An emoji favicon is a data URI
    // built in the page, which nothing crawling the head can fetch.
    if (isIconUrl(site.icon)) {
      const image = /^https?:/.test(site.icon)
        ? escapeHtml(site.icon)
        : `${absolute}/${escapeHtml(site.icon).replace(/^\/+/, '')}`
      out.push(tag('property', 'og:image', image))
      out.push(tag('name', 'twitter:image', image))
      out.push(tag('property', 'og:image:alt', `The ${name} logo`))
    }
  }

  return `${out.join('\n')}\n`
}

/** The three files, rendered against one config. Pure: same config, same bytes. */
export function renderSite(site: SiteConfig): {
  html: string
  css: string
  js: string
} {
  const repo = site.repo.replace(/\/+$/, '')
  const icon = iconMarkup(site.icon)
  return {
    html: SHELL.replaceAll('{{name}}', escapeHtml(site.name))
      .replaceAll('{{description}}', escapeHtml(site.description))
      .replaceAll('{{meta}}', metaTags(site))
      .replaceAll('{{favicon}}', icon.favicon)
      .replaceAll('{{brandIcon}}', icon.brand)
      .replaceAll('{{repo}}', escapeHtml(repo)),
    css: STYLES.replaceAll(
      '{{themeLight}}',
      palette('light', site.theme?.light),
    ).replaceAll('{{themeDark}}', palette('dark', site.theme?.dark)),
    js: SCRIPT.replaceAll('{{repo}}', escapeJs(repo))
      .replaceAll('{{slug}}', slugOf(site.name))
      .replaceAll('{{name}}', escapeJs(site.name)),
  }
}

/** The page alone, for the callers that only care about the markup. */
export function render(site: SiteConfig): string {
  return renderSite(site).html
}

/**
 * A config, or a refusal that says which field.
 *
 * Hand-written JSON with a typo in it should not produce a site with the word
 * `undefined` in its title, which is what a spread over defaults would do.
 */
export function parseSite(text: string, where: string): SiteConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${where}: not valid JSON — ${(error as Error).message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}: expected an object`)
  }

  const o = raw as Record<string, unknown>
  for (const key of ['name', 'description', 'icon', 'repo'] as const) {
    if (typeof o[key] !== 'string' || !(o[key] as string).trim()) {
      throw new Error(`${where}: \`${key}\` is required and must be a string`)
    }
  }

  // An origin, not a path: everything built from it is joined with a slash, and
  // a scheme is required because a canonical link without one is not a URL.
  if (
    o.url !== undefined &&
    (typeof o.url !== 'string' || !/^https?:\/\/\S+$/.test(o.url))
  ) {
    throw new Error(`${where}: \`url\` must be an http or https URL`)
  }

  const theme = o.theme as SiteConfig['theme'] | undefined
  if (theme !== undefined) {
    // `Array.isArray` and not just a `typeof` check: an array passes for an
    // object, so `"theme": []` would sail through and render a site with no
    // palette rather than say what was wrong with the line.
    if (typeof theme !== 'object' || theme === null || Array.isArray(theme)) {
      throw new Error(`${where}: \`theme\` must be an object`)
    }
    for (const mode of ['light', 'dark'] as const) {
      const vars = theme[mode]
      if (vars === undefined) continue
      if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) {
        throw new Error(`${where}: \`theme.${mode}\` must be an object`)
      }
      for (const [k, v] of Object.entries(vars)) {
        if (typeof v !== 'string') {
          throw new Error(`${where}: \`theme.${mode}.${k}\` must be a string`)
        }
      }
    }
  }

  return {
    name: o.name as string,
    description: o.description as string,
    icon: o.icon as string,
    repo: o.repo as string,
    url: o.url as string | undefined,
    theme,
  }
}

/** What a repository with no `site.json` gets, so `install` needs no arguments. */
export function defaultSite(name: string, repo: string): SiteConfig {
  return {
    name,
    description: `Documentation for ${name}.`,
    icon: '📘',
    repo,
  }
}

const STARTER_PAGES = `[
  {
    "title": "Getting started",
    "items": [["getting-started/install", "Install"]]
  }
]
`

const STARTER_README = (site: SiteConfig) => `# ${site.name}

${site.description}

This page is \`docs/README.md\`. It is the site's root and is never listed in
the sidebar, because a page every version has is not a page worth declaring.

Everything else is declared in \`docs/pages.json\`, and every entry there is a
markdown file under \`docs/\`.
`

const STARTER_INSTALL = (site: SiteConfig) => `# Install

How to install ${site.name}.

Replace this page. It exists so \`pages.json\` has something to point at and the
sidebar renders on the first run.
`

/**
 * Who owns a file, which is what decides whether it can be written over.
 *
 * Three states rather than a boolean, because `--force` has to mean something
 * narrower than "replace everything". A flag that resets the config is useful;
 * one that silently eats a page somebody wrote is a bug with a command-line
 * switch in front of it.
 */
export type Ownership =
  /** cutver's. Rewritten on every run, with or without the flag. */
  | 'generated'
  /** cutver's shape, your values. Kept, and replaced only under `--force`. */
  | 'config'
  /** Yours. Never replaced, whatever is passed. */
  | 'yours'

/**
 * What GitHub Pages serves for a path that is not a file.
 *
 * The site routes on `?/page`, which needs no file per page — the path is
 * always `/`, so `index.html` answers it. What that leaves uncovered is a
 * reader arriving at `/guides/commits` instead: a real path, no file behind
 * it, and Pages answers with its own 404 rather than the site. This turns that
 * path back into the query the app reads and gets out of the way.
 *
 * `replace` rather than `assign`, so the redirect leaves no history entry and
 * Back returns wherever the reader came from instead of bouncing them through
 * here again.
 *
 * The `refresh` is the no-script path and cannot do the rewrite — its target is
 * a fixed string — so it goes to the front page, which is the honest fallback. A
 * second of delay lets the script win wherever there is one; it never runs
 * otherwise, because the navigation above has already started.
 *
 * `noindex`, because this file answers every wrong URL on the site and none of
 * them is a page.
 */
/**
 * Where this site starts, as a path.
 *
 * `/` on a custom domain or a user page, `/my-repo/` on project pages — which
 * is what `obillekyle.github.io/my-repo` is, and it is the common case for a
 * repository that has not been given a domain.
 *
 * Taken from `url` rather than sniffed at run time, because it cannot be
 * sniffed. A project page and a user page are both served from
 * `<user>.github.io`, so nothing in the request tells the two readings of
 * `github.io/thing/guides` apart: a repository called thing serving a page
 * called guides, or an account page whose path happens to start with thing.
 * The config already knows which, so it says.
 */
function basePath(site: SiteConfig): string {
  if (!site.url) return '/'
  try {
    const { pathname } = new URL(site.url)
    return pathname.endsWith('/') ? pathname : `${pathname}/`
  } catch {
    return '/'
  }
}

const NOT_FOUND_PAGE = (site: SiteConfig) => {
  const base = basePath(site)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(site.name)}</title>
<meta name="robots" content="noindex">
<script>
  (function () {
    var l = window.location
    var base = ${JSON.stringify(base)}

    // The requested path, with the site's own prefix taken off first. Without
    // that step a project page turns /my-repo/guides into the page
    // "my-repo/guides", and every deep link on it 404s inside the app instead
    // of outside it.
    //
    // Matched without the trailing slash, since /my-repo is a request that
    // reaches here too and does not contain "/my-repo/" to strip. Left in, it
    // would send the reader to /my-repo/?/my-repo.
    var root = base.replace(/\\/+$/, '')
    var path = l.pathname
    if (root && path.indexOf(root) === 0) path = path.slice(root.length)
    path = path.replace(/^\\/+/, '').replace(/\\/+$/, '')

    var rest = l.search.replace(/^\\?/, '')

    // Nothing to rewrite: redirecting the root to itself would loop.
    var to = path || rest
      ? base + '?/' + path + (rest ? '&' + rest : '') + l.hash
      : base

    l.replace(to)
  })()
</script>
<meta http-equiv="refresh" content="1;url=${escapeHtml(base)}">
</head>
<body>
<p>Taking you to <a href="${escapeHtml(base)}">${escapeHtml(site.name)}</a>.</p>
</body>
</html>
`
}

export interface DocsFile {
  path: string
  contents: string
  own: Ownership
}

/**
 * Every file the site is made of.
 *
 * The markdown and `pages.json` are the site's content, and content is not
 * something a tool should have opinions about after the day it was scaffolded
 * — so no flag reaches them. `site.json` and `versions.json` are cutver's own
 * formats holding your choices, so `--force` may reset them: getting a fresh
 * one after a schema change is worth a flag, and the values in them are two
 * lines to retype rather than a page to rewrite.
 */
export function docsFiles(site: SiteConfig, tags: string[] = []): DocsFile[] {
  const rendered = renderSite(site)
  return [
    { path: `${DOCS_DIR}/index.html`, contents: rendered.html, own: 'generated' },
    { path: CSS_FILE, contents: rendered.css, own: 'generated' },
    { path: NOT_FOUND_FILE, contents: NOT_FOUND_PAGE(site), own: 'generated' },
    { path: NOJEKYLL_FILE, contents: '', own: 'generated' },
    { path: JS_FILE, contents: rendered.js, own: 'generated' },
    /**
     * The version picker in the shell fetches this file, so a site scaffolded
     * without one ships a control that does nothing.
     *
     * Seeded from the tags that exist rather than left empty, so the picker
     * works on the first load instead of after the next release. Writing it is
     * also what opts the repository in: `cutver stage` refreshes this file when
     * it is present and ignores the whole feature when it is not, which is why
     * there is no config key for it.
     */
    {
      path: VERSIONS_FILE,
      contents: `${JSON.stringify(buildVersions(tags), null, 2)}\n`,
      own: 'config',
    },
    {
      path: SITE_FILE,
      contents: `${JSON.stringify(site, null, 2)}\n`,
      own: 'config',
    },
    { path: `${DOCS_DIR}/pages.json`, contents: STARTER_PAGES, own: 'yours' },
    {
      path: `${DOCS_DIR}/README.md`,
      contents: STARTER_README(site),
      own: 'yours',
    },
    {
      path: `${DOCS_DIR}/getting-started/install.md`,
      contents: STARTER_INSTALL(site),
      own: 'yours',
    },
  ]
}

export interface DocsResult {
  path: string
  state: 'written' | 'skipped' | 'unchanged'
  detail: string
}

export interface DocsOptions {
  dryRun?: boolean
  /** Release versions, newest first, to seed the picker. `install` only. */
  tags?: string[]
  /** `install` only. Without it an existing site.json is kept. */
  force?: boolean
}

/** Read `docs/site.json`, or nothing if the site was never installed. */
export async function readSite(root: string): Promise<SiteConfig | null> {
  const at = `${root}/${SITE_FILE}`
  if (!(await exists(at))) return null
  return parseSite(await readText(at), SITE_FILE)
}

/**
 * `install` — scaffold the site, keeping anything already written.
 *
 * Re-runnable on purpose. A repository that installed the site before this
 * command existed has the markdown and `pages.json` already; running `install`
 * adopts it, writing only the shell and whatever is genuinely missing.
 */
export async function installDocs(
  root: string,
  site: SiteConfig,
  { dryRun = false, force = false, tags = [] }: DocsOptions = {},
): Promise<DocsResult[]> {
  const out: DocsResult[] = []

  for (const file of docsFiles(site, tags)) {
    const full = `${root}/${file.path}`
    const present = await exists(full)

    // `--force` reaches cutver's own formats and stops at the content. The
    // markdown and the sidebar are the site; a flag that quietly replaced a
    // page somebody wrote would be a data-loss bug with a switch in front of
    // it, and there is no undo for one inside a scaffolder.
    if (present && file.own === 'yours') {
      out.push({ path: file.path, state: 'skipped', detail: 'yours — never replaced' })
      continue
    }
    if (present && file.own === 'config' && !force) {
      out.push({
        path: file.path,
        state: 'skipped',
        detail: 'kept — --force to rewrite',
      })
      continue
    }
    if (present && (await readText(full)) === file.contents) {
      out.push({ path: file.path, state: 'unchanged', detail: 'already current' })
      continue
    }

    if (!dryRun) await write(full, file.contents)
    out.push({
      path: file.path,
      state: 'written',
      detail: present ? (file.own === 'config' ? 'rewritten, values kept' : 'replaced') : 'created',
    })
  }

  return out
}

/**
 * `update` — re-render the shell against this repository's `site.json`.
 *
 * Touches one file, and never the content. This is the command that exists
 * because the shell used to be copied: a fix made here reaches every project
 * that runs it, instead of the one repository somebody remembered to paste
 * into.
 */
export async function updateDocs(
  root: string,
  site: SiteConfig,
  { dryRun = false }: DocsOptions = {},
): Promise<DocsResult[]> {
  const out: DocsResult[] = []

  // Every generated file, not just the page: the palette lives in the
  // stylesheet and the storage keys in the script, so re-rendering one of the
  // three would leave a site themed by one version and behaving like another.
  for (const file of docsFiles(site).filter(f => f.own === 'generated')) {
    const full = `${root}/${file.path}`
    const present = await exists(full)

    if (present && (await readText(full)) === file.contents) {
      out.push({ path: file.path, state: 'unchanged', detail: 'already current' })
      continue
    }

    if (!dryRun) await write(full, file.contents)
    out.push({
      path: file.path,
      state: 'written',
      detail: present ? 're-rendered' : 'created',
    })
  }

  return out
}
