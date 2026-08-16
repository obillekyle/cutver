# Changelogs

If your repository has a `CHANGELOG.md` with a `## [Unreleased]` heading,
cutver rolls it:

```markdown
## [Unreleased]

- something
```

becomes

```markdown
## [Unreleased]

## [1.3.0] — 2026-08-14

- something
```

A fresh `## [Unreleased]` stays at the top, your notes move down under a dated
heading, and the rest of the file is untouched. That is the whole feature.

## It writes no notes

Every other tool in this space generates release notes by listing commit
subjects. cutver deliberately does not, and it is worth being clear that this
is a decision rather than a gap.

A changelog worth reading explains *why* things are the way they are: which
limitation is deliberate, what a fix cost, what was reversed and what replaced
it. No generator produces that from a subject line. What it produces is a
second, worse copy of `git log` — and once that copy exists, nobody writes the
first kind any more.

The version number is mechanical and worth automating. The prose is the actual
work. cutver opens the heading and gets out of the way.

## Compiling it instead

Unless you ask it to, and the argument above is narrower than it first looks.

```yaml
changelog: true
```

**cutver then owns `CHANGELOG.md` and rewrites it whole on every release.** No
`## [Unreleased]`, no hand-written prose — edits to the file do not survive.

What makes generated notes worthless is **subject lines**. `fix: stuff` under a
heading tells a reader nothing `git log` would not. A commit **body** is a
different thing: a body that explains why a limitation is deliberate, what a fix
cost, what was reversed is release-note prose already, written when the author
had the context. So each entry is the subject plus **the first paragraph of the
body** — the thesis; the rest is evidence and belongs in `git show`.

A commit with no body contributes its subject alone and reads exactly as thin as
it is. That is honest, and it is its own argument for writing one.

```markdown
## [1.3.0] — 2026-08-15

diff: [8aadce9...91d1a5f](https://github.com/o/r/compare/8aadce9...91d1a5f)

### New Features

- **init:** name the matrix rows that will need a setup step ([4ccf863](https://github.com/o/r/commit/4ccf863))

    cutver knows which binaries a cargo workspace declares. It cannot know what
    they link against, because the thing that stops a build is a system library
    and system libraries appear in no manifest.
```

The sha trails the subject rather than leading it: the change is what a reader
is scanning for, and the reference is what they reach for once one entry has
already caught their eye. Linked on GitHub remotes and bare text everywhere
else — same rule as the `diff:` line, and for the same reason.

### Why it rewrites rather than edits

This is the part worth understanding before turning it on.

A mode that *edited* the file would have to parse it — find a marker, work out
where a section ends, decide what to trim. Every one of those steps is a way for
a changelog nobody has read in a year to break a release, and the failure lands
at the worst moment, mid-release, on a file nobody was thinking about.

Rewriting reads nothing. A malformed, truncated or hand-mangled changelog costs
exactly nothing, because it is replaced. Editing someone else's document safely
and rewriting your own are different jobs, and doing both at once gets the worst
of each.

The trade is real and worth stating: a regenerated changelog can only describe
what is **still in the history**. Squash a branch or rewrite a tag and what an
old release says changes with it. The git tags and the GitHub release pages are
the durable record; this file is a view of them.

### Choosing the sections, and how many releases to keep

```yaml
changelog:
  sections: [breaking, feat, fix]
  keep: 10
```

`true` is shorthand for `breaking`, `feat`, `fix`, `perf`, `refactor`, `docs`,
keeping 10 releases. A bare list sets the sections and keeps the default 10.

| | |
| --- | --- |
| `breaking` | **Breaking Changes** — `!` or a `BREAKING CHANGE:` footer, from any type |
| `feat` | New Features |
| `fix` | Fixes |
| `perf` | Performance |
| `refactor` | Refactor |
| `docs` | Docs |

Also available: `build`, `ci`, `test`, `style`, `chore`, `revert`.

`keep: false` keeps every release. The default of 10 exists because a changelog
that grows for the life of a project is the reason nobody scrolls to the bottom
of one; what falls off is still in the tags and on the releases page, and the
file says so rather than simply ending.

### Prereleases

```yaml
changelog:
  prereleases: true      # off by default
```

**Off by default, because a prerelease is a step toward a release rather than
one.** `latest` never pointed at `0.1.0-beta.9`, nobody installed it on purpose,
and everything in it ships again under the stable version that follows — so a
heading for it describes a version its reader cannot get, and spends one of
`keep`'s slots doing it. On this repository five of ten kept sections were betas.

**Excluding them widens the ranges rather than dropping the commits**, and that
is the part worth understanding before turning it back on. A stable release's
span runs from the previous *stable* tag, absorbing every prerelease between —
without that, removing the headings would delete their contents with nothing to
mark the absence. Measured here: `v1.0.0` covers 2 commits from
`v0.1.0-beta.12`, and 33 from the last stable point. The other 31 are the beta
series, and they shipped in 1.0.0 whatever the tag history says.

`cutver notes v1.3.0-beta.1` still works for a prerelease tag with no heading in
the file — it falls back to compiling that range from the commits.

**A breaking commit appears once**, under Breaking Changes, never also under its
own type — listed twice it reads as two changes to anyone skimming.
`chore(release):` commits are skipped: they announce the version the reader is
already looking at. A release whose commits are all `chore` keeps its heading
and says `_No user-facing changes._`, because dropping it would leave a gap in
the version sequence that reads as a mistake.

### The diff line

```
diff: [8aadce9...91d1a5f](https://github.com/o/r/compare/8aadce9...91d1a5f)
```

Short shas rather than tag names, because for the release being cut the range is
written **before the tag exists** — `v1.2.0...v1.3.0` would name a ref that
resolves for nobody until later. Shas resolve the moment they are printed.

Linked only for GitHub remotes. GitLab uses `/-/compare`, Gitea differs again,
and a link built from the wrong template looks checkable and is not — so
everything else gets the bare range, which anyone can paste into `git diff`.

### The GitHub release body

The generated `publish.yml` takes the release body from this file: it extracts
everything under `## [<version>]` up to the next `## ` heading and passes it as
`--notes-file`. The notes people read on GitHub are then the same words as the
ones in the repository, rather than a second telling that drifts from it.

### Summarising the release body

```yaml
changelog:
  summarizer:
    connector: gemini
    model: gemini-3.5-flash
```

**Writing this is the switch.** There is no separate `summarize: true` — that
spelling existed alongside a top-level `summarizer:` block, two keys for one
decision where setting either alone did nothing. Both still parse and say what
they became; they go in 3.0.

It lives in the tracked config rather than in the environment because it is a
statement about the repository — this project wants a summarised release body,
whoever cuts the release. Where the notes are *sent* is the same decision, which
is why it sits in the same block: a fork that edits it is a fork editing a file
you review.

**There is no key in there, and that is deliberate.** `cutver.yml` is tracked,
pushed, and shipped inside the npm tarball, so a key written in it is a key
published — worse than a leaked command, because it cannot be made safe by
review, only rotated. cutver reads the key from the environment:
`CUTVER_SUMMARIZE_KEY` first, so CI has one name to set whatever the connector
is, then the provider's own convention (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`) so a laptop that already exports one needs no extra setup.

`CHANGELOG.md` is never summarised. The file in the repository keeps exactly
what you wrote; the release page gets the readable version. A paraphrase can be
subtly false, and a changelog is published.

#### The connectors

| `connector` | endpoint | `base_url` |
| --- | --- | --- |
| `anthropic` | `/v1/messages` | optional |
| `gemini` | `/v1beta/models/{model}:generateContent` | optional |
| `openai-compatible` | `{base_url}/chat/completions` | **required** |

`openai-compatible` is most of the field — OpenAI, OpenRouter, Groq, Together,
vLLM, LM Studio, llama.cpp's server and Ollama all speak it, so `base_url` does
the work and cutver grows no per-provider code. It has no default on purpose:
this connector's reason to exist is pointing somewhere other than OpenAI, and
defaulting would send a repository's notes to a provider it never named.

Raw `fetch`, no SDK. cutver computes version numbers and edits manifests; making
every install carry three provider SDKs for an optional feature is not a trade
worth making.

#### Choosing a model

Measured on this repository — five commits, a ~3,100-token payload, the same
prompt throughout:

| | quality | latency | free-tier headroom |
| --- | --- | --- | --- |
| lite tiers (`*-flash-lite`) | invents sections, drops scopes | 3–4s | high |
| mid tiers (`*-flash`) | correct and stable | 13–16s | ~20/day |
| large open-weight models | correct and stable | 60–110s | very high |

**The lite tiers are the one to avoid.** They follow the shape and get the
judgement wrong: a phantom `### Refactor` section, a `- **:**` with an empty
scope, and — measured — a commit body's *record of a different model's mistake*
published as a shipped change. Everything above that tier produced correct notes
without prompt changes.

`timeout` is 300 seconds, chosen to clear the slowest measured run five times
over while still failing well inside the `timeout-minutes: 15` on the generated
step. A summariser is never allowed to be the reason a release has no notes.

#### When it fails

Every failure publishes the notes as written — a missing key, a wrong model
name, a rate limit, a timeout, an empty answer. That is the invariant the whole
feature rests on, and it is why turning this on is safe.

```yaml
changelog:
  summarizer:
    connector: gemini
    model: gemini-3.5-flash
    retry: true          # or a number of minutes, 1–10
```

`retry` waits and asks once more, **only for a failure waiting can fix** — a
429, a 5xx, a dropped connection. Free tiers meter tokens per *minute*, so a
release landing while something else spends the same key fails on a window that
refills on its own. A 400 naming a model that does not exist is never retried;
sleeping on one turns a clear error into a slow one.

`true` means one minute, the window rate limits are actually measured over. The
ceiling is 10 because the generated step allows 15 in total, and a retry that
gets the job killed loses the release body it was trying to save.

#### What the model is sent

```
<the prompt>

<metadata>
diff: [2b29cdd...c3f6866](https://github.com/o/r/compare/2b29cdd...c3f6866)
</metadata>

<commits>
c3f6866
section: Fixes
fix(changelog): forbid the summariser moving text between entries

<the body, verbatim>

---

1d21e8e
section: New Features
feat(changelog): the summariser reads whole commit bodies
…
</commits>
```

**Raw commits, not rendered notes.** An earlier version sent the compiled
markdown, which meant the model saw a shape a renderer had just built and was
asked to rebuild it — and the first shape leaked into the second, one output
bullet per input bullet. It now gets the material and nothing else.

**`section:` is stated rather than derived**, and that line is the whole reason
classification is reliable. Asked to read the type off the subject, a model put
the same `fix(changelog):` commit under New Features four runs running — and,
asked why, quoted the rule back verbatim, named `### Fixes` as correct, and
called its own output an execution error. A rule a model can recite and still
not apply is not a rule worth rewording. `sectionOf` already knew the answer.

**The two tags are a boundary, not formatting.** `<metadata>` is facts to copy
through untouched; `<commits>` is material to summarise. And commit bodies are
written by anyone who can land a commit, so the prompt states that everything
inside the tags is content and never instruction — a body reading *"ignore the
rules above"* is text to summarise, not to obey. Tags rather than a fence
because bodies routinely carry fenced code, and a fence inside a fence closes
the outer one early.

#### What comes back

Two parts. `<reasoning>` states each commit's section before any note is
written; `<release>` is the body, and only that is published.

The reasoning pass exists to be thrown away. Forcing the mapping onto the page
*before* the prose is what makes the model consult it — and it caught a real bug
in cutver: a model that thinks out loud rehearsed the format inside its own
`<thought>` block, and taking the first `<release>` published 6 KB of its
planning notes as a successful summary. The last opening tag is the answer.

```
diff: [2b29cdd...c3f6866](…)
This release enhances the changelog summariser's accuracy and output detail.

### New Features
- **changelog:** the summariser reads whole commit bodies ([1d21e8e](…))
- **changelog:** one commit may summarise into several bullets ([6bd529f](…))

### Fixes
- **changelog:** forbid the summariser moving text between entries ([c3f6866](…))

### Docs
- update documentation on the summariser ([6bd529f](…))
```

One line per change, at most three bullets per commit. A commit's first bullet
goes under its `section:`; **additional changes its body states are classified
on their own merits**, so a `feat:` that also repairs a workflow reaches CI as
well. That is why `6bd529f` appears under both New Features and Docs above.

Superseded entries are dropped — a release that adds a flag and then renames it
ships the flag it ships, not the path taken to it. A `### Migration` section is
added last, and only when the notes state what to change; a breaking change with
no stated steps gets no invented ones.

#### `cutver notes`, and why the workflow is one line

```yaml
- name: Release notes
  timeout-minutes: 15
  continue-on-error: true
  run: cutver notes "$TAG" > notes.md
```

Extraction, the prompt and the summariser pipe all live in `cutver notes` rather
than in the generated file. **Anything written into `publish.yml` is frozen at
`init` time for every repository that already ran it** — improving it later
would mean asking everyone to regenerate a workflow they have since hand-edited,
which nobody does. One line here, and `bunx cutver` picks up the improvement on
the next release.

It takes two forms:

| | |
| --- | --- |
| `cutver notes v1.3.0` | the `CHANGELOG.md` section for that version |
| `cutver notes v1.2.0 v1.3.0` | that commit range, compiled — the changelog is not read at all |

The range form is for a repository that keeps no changelog, where the
alternative is an empty release body, and for backfilling a release that
predates any of this. The tag form **falls back to it**: no changelog, or no
section for that version, and it compiles the tag's own range rather than
publishing nothing.

It always exits 0. It runs in a publish job that has already tagged and already
built, so failing there would strand a finished release over its notes.

`timeout-minutes` is the guard for a model that hangs, and it is in the workflow
because that is where the mechanism exists — Bun Shell exposes neither a timeout
nor an abort signal, and a fake one would return while leaving the child running
and the process unable to exit. `continue-on-error` means a timeout costs the
body and not the release.

#### What it costs

Expect **one to two minutes** for a normal release, and budget by prompt size
rather than by output length: on CPU the cost is overwhelmingly *prefill*, not
generation, so a short extracted section is seconds and a 200-commit backfill is
minutes. The 128K context a small modern model carries means a whole release's
notes fit in one prompt either way.

The download is the part that surprises people. Weights are pulled on every run
unless you cache them with `actions/cache`, and cache entries unused for **7
days** are evicted — a project releasing weekly keeps it warm, a project
releasing monthly re-downloads every time.

## No changelog is fine

A repository that keeps its history in git and its notes on a releases page is
a normal repository. cutver reports and moves on:

```
  · CHANGELOG.md  no file
```

Nothing is created. Refusing to cut a version over a missing changelog would be
a release tool inventing a requirement.

## A changelog with no `## [Unreleased]`

Left alone, and said out loud:

```
  = CHANGELOG.md  no `## [Unreleased]` heading — left alone
```

Neither silence nor failure is right here. The file existing is evidence that
somebody wants release notes, so failing to roll it is news. But dying over a
heading would block a release for a formatting convention your repository never
agreed to.

Add the heading when you want it rolled.

## Formatting is preserved

The date is ISO-8601 — `2026-08-14`, not `14/08/2026`. Not
`toLocaleDateString`: a release note that reads differently depending on who
cut it is a small lie.

Line endings are kept. A CRLF changelog gets a CRLF heading; the file is
written back the way it arrived. That holds for manifests too — see
[the adapters](../adapters/cargo.md#crlf-is-expected).

## `cutver init` writes a stub

Only if there is no `CHANGELOG.md` already, and never with `--force`:

```markdown
# Changelog

## [Unreleased]
```

A changelog holds prose someone wrote. Nothing here is entitled to overwrite
that, flag or no flag.
