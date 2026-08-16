import { describe, expect, test } from 'bun:test'
import { isUnauthored, tokenFor } from './releases'

/**
 * The one rule that must not be wrong.
 *
 * A release body is published prose and GitHub keeps no history of it, so a
 * false positive here destroys something that cannot be recovered. Every case
 * below is written from that direction: the question is never "does this look
 * replaceable", it is "can we prove nobody wrote it".
 */
describe('isUnauthored', () => {
  test('nothing at all', () => {
    expect(isUnauthored('', 'v1.2.0')).toBe(true)
    expect(isUnauthored(null, 'v1.2.0')).toBe(true)
    expect(isUnauthored('   \n\n  ', 'v1.2.0')).toBe(true)
  })

  test('the version repeated back', () => {
    // What a script that had to put *something* in the field produces.
    expect(isUnauthored('v1.2.0', 'v1.2.0')).toBe(true)
    expect(isUnauthored('1.2.0', 'v1.2.0')).toBe(true)
    expect(isUnauthored('# v1.2.0', 'v1.2.0')).toBe(true)
  })

  test("GitHub's own generated notes", () => {
    // Exactly what `--generate-notes` writes, which is the thing this command
    // exists to replace.
    const generated = [
      "## What's Changed",
      '* feat: a thing by @someone in https://github.com/o/r/pull/1',
      '* fix: another by @someone in https://github.com/o/r/pull/2',
      '',
      '## New Contributors',
      '* @someone made their first contribution',
      '',
      '**Full Changelog**: https://github.com/o/r/compare/v1.1.0...v1.2.0',
    ].join('\n')
    expect(isUnauthored(generated, 'v1.2.0')).toBe(true)
  })

  test('anything a person wrote is left alone', () => {
    expect(isUnauthored('This release fixes the sync bug.', 'v1.2.0')).toBe(
      false,
    )
    expect(
      isUnauthored('### Fixes\n\n- charts stopped growing', 'v1.2.0'),
    ).toBe(false)
  })

  test('a paragraph above generated notes protects the whole body', () => {
    // **The case that decides the shape of the check.** Someone who wrote a
    // sentence above GitHub's list wrote that sentence, and replacing the body
    // would take it with them — so a body that merely *contains* a generated
    // block is authored, not generated.
    const mixed = [
      'Heads up: this one changes the config format.',
      '',
      "## What's Changed",
      '* feat: a thing by @someone in https://github.com/o/r/pull/1',
      '',
      '**Full Changelog**: https://github.com/o/r/compare/v1.1.0...v1.2.0',
    ].join('\n')
    expect(isUnauthored(mixed, 'v1.2.0')).toBe(false)
  })

  test('a version that is not this tag is not a version marker', () => {
    // `1.1.0` in `v1.2.0`'s body is somebody referring to another release, not
    // a placeholder for this one.
    expect(isUnauthored('1.1.0', 'v1.2.0')).toBe(false)
  })
})

describe('tokenFor', () => {
  test('prefers GH_TOKEN, falls back to GITHUB_TOKEN', () => {
    // `GITHUB_TOKEN` is present in every Actions run without being asked for;
    // `GH_TOKEN` is what `gh auth` exports, so a person overriding locally wins.
    expect(tokenFor({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' })).toBe('a')
    expect(tokenFor({ GITHUB_TOKEN: 'b' })).toBe('b')
    expect(tokenFor({})).toBeNull()
    expect(tokenFor({ GH_TOKEN: '   ' })).toBeNull()
  })
})
