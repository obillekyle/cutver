/**
 * Colour, written into the string as `%<green>` or `%g`.
 *
 * **The same convention bakery's logger uses**, deliberately: the two projects
 * are read by the same person, and a second spelling for one idea is a second
 * thing to remember. `%<name>` and the one-letter aliases below are that
 * spelling, `%0` resets, and `%%` is a literal percent.
 *
 * Markers in the message rather than functions around it, because most lines
 * here are assembled once and printed once. `` `%g↑%0 ${file}` `` reads as the
 * line it produces; `green('↑') + ' ' + file` reads as a sentence about
 * producing it.
 *
 * Three questions decide whether anything is emitted at all.
 *
 * **Is anyone looking?** Half of what this tool prints is not for a person.
 * `cutver notes` writes a release body that a workflow redirects into a file
 * and hands to `gh release create`; `config` prints JSON that cutver reads
 * back; `completions` prints a shell script that gets sourced. An escape code
 * in any of those is a corrupted artefact, so colour is off unless the stream
 * is a terminal — and the markers are stripped either way, never printed.
 *
 * **Has anyone said not to?** `NO_COLOR` is the convention and costs a line.
 * `FORCE_COLOR` is the other direction, for a CI log viewer that renders codes
 * and reports no TTY.
 *
 * **Does it survive being counted?** Every aligned column here pads to a
 * width, and both `%g` and `\x1b[32m` count as characters that are not on
 * screen. `pad` measures the plain text; nothing else should call `padEnd` on
 * a string that has been through here.
 */
const env = process.env

/** `%<name>` or `%c`, with `%%` for a literal percent. */
const MARKER = /%<([a-zA-Z0-9]+)>|%([a-zA-Z0-9*%])/g

const CODES: Record<string, string> = {
  r: '\x1b[31m',
  g: '\x1b[32m',
  y: '\x1b[33m',
  b: '\x1b[34m',
  m: '\x1b[35m',
  c: '\x1b[36m',
  w: '\x1b[37m',
  d: '\x1b[90m',
  '*': '\x1b[0m',
  '0': '\x1b[0m',

  // Bold is not a colour, and it is the one attribute this CLI wants for a
  // heading. `%<bold>` … `%0` rather than a one-letter alias, because `b` is
  // already blue in the shared table and quietly meaning something else here
  // is how the two projects would drift.
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  reset: '\x1b[0m',
}

/**
 * Whether anything here emits codes.
 *
 * Read once at startup: a property lookup per line is not the cost, a colour
 * decision that changes halfway down a report is.
 */
export const coloured: boolean = (() => {
  // The convention is that any value at all means no, including empty.
  if (env.NO_COLOR !== undefined) return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true
  if (env.TERM === 'dumb') return false
  return Boolean(process.stdout.isTTY)
})()

/** Expand the markers, or strip them. Never leaves one on screen. */
export function style(text: string): string {
  return text.replace(MARKER, (match, long: string, short: string) => {
    if (short === '%') return '%'
    const code = CODES[long ?? short]
    // An unknown marker is left as written rather than swallowed: a typo in
    // `%<yelow>` should be visible, not invisible.
    if (code === undefined) return match
    return coloured ? code : ''
  })
}

/** The text as it will appear, markers removed — what a width is measured in. */
export function plain(text: string): string {
  return text.replace(MARKER, (match, long: string, short: string) => {
    if (short === '%') return '%'
    return CODES[long ?? short] === undefined ? match : ''
  })
}

/** Pad to `width` by what will be on screen, then expand. */
export function pad(text: string, width: number): string {
  return style(text) + ' '.repeat(Math.max(0, width - plain(text).length))
}

/** `console.log`, with the markers dealt with. */
export function say(text = ''): void {
  console.log(style(text))
}

/** The same, to stderr — where every refusal and every warning goes. */
export function warn(text: string): void {
  console.error(style(text))
}
