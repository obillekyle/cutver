/**
 * Line endings and indentation, treated as data rather than as noise.
 *
 * cutver rewrites files it did not create, in repositories it knows nothing
 * about, and every one of them belongs to someone with an opinion about how it
 * is formatted. A release tool that also reindents `package.json` or flips a
 * Windows-authored `Cargo.toml` to LF turns a one-line version bump into a
 * whole-file diff, and the actual change — the number — becomes the hardest
 * thing to find in the review.
 *
 * It is not only cosmetic. `Cargo.toml` in the repository this was written for
 * is CRLF, and a parser that treats `\r` as part of the value hands back
 * `"0.1.0\r"`; that string went on to name a directory, which on Windows is
 * not a name at all. Every function here exists because a line ending got
 * somewhere it should not have.
 */

/**
 * Escape a string so it is a literal inside a regex.
 *
 * Both callers are in `config/`, and both are feeding user-supplied text into
 * `new RegExp` — a branch pattern and a config key. Written out twice, the two
 * character classes could drift apart, and the one that lost a character would
 * be the one that stopped treating a `.` as a `.`.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The dominant line ending, for writing a file back the way it arrived. */
export function detectEol(text: string): '\r\n' | '\n' {
  // A file with *any* CRLF is treated as a CRLF file. Mixed endings are
  // already a mess, and the mess is not this tool's to clean up — the only
  // thing that matters is that the line it adds looks like its neighbours.
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Re-line a block of generated text so it matches the file it is going into. */
export function withEol(text: string, eol: '\r\n' | '\n'): string {
  const normalised = text.replace(/\r\n/g, '\n')
  return eol === '\n' ? normalised : normalised.replace(/\n/g, '\r\n')
}

/**
 * The indent string a JSON document uses, as `JSON.stringify`'s third argument.
 *
 * Reads the first indented line rather than guessing two spaces. npm's own
 * tooling does the same thing, and for the same reason: four-space and tabbed
 * manifests are common enough that reformatting them would be a routine
 * annoyance rather than an edge case.
 */
export function detectIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text)
  const indent = m?.[1]
  if (!indent) return 2
  return indent.includes('\t') ? '\t' : indent.length
}
