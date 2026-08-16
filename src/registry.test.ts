import { describe, expect, test } from 'bun:test'
import { detectOidc, normaliseRepo, repositoryMatches } from './registry'

describe('repository matching', () => {
  test('the many spellings of one repository are one repository', () => {
    const forms = [
      'git+https://github.com/obillekyle/cutver.git',
      'https://github.com/obillekyle/cutver',
      'git@github.com:obillekyle/cutver.git',
      'ssh://git@github.com/obillekyle/cutver.git',
      'github:obillekyle/cutver',
      'https://github.com/obillekyle/cutver/',
    ]
    for (const f of forms)
      expect(normaliseRepo(f)).toBe('github.com/obillekyle/cutver')
  })

  test('a missing repository does not match a real remote', () => {
    // The exact failure: npm normalises the absent field to "" and reports it
    // as a mismatch against the provenance statement, so the error reads like
    // a disagreement rather than a missing key.
    expect(
      repositoryMatches(null, 'https://github.com/obillekyle/cutver'),
    ).toBe(false)
    expect(repositoryMatches('', 'https://github.com/obillekyle/cutver')).toBe(
      false,
    )
  })

  test('a stale repository does not match either', () => {
    // The half that auto-filling the field could never fix.
    expect(
      repositoryMatches(
        'git+https://github.com/someone/template.git',
        'git@github.com:obillekyle/cutver.git',
      ),
    ).toBe(false)
  })

  test('no remote means nothing to disagree with', () => {
    // A fresh `git init`, or a mirror. Reporting a mismatch against nothing
    // would be noise on every local release.
    expect(repositoryMatches(null, null)).toBe(true)
    expect(repositoryMatches('github:o/c', null)).toBe(true)
  })
})

/**
 * No network here on purpose. `checkRegistry` is one `fetch` per package and a
 * status-code check; a test for it would either hit npm for real — slow,
 * flaky, and different depending on who is publishing what — or assert that a
 * mock returns what the mock was told to return.
 *
 * `detectOidc` is the part with actual logic, and its middle case is a real
 * failure people hit.
 */
describe('detectOidc', () => {
  test('available when the Actions token endpoint is present', () => {
    expect(
      detectOidc({
        GITHUB_ACTIONS: 'true',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'xxx',
      }),
    ).toMatchObject({ available: true, ci: true })
  })

  test('names the missing permission when in Actions without the endpoint', () => {
    // The case worth detecting. A workflow missing `permissions: id-token:
    // write` still runs, still installs, still packs, and then fails at
    // publish with an error about *credentials* — sending you to look for a
    // token, which is the exact thing trusted publishing exists to not need.
    const status = detectOidc({ GITHUB_ACTIONS: 'true' })
    expect(status).toMatchObject({ available: false, ci: true })
    expect(status.detail).toContain('id-token: write')
  })

  test('says so plainly off CI', () => {
    expect(detectOidc({})).toMatchObject({ available: false, ci: false })
  })

  test('an endpoint without its token is not OIDC', () => {
    // Both halves are needed to mint one. Reporting "available" on the URL
    // alone would promise an authentication that cannot happen.
    expect(
      detectOidc({
        GITHUB_ACTIONS: 'true',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/',
      }),
    ).toMatchObject({ available: false, ci: true })
  })
})
