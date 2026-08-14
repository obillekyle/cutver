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
