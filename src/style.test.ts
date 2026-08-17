import { describe, expect, test } from 'bun:test'
import { coloured, esc, pad, plain, style } from './style'

/**
 * The markers, and the two ways they go wrong.
 *
 * **A marker that survives to the screen is worse than no colour at all** —
 * `%g↑%0 package.json` in a release body is a corrupted artefact, and this
 * tool's output is redirected into files by every workflow it generates. So
 * the question each case asks is not "does it colour" but "is the marker
 * gone", which is true whether colour is on or off.
 *
 * The suite runs with stdout piped, so `coloured` is false here and `style`
 * strips. That is the half worth testing hardest: it is the half that runs in
 * CI, in a pipe, and in every generated workflow.
 */
describe('style', () => {
  test('the suite is running with colour off', () => {
    // A guard on the guard: every expectation below reads differently if this
    // is ever true, and a test that silently changes meaning is worse than one
    // that fails.
    expect(coloured).toBe(false)
  })

  test('strips both spellings of a marker', () => {
    expect(style('%g↑%0 done')).toBe('↑ done')
    expect(style('%<green>↑%<reset> done')).toBe('↑ done')
  })

  test('%% is a literal percent', () => {
    // Otherwise a summary mentioning "100%" would lose a character, or worse
    // consume the letter after it as a colour name.
    expect(style('100%% done')).toBe('100% done')
    expect(plain('100%% done')).toBe('100% done')
  })

  test('an unknown marker is left visible', () => {
    // A typo should be seen, not swallowed. `%<yelow>` disappearing silently
    // is how a line ends up half-coloured with nobody knowing why.
    expect(style('%<yelow>careful%0')).toBe('%<yelow>careful')
  })

  test('esc survives every marker this module knows', () => {
    // **Measured, and shipped for one release.** A commit subject reading
    // `100%done and 50%green` printed as `100one and 50reen` — `%d` and `%g`
    // eaten as colour markers, taking the letter after them. Under `NO_COLOR`
    // too, because `plain` strips known markers whether or not codes are
    // emitted, so the bug was not a colour bug.
    //
    // Every marker is exercised rather than a couple: the failure was not
    // "`%d` is special", it was "any letter can be", and a test naming two of
    // them would pass while a third stayed broken.
    const hazards = [
      '100%done and 50%green',
      '%r%g%b%c%m%y%w%0',
      'feat/100%done',
      '%<bold>not a marker%<reset>',
      'a literal %% pair',
      '%',
    ]
    for (const raw of hazards) {
      expect(plain(esc(raw)), raw).toBe(raw)
      // And with codes on, the text is unchanged once the codes are stripped —
      // which is what `plain` measures and what alignment depends on.
      expect(style(esc(raw)).replace(/\x1b\[[0-9;]*m/g, ''), raw).toBe(raw)
    }
  })

  test('esc keeps a padded column honest', () => {
    // An escaped `%` is two characters and one column. `padEnd` on the escaped
    // string would indent every row below a path containing one.
    //
    // Asserted on `pad`'s output directly — it has already expanded, and
    // running `plain` over it again would strip the `%d` this is about.
    expect(pad(esc('a%db'), 8)).toBe('a%db    ')
    expect(pad(esc('a%db'), 8)).toHaveLength(8)
  })

  test('nothing that looks like a marker survives a real message', () => {
    const line = '%g+%0 v1.2.0  %dcreated%0'
    expect(style(line)).not.toContain('%')
    expect(style(line)).toBe('+ v1.2.0  created')
  })
})

describe('pad', () => {
  test('measures what will be on screen, not the markers', () => {
    // The bug this exists to prevent: `padEnd` on a marked string counts the
    // markers, so a report lines up only when colour is off.
    expect(pad('%g✓%0', 4)).toBe('✓   ')
    expect(plain(pad('%g✓%0', 4))).toHaveLength(4)
  })

  test('a string already at width is untouched', () => {
    expect(pad('abcd', 4)).toBe('abcd')
    expect(pad('abcdef', 4)).toBe('abcdef')
  })

  test('columns line up across styled and unstyled labels', () => {
    const rows = ['%c--dry-run%0', '--force', '%<bold>--cwd%0']
    const width = Math.max(...rows.map(r => plain(r).length))
    const padded = rows.map(r => `${pad(r, width)}|`)

    expect(padded.map(p => plain(p).length)).toEqual([
      width + 1,
      width + 1,
      width + 1,
    ])
  })
})
