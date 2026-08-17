#!/usr/bin/env bun
/**
 * The terminal screenshot in the README, generated from real output.
 *
 *     bun run scripts/terminal-shot.ts    # writes assets/shot.html
 *
 * Then open it and capture the two panes — see `assets/README.md` for the
 * two-line recipe. The HTML is committed, so the image can always be
 * regenerated from the same source rather than re-staged by hand.
 *
 * **Why a screenshot at all.** The README shows what cutver prints, and it
 * showed it in a monochrome code fence — which is all of the information and
 * none of the design. The output is deliberately coloured: grey for the sentence
 * explaining a row, cyan for the version, red for a `major` because it is the
 * one row that obliges somebody downstream to do work.
 *
 * **Generated, not captured by hand.** A screenshot is the one thing here no
 * test can check — `docs.test.ts` holds every other claim to the code. Building
 * it by running cutver means refreshing it after an output change is one
 * command, and the HTML that produced it sits in the diff.
 *
 * **Two panes, because GitHub serves README images through its own proxy**,
 * which strips the CSS a `prefers-color-scheme` rule inside the image would
 * need. `<picture>` does the choosing instead, so there is a light file and a
 * dark one.
 */
import { $ } from 'bun'

/** GitHub's own light and dark palettes — the image sits inside a GitHub page. */
const THEMES = {
  dark: {
    bg: '#0d1117',
    chrome: '#161b22',
    border: '#30363d',
    fg: '#c9d1d9',
    grey: '#8b949e',
    red: '#ff7b72',
    green: '#7ee787',
    yellow: '#d29922',
    cyan: '#79c0ff',
    title: '#8b949e',
  },
  light: {
    bg: '#ffffff',
    chrome: '#f6f8fa',
    border: '#d0d7de',
    fg: '#24292f',
    grey: '#6e7781',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    cyan: '#0969da',
    title: '#6e7781',
  },
} as const

/** Widened to `string`: the two palettes share keys, not values. */
type Theme = Record<keyof (typeof THEMES)['dark'], string>

interface Run {
  text: string
  colour: keyof Theme
  bold: boolean
  dim: boolean
}

/**
 * ANSI SGR into runs.
 *
 * Only the codes this tool emits — `src/style.ts` is the whole palette.
 * Anything unrecognised resets rather than guessing: a wrong colour here is a
 * claim about the output that is not true.
 */
function parse(line: string): Run[] {
  const runs: Run[] = []
  let colour: keyof Theme = 'fg'
  let bold = false
  let dim = false
  let at = 0

  const SGR = /\x1b\[([0-9;]*)m/g
  let m: RegExpExecArray | null
  const push = (text: string) => {
    if (text) runs.push({ text, colour, bold, dim })
  }

  while ((m = SGR.exec(line))) {
    push(line.slice(at, m.index))
    at = m.index + m[0].length
    for (const code of (m[1] || '0').split(';')) {
      if (code === '1') bold = true
      else if (code === '2') dim = true
      else if (code === '31') colour = 'red'
      else if (code === '32') colour = 'green'
      else if (code === '33') colour = 'yellow'
      else if (code === '36') colour = 'cyan'
      else if (code === '90') colour = 'grey'
      else {
        colour = 'fg'
        bold = false
        dim = false
      }
    }
  }
  push(line.slice(at))
  return runs
}

const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '')

function pane(lines: string[], theme: Theme, name: string): string {
  const body = lines
    .map(line => {
      const spans = parse(line)
        .map(r => {
          const style = [
            `color:${theme[r.colour]}`,
            r.bold ? 'font-weight:600' : '',
            r.dim ? 'opacity:.65' : '',
          ]
            .filter(Boolean)
            .join(';')
          return `<span style="${style}">${esc(r.text)}</span>`
        })
        .join('')
      return spans || '&nbsp;'
    })
    .join('\n')

  return `<div class="win" id="${name}" style="--bg:${theme.bg};--chrome:${theme.chrome};--border:${theme.border};--title:${theme.title}">
  <div class="bar"><i class="d r"></i><i class="d y"></i><i class="d g"></i><span class="t">notes-app — cutver</span></div>
  <pre>${body}</pre>
</div>`
}

// A history that produces every kind of row: a minor, a patch, and a subject
// that counts for nothing. Built here rather than checked in, so the image is
// of cutver actually running.
const dir = `${(process.env.TEMP ?? '/tmp').replaceAll('\\', '/')}/cutver-shot`
await $`rm -rf ${dir}`.nothrow().quiet()
await $`mkdir -p ${dir}`.quiet()

const git = (...args: string[]) => $`git -C ${dir} ${args}`.quiet()
await git('init', '-q', '-b', 'main')
await git('config', 'user.email', 'demo@example.invalid')
await git('config', 'user.name', 'demo')
await Bun.write(`${dir}/package.json`, '{"name":"notes-app","version":"1.2.0"}')
await git('add', '-A')
await git('commit', '-qm', 'feat: the library view')
await git('tag', 'v1.2.0')

for (const subject of [
  'feat: shelves remember their sort order',
  'feat(reader): continuous scroll between chapters',
  'fix: stop the sync loop retrying a deleted note',
  'fix(search): accents no longer split a word',
  'perf: cache the shelf index',
  'wip',
]) {
  await Bun.write(`${dir}/f.txt`, subject)
  await git('add', '-A')
  await git('commit', '-qm', subject)
}

const entry = new URL('../src/cli/index.ts', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
)
const proc = Bun.spawn(
  ['bun', entry, 'stage', '--dry-run', '--offline', '--cwd', dir],
  { env: { ...process.env, FORCE_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' },
)
const [out, err] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
])
await proc.exited

const lines = `${out}${err}`
  .split('\n')
  // The temp directory is where this happened to run; `~/notes-app` is what a
  // reader would see. Cosmetic only — every other character is cutver's.
  .map(l => l.replaceAll(dir, '~/notes-app').replace(/\r$/, ''))
while (lines.length && !strip(lines[lines.length - 1] as string).trim())
  lines.pop()

const html = `<!doctype html>
<meta charset="utf-8">
<title>cutver — terminal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  body { margin: 0; padding: 40px; background: #8b8b8b; display: flex; flex-direction: column; gap: 40px; align-items: flex-start; }
  .win {
    background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
    overflow: hidden; width: max-content; box-shadow: 0 8px 30px rgba(0,0,0,.18);
  }
  .bar {
    height: 34px; background: var(--chrome); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px; padding: 0 13px;
  }
  .d { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
  .r { background: #ff5f57 } .y { background: #febc2e } .g { background: #28c840 }
  .t {
    margin-left: 10px; font-size: 12px; color: var(--title);
    /* Google Sans if this machine has it, and the usual UI stack if not. */
    font-family: "Google Sans", "Google Sans Text", ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  }
  pre {
    margin: 0; padding: 18px 22px 20px;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px; line-height: 1.62; letter-spacing: 0;
    white-space: pre; tab-size: 2;
    /* **Ligatures off, and this is not taste.** JetBrains Mono draws \`--\` as a
       single long dash and \`->\` as an arrow, so \`--offline\` reads as
       \`—offline\` and \`1.2.0 -> 1.3.0\` as \`1.2.0 → 1.3.0\`. Every one of those
       is a flag or a string somebody retypes from the picture. A screenshot
       that renders a command differently from how it must be typed is worse
       than no screenshot. */
    font-variant-ligatures: none;
    font-feature-settings: "liga" 0, "calt" 0;
  }
</style>
${pane(lines, THEMES.dark, 'dark')}
${pane(lines, THEMES.light, 'light')}
`

const asset = (name: string) =>
  new URL(`../assets/${name}`, import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    '$1',
  )

await Bun.write(asset('shot.html'), html)
console.log(`  assets/shot.html  (${lines.length} lines, for previewing)`)

/**
 * The same output as SVG, which is what the README embeds.
 *
 * **Flowing tspans, not pinned ones.** Computing an `x` per span from a fixed
 * advance would draw correctly only in the font it was measured against — and
 * a reader without JetBrains Mono would get every span overlapping the last.
 * Letting them flow means any monospace lays the line out correctly and only
 * the total width changes, so the font stack degrades instead of breaking. It
 * is also why this embeds no font: a few KB of text rather than 160 KB of
 * base64, and nothing to re-subset when a glyph appears.
 */
function svg(theme: Theme): string {
  const cols = Math.max(...lines.map(l => strip(l).length))
  const FONT = 13
  const LINE = FONT * 1.62
  const PAD = 20
  const CHROME = 34
  const w = Math.ceil(cols * FONT * 0.6 + PAD * 2)
  const h = Math.ceil(lines.length * LINE + PAD * 2 + CHROME)

  const rows = lines
    .map((line, i) => {
      const y = (PAD + CHROME + (i + 0.85) * LINE).toFixed(1)
      const spans = parse(line)
        .map(r => {
          const style = [
            `fill:${theme[r.colour]}`,
            r.bold ? 'font-weight:600' : '',
            r.dim ? 'opacity:.65' : '',
          ]
            .filter(Boolean)
            .join(';')
          return `<tspan style="${style}" xml:space="preserve">${esc(r.text)}</tspan>`
        })
        .join('')
      return spans
        ? `<text x="${PAD}" y="${y}" xml:space="preserve">${spans}</text>`
        : ''
    })
    .filter(Boolean)
    .join('\n    ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="cutver stage --dry-run, showing the commit survey and the version it computed">
  <rect width="${w}" height="${h}" rx="10" fill="${theme.bg}" stroke="${theme.border}"/>
  <path d="M0 10a10 10 0 0 1 10-10h${w - 20}a10 10 0 0 1 10 10v${CHROME - 10}H0z" fill="${theme.chrome}"/>
  <line x1="0" y1="${CHROME}" x2="${w}" y2="${CHROME}" stroke="${theme.border}"/>
  <circle cx="19" cy="17" r="5.5" fill="#ff5f57"/>
  <circle cx="38" cy="17" r="5.5" fill="#febc2e"/>
  <circle cx="57" cy="17" r="5.5" fill="#28c840"/>
  <text x="76" y="21" font-family="Google Sans, Google Sans Text, ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif" font-size="11.5" fill="${theme.title}">notes-app — cutver</text>
  <g font-family="JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FONT}" style="font-variant-ligatures:none;font-feature-settings:'liga' 0,'calt' 0">
    ${rows}
  </g>
</svg>
`
}

for (const [name, theme] of Object.entries(THEMES)) {
  await Bun.write(asset(`terminal-${name}.svg`), svg(theme))
  console.log(`  assets/terminal-${name}.svg`)
}
