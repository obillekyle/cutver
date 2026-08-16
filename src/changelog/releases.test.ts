import { afterEach, describe, expect, test } from 'bun:test'
import { isUnauthored, tokenFor, updateRelease } from './releases'

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

/**
 * `updateRelease` against a stubbed GitHub.
 *
 * The two properties worth pinning are the ones that cost something when they
 * are wrong: a body somebody wrote must survive without `--force`, and
 * producing the new body — a model call, on a repository with a summariser —
 * must not happen for a release that was never eligible.
 */
describe('updateRelease', () => {
  const real = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = real
  })

  /** Answers the tag lookup with `body`, and records every PATCH. */
  function stub(body: string | null): { patched: string[] } {
    const patched: string[] = []
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patched.push(JSON.parse(String(init.body)).body)
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify({ id: 7, body }), { status: 200 })
    }) as unknown as typeof fetch

    return { patched }
  }

  test('a written body is left alone, and costs no summary', async () => {
    stub('Heads up: this one changes the config format.')
    let produced = 0
    const result = await updateRelease(
      'o/r',
      't',
      'v1.2.0',
      async () => {
        produced++
        return 'compiled'
      },
      false,
    )

    expect(result.state).toBe('skipped')
    // The point of the thunk: twenty skipped pages are twenty model calls if
    // the body is produced before the decision.
    expect(produced).toBe(0)
  })

  test('--force replaces it, and says so', async () => {
    const { patched } = stub('Heads up: this one changes the config format.')
    const result = await updateRelease(
      'o/r',
      't',
      'v1.2.0',
      'compiled',
      false,
      true,
    )

    expect(result.state).toBe('updated')
    expect(result.detail).toBe('replaced a written body')
    expect(patched).toEqual(['compiled'])
  })

  test('an empty body is filled in without the flag', async () => {
    const { patched } = stub('')
    const result = await updateRelease('o/r', 't', 'v1.2.0', 'compiled', false)

    expect(result.state).toBe('updated')
    expect(result.detail).toBe('was empty')
    expect(patched).toEqual(['compiled'])
  })

  test('a dry run writes nothing, costs nothing, and flags the destructive case', async () => {
    const { patched } = stub('Heads up: this one changes the config format.')
    let produced = 0
    const result = await updateRelease(
      'o/r',
      't',
      'v1.2.0',
      async () => {
        produced++
        return 'compiled'
      },
      true,
      true,
    )

    expect(result.detail).toContain('WRITTEN')
    expect(patched).toEqual([])
    // A preview nobody expects to be billed for.
    expect(produced).toBe(0)
  })

  test('a body that already matches is not rewritten', async () => {
    const { patched } = stub('compiled')
    const result = await updateRelease('o/r', 't', 'v1.2.0', 'compiled', false)

    expect(result.state).toBe('unchanged')
    expect(patched).toEqual([])
  })

  test('a tag with no release is a row, not a throw', async () => {
    globalThis.fetch = (async () =>
      new Response('{}', { status: 404 })) as unknown as typeof fetch

    const result = await updateRelease('o/r', 't', 'v9.9.9', 'compiled', false)
    expect(result.state).toBe('missing')
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
