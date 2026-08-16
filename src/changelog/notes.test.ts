import { describe, expect, test } from 'bun:test'
import {
  diffLine,
  entryOf,
  rawCommits,
  renderNotes,
  sectionOf,
  DEFAULT_SECTIONS,
} from './notes'

const c = (subject: string, body = '') => ({ subject, body })

describe('sectionOf', () => {
  test('routes the ordinary types', () => {
    expect(sectionOf(c('feat: a'))).toBe('feat')
    expect(sectionOf(c('fix(scope): a'))).toBe('fix')
    expect(sectionOf(c('docs: a'))).toBe('docs')
    expect(sectionOf(c('refactor: a'))).toBe('refactor')
  })

  test('a breaking commit lands in breaking and nowhere else', () => {
    // Both markers, the same way `classify` reads them — and a `feat!` must not
    // also appear under New Features. Listed twice it reads as two changes to
    // anyone skimming, which is the opposite of what the section is for.
    expect(sectionOf(c('feat!: a'))).toBe('breaking')
    expect(sectionOf(c('fix: a', 'BREAKING CHANGE: b'))).toBe('breaking')
    expect(sectionOf(c('release: a'))).toBe('breaking')
  })

  test('a subject that is not a conventional commit belongs nowhere', () => {
    expect(sectionOf(c('Merge branch x'))).toBeNull()
    expect(sectionOf(c('wip'))).toBeNull()
  })
})

describe('entryOf', () => {
  test('splits the scope off and keeps the rest as the title', () => {
    expect(entryOf(c('fix(dashboard): charts stopped growing'))).toEqual({
      scope: 'dashboard',
      title: 'charts stopped growing',
      lead: null,
      sha: null,
    })
  })

  test('carries the sha when the commit has one', () => {
    // `Commit` has no sha — it lives in `version-from-commits.ts`, which is a
    // verbatim port. `commitsIn` returns the extended shape, and `entryOf`
    // takes it when it is there rather than requiring it.
    expect(entryOf({ sha: 'a1b2c3d', subject: 'fix: a', body: '' })?.sha).toBe(
      'a1b2c3d',
    )
    expect(entryOf(c('fix: a'))?.sha).toBeNull()
  })

  test('takes the first paragraph of the body, joined into one line', () => {
    // The thesis, not the evidence. A body's later paragraphs are why it is
    // convincing; they belong in `git show` rather than in a file people skim.
    const entry = entryOf(
      c(
        'feat: a',
        'The first paragraph\nwraps across lines.\n\nThe second is evidence.',
      ),
    )
    expect(entry?.lead).toBe('The first paragraph wraps across lines.')
  })

  test('a commit with no body contributes its subject alone', () => {
    expect(entryOf(c('feat: a'))?.lead).toBeNull()
  })

  test('a paragraph ending in a colon brings what it introduces', () => {
    // Stopping at the blank line leaves the entry dangling — "could not copy a
    // binary that was sitting right there:" and then nothing. Measured on this
    // project's own history, where bodies routinely lead into a snippet.
    const entry = entryOf(
      c(
        'fix: a',
        'It failed like this:\n\n    cp: cannot stat …\n\nMore prose.',
      ),
    )
    expect(entry?.lead).toContain('It failed like this:')
    expect(entry?.lead).toContain('cp: cannot stat')
    // Only the one paragraph it introduced, not the rest of the body.
    expect(entry?.lead).not.toContain('More prose')
  })

  test('an ordinary paragraph still stops at the blank line', () => {
    const entry = entryOf(c('fix: a', 'The thesis.\n\nThe evidence.'))
    expect(entry?.lead).toBe('The thesis.')
  })

  test('CRLF bodies do not leave a carriage return in the markdown', () => {
    // Fourth time this shape has come up in this project. A stray `\r` inside a
    // bullet renders as a broken line rather than as nothing.
    const entry = entryOf(c('feat: a', 'first\r\nline\r\n\r\nsecond'))
    expect(entry?.lead).toBe('first line')
    expect(entry?.lead).not.toContain('\r')
  })
})

describe('renderNotes', () => {
  const commits = [
    c('feat!: the big one', 'Why it breaks.'),
    c('feat(cli): a new flag'),
    c('fix: a real bug', 'What it cost.'),
    c('chore: tidy'),
    c('Merge branch x'),
    c('chore(release): v1.0.0'),
  ]

  test('groups by section in the configured order', () => {
    const md = renderNotes({ commits, sections: [...DEFAULT_SECTIONS] })
    const order = [...md.matchAll(/^### (.+)$/gm)].map(m => m[1])

    // Breaking first, because it is the only section a reader must not miss.
    expect(order).toEqual(['Breaking Changes', 'New Features', 'Fixes'])
    expect(md).toContain('**cli:** a new flag')
    expect(md).toContain('Why it breaks.')
  })

  test('honours a different order and a narrower set', () => {
    const md = renderNotes({ commits, sections: ['fix', 'breaking'] })
    const order = [...md.matchAll(/^### (.+)$/gm)].map(m => m[1])

    expect(order).toEqual(['Fixes', 'Breaking Changes'])
    expect(md).not.toContain('New Features')
  })

  test('skips the release commit and anything unconventional', () => {
    const md = renderNotes({ commits, sections: Object.keys({ chore: 1 }) })
    // `chore: tidy` is in, `chore(release): v1.0.0` is not — it announces the
    // version the reader is already looking at.
    expect(md).toContain('tidy')
    expect(md).not.toContain('v1.0.0')
    expect(md).not.toContain('Merge branch')
  })

  test('renders nothing at all when no commit belongs in a section', () => {
    // Not even the diff line: a heading followed only by a range is a section
    // that looks written and is not.
    expect(
      renderNotes({
        commits: [c('chore: tidy')],
        sections: ['feat'],
        range: { from: 'aaa', to: 'bbb' },
      }),
    ).toBe('')
  })

  test('puts the diff line above the first section', () => {
    const md = renderNotes({
      commits,
      sections: ['fix'],
      range: { from: 'aaa1111', to: 'bbb2222', repo: 'github.com/o/r' },
    })
    // Present before ordered: a missing `diff:` indexes to -1 and would pass
    // this comparison while proving the opposite.
    expect(md).toContain('diff:')
    expect(md).toContain('### Fixes')
    expect(md.indexOf('diff:')).toBeLessThan(md.indexOf('### Fixes'))
  })
})

describe('rawCommits', () => {
  const commits = [
    {
      sha: 'ccc3333',
      ...c('fix(changelog): a real bug', 'What it cost.\n\nAnd the evidence.'),
    },
    { sha: 'aaa1111', ...c('feat(cli): a new flag', 'Why it exists.') },
    { sha: 'bbb2222', ...c('chore: tidy') },
    { sha: 'ddd4444', ...c('chore(release): v1.0.0') },
  ]
  const sections = [...DEFAULT_SECTIONS]

  test('states the section per commit rather than leaving it to be derived', () => {
    // **The line that made classification reliable, and it had no test.** Asked
    // to read the type off the subject, a model filed the same `fix(…)` commit
    // under New Features four runs running. Found by mutation: deleting this
    // label from the renderer left the whole suite green.
    const raw = rawCommits({ commits, sections })

    expect(raw).toContain('section: Fixes')
    expect(raw).toContain('section: New Features')
    // Attached to the right commit, not merely present somewhere.
    expect(raw).toMatch(/ccc3333\nsection: Fixes\nfix\(changelog\)/)
    expect(raw).toMatch(/aaa1111\nsection: New Features\nfeat\(cli\)/)
  })

  test('groups commits in the configured section order', () => {
    // Belt and braces with the label: arriving in heading order means emitting
    // them in the order they are read is already correct.
    const raw = rawCommits({ commits, sections })
    const order = [...raw.matchAll(/^section: (.+)$/gm)].map(m => m[1])
    expect(order).toEqual(['New Features', 'Fixes'])
  })

  test('carries the body verbatim, not flattened', () => {
    // Paragraphs are how a multi-change body separates its changes; joining it
    // onto one line would destroy exactly what makes it splittable.
    const raw = rawCommits({ commits, sections })
    expect(raw).toContain('What it cost.\n\nAnd the evidence.')
  })

  test('skips the release commit and anything outside the sections', () => {
    const raw = rawCommits({ commits, sections })
    expect(raw).not.toContain('v1.0.0')
    expect(raw).not.toContain('tidy')
  })

  test('separates commits with a rule, and carries no diff line', () => {
    // The `diff:` line is a fact to copy through, so it travels in `<metadata>`
    // — mixing it in here once produced a `---` with nothing above it.
    const raw = rawCommits({ commits, sections })
    expect(raw.split('\n---\n')).toHaveLength(2)
    expect(raw).not.toContain('diff:')
  })

  test('nothing to say renders as nothing', () => {
    expect(
      rawCommits({ commits: [c('chore: tidy')], sections: ['feat'] }),
    ).toBe('')
  })
})

describe('diffLine', () => {
  test('links a github remote', () => {
    expect(
      diffLine({ from: 'a1b2c3', to: 'd4e5f6', repo: 'github.com/o/r' }),
    ).toBe(
      'diff: [a1b2c3...d4e5f6](https://github.com/o/r/compare/a1b2c3...d4e5f6)',
    )
  })

  test('stays plain text for anything else', () => {
    // gitlab uses `/-/compare`, gitea differs again. A link built from the
    // wrong template looks checkable and is not — worse than the bare range,
    // which anyone can paste into `git diff`.
    expect(
      diffLine({ from: 'a1b2c3', to: 'd4e5f6', repo: 'gitlab.com/o/r' }),
    ).toBe('diff: a1b2c3...d4e5f6')
    expect(diffLine({ from: 'a1b2c3', to: 'd4e5f6', repo: null })).toBe(
      'diff: a1b2c3...d4e5f6',
    )
  })
})
