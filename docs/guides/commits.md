# Writing the commits

cutver reads nothing else. Not a changelog fragment, not a label on a pull
request, not a file you remember to edit — the commit messages are the entire
input, and everything downstream is a rendering of them.

Which means the commit message is the artifact. A thin body reads exactly as
thin as it is, in public, on the release page. That is the incentive pointing
the right way.

## The subject decides the version

```
feat(cli): add a --json flag
^^^^ ^^^     ^
type scope   description
```

Only the type matters to the number:

| subject | bump |
| --- | --- |
| `fix: …` | patch |
| `feat: …` | minor |
| `feat!: …`, `fix!: …` | major |
| `BREAKING CHANGE:` in the body | major |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:`, `build:`, `perf:`, `style:` | none |
| anything else | none |

The **strongest** bump in the range wins. One `feat!` among forty `fix`
commits is a major.

Both breaking markers count and they are equivalent — `feat!:` in the subject,
or a `BREAKING CHANGE:` paragraph in the body. Use the `!` for something a
reader should see in `git log --oneline`; use the footer when the change needs
a paragraph to explain. A commit carrying both is one breaking change, not two.

> **A breaking commit lands under Breaking Changes and nowhere else.** A `feat!`
> is not also listed under New Features — listed twice it reads as two changes
> to anyone skimming.

## Nothing unrecognised is guessed at

`Fix: capitalised`, `fixed the thing`, `wip`, `updates` — none of these are
conventional commits, and cutver treats them as contributing nothing. They
raise no version and they appear in no changelog section.

That is deliberate. Guessing that `updates` was a feature would put a wrong
number on a tag that can never be reused. But it is also **silent**, and a
repository where half the history looks like that gets a patch bump and a thin
changelog with nothing on screen connecting the two.

So cutver counts them and says so:

```
cutver: 12 commit(s) since v1.4.0
  patch 3
        fix: the thing
  none  6 not conventional — no version, no changelog entry
        wip
        more work
        addressing review
        … and 3 more
```

`cutver doctor` reports the same count. Merge and revert commits are excluded
from it — they are not authored changes, every merge workflow produces them,
and counting them would make the warning permanent noise.

Nothing is refused over this. It is a number on a screen, and what to do about
it is yours.

## The scope is a label, not a namespace

```
feat(cli): …      →  - **cli:** …
feat: …           →  - …
```

Anything in parentheses becomes a bold prefix on the changelog entry. It is
free-form: cutver validates nothing and keeps no list. Use it when a reader
scanning the section would want to know *which part* changed, and leave it off
when the description already says.

## The body is the release note

**This is the part that is specific to cutver.** With `changelog:` set, the
first paragraph of the body becomes the entry under the subject line:

```
fix(dashboard): charts stopped growing past 100 points

The series was capped by a constant that predates the streaming rewrite, so
anything past the first hundred samples was silently dropped rather than
rendered.

Found by a customer whose graph flatlined at exactly 100. The cap has no
remaining purpose — the renderer decimates on its own now.
```

becomes

> ### Fixes
> - **dashboard:** charts stopped growing past 100 points ([a1b2c3d](#))
>
>     The series was capped by a constant that predates the streaming rewrite,
>     so anything past the first hundred samples was silently dropped rather
>     than rendered.

The **first paragraph only** — the thesis. Later paragraphs are why it is
convincing, and they belong in `git show` rather than in a file people skim.

One exception: a paragraph ending in a colon brings what it introduces along,
so a body that leads into a snippet does not end mid-sentence.

### Writing one worth publishing

- **State what changed and what it cost.** "Fixed a bug" is a subject with no
  body. What broke, for whom, and why it broke are the release note.
- **Lead with the thesis.** The first paragraph is the one that ships; put the
  conclusion in it and the evidence after.
- **No second person and no discussion.** "As requested", "thanks for
  catching this", "you were right" — the commit is read by people with no
  access to the conversation that produced it, and it dates instantly.
- **Put the measurement in.** A number in a commit body is a number anyone can
  re-derive later. A number only in a pull request comment is gone.

## Several changes in one commit

A body that describes more than one change can produce more than one entry —
but only when the [summariser](changelog.md#summarising-the-release-body) is
on, and only on the **GitHub release body**. `CHANGELOG.md` always renders one
entry per commit, because the file is the record and one commit is one row of
it.

Where you have the choice, separate commits are still better: they can be
reverted independently, they bisect, and each gets its own line without
anything having to infer where one change ends.

## Commits cutver ignores on purpose

- **The release commit.** `chore(release): v1.4.0` announces the version the
  reader is already looking at.
- **Merges and reverts.** Not authored changes.

## Where to go next

- [How the number is chosen](versions.md) — the ranges, the baseline, and what
  happens with no tags
- [Changelogs](changelog.md) — compiling the file, and handing the release body
  to a model
- [Alphas, betas and RCs](channels.md) — cutting a prerelease from these same
  commits
