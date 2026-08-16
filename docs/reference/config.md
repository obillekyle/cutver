# Configuration

Optional. With no config file cutver behaves exactly as it always has, and
there is a test whose whole job is to keep that true.

`cutver.json` or `cutver.yml` at the repository root — same schema, pick your
poison. JSON gets editor completion from `$schema`; YAML gets comments.

The schema is served at
[cutver.okyle.dev/cutver.schema.json](https://cutver.okyle.dev/cutver.schema.json),
and a test holds it to the loader — the same ecosystems, the same schema
ceiling, the same verdict on a channel name. An editor that accepts a config
cutver refuses would be worse than no completion at all.

```json
{
  "$schema": "https://cutver.okyle.dev/cutver.schema.json",
  "schema": 1,
  "target": "bun",
  "channels": {
    "release": ["main", "master"],
    "beta": ["beta", "develop", "{version}-beta"],
    "canary": ["canary", "nightly/*"]
  }
}
```

The same thing in YAML:

```yaml
schema: 1
target: bun

channels:
  release: [main, master]
  # Everything on develop ships as a beta.
  beta: [beta, develop, "{version}-beta"]
  canary: [canary, "nightly/*"]
```

| key | |
| --- | --- |
| `schema` | The **config** schema version, not your project's. `1` today. |
| `target` | `bun` \| `node` \| `cargo`. Replaces `--adapter` when a repository has both a `package.json` and a `Cargo.toml`. |
| `publish` | Whether a tag reaches the registry. `true` or `false`. See [What a tag produces](#what-a-tag-produces). |
| `changelog` | Compile sections from the commits. `true`, `false`, a list in reading order, or a mapping. Off by default — see [Changelogs](../guides/changelog.md#compiling-it-instead). |
| `artifacts` | What a tag attaches: `false`, `auto`, or named paths. See [Artifacts](#artifacts). |
| `channels.release` | Branches that cut a stable release. |
| `channels.<name>` | Branches that cut a prerelease under that identifier. |

Every key is optional. `--adapter` and `cutver stage <channel>` beat
whatever the file says — the flag was typed just now, the file was written
months ago.

## What you can leave out

Omitting a key is not always the same as writing its default, and the difference
has bitten people. Three rules:

| | |
| --- | --- |
| **Safe to omit** | `schema`, `changelog.keep`, `changelog.prereleases`, `changelog.prompt`, and `summarizer.base_url` outside `openai-compatible`. Writing these changes nothing. |
| **Depends on your ecosystem** | `publish` and `artifacts`. The default differs between cargo and JavaScript, so `false` is a real statement on one and a redundant one on the other. |
| **Never the same** | `target` and `channels`. Omitting each means something other than its value. |

`target` omitted means **detect**, which refuses when both a `package.json` and
a `Cargo.toml` exist. Writing it is how you settle that.

`channels` is the subtle one, because **provenance is load-bearing.**
`release: ["**"]` written down means "I meant every branch" and reaches the
generated workflow as `**`. The identical value *inherited* means "no branch
gating configured" and becomes `main` — because waking CI on every branch in a
repository is not something a default should do quietly. cutver tracks which
keys the file actually wrote, so the two cannot be confused.

## Changelog keys

```yaml
changelog:
  sections: [breaking, feat, fix, perf, refactor, docs]
  keep: 10
  prereleases: false
  summarizer: true         # or a mapping — see below
```

| key | |
| --- | --- |
| `sections` | Which commit types get a heading, in reading order. |
| `keep` | Release sections retained in the file. Default 10; `false`, `0` and `null` all keep every one. |
| `prereleases` | Whether a prerelease gets its own heading. **Off by default** — excluding them widens each stable release's span to the previous *stable* tag rather than dropping the commits. |
| `summarizer` | Where the **GitHub release body** goes to be rewritten. `CHANGELOG.md` is never summarised. See [The summariser](#the-summariser). |
| `prompt` | Replace the instruction sent ahead of the commits. Needs `summarizer`. |

`changelog: true` is shorthand for the defaults above. A bare list sets
`sections` and leaves the rest.

## Artifacts

Four shapes, because there are four different amounts you might know:

```yaml
artifacts: false     # attach nothing
```

```yaml
artifacts: auto      # find the build output on the runner — `true` says the same
```

```yaml
artifacts:           # or name it
  folders:
    - dist
  files:
    - build/my-executable
```

Omitted entirely, the ecosystem decides — a cargo workspace attaches its
binaries, a JavaScript package attaches nothing until it says what.

| key | |
| --- | --- |
| `folders` | Directory globs, or `auto`. Each match is archived to `<name>.tar.gz` and attached as one asset. |
| `files` | File globs, or `auto`. Each match is attached as its own asset, under its own name. |

There is no `enabled` key, and its absence is the design: **writing the block is
the yes, and `artifacts: false` is the no.**

**Folders are archived and files are not**, which is the whole reason both keys
exist. A release page carrying two hundred loose assets out of one `dist/`
helps nobody, so a folder becomes one `.tar.gz` named after it.

**This says what to attach, not how to build it.** The build step stays your
own — `bun run build`, `npm run build`, or the cargo matrix — because that is a
command you already have, and a second place to write it is a second place for
it to disagree with `package.json`.

### `auto`

`auto` is resolved **on the runner, not when the workflow is written**, and that
is the whole reason it can work. Nothing has been built at `init` time, so a
generated file cannot know whether this project emits `dist/`, `build/` or
`out/`. The collect step probes for them after the build has run — the one
moment the answer exists — and skips whatever is not there.

A mapping that names nothing resolves to `auto`, and so does `files:` written
with nothing under it, which is YAML for null and reads as "you fill this in".

> **Paths are relative to the repository root, and checked at load.** An
> absolute path or one climbing out through `..` is refused — these are
> interpolated into a script that runs in CI holding a write token.

A **cargo** workspace needs none of this: `cargo metadata` names every
executable it builds, so the generated job collects them without being told.
The block is for the case cutver cannot infer.

## The summariser

```yaml
changelog:
  summarizer:
    connector: gemini        # anthropic | openai-compatible | gemini
    model: gemini-3.5-flash-lite
    base_url: …              # required for openai-compatible
    retry: true              # false | true | 1–10 minutes
```

**Writing this is the opt-in; there is no separate switch.** It used to sit at
the top level next to a `changelog.summarize: true` that turned it on — two keys
for one decision, where setting either alone did nothing. Both spellings still
parse and say what they became; they go in 3.0.

`summarizer: true` means the command in `CUTVER_SUMMARIZE` rather than a
provider:

```yaml
changelog:
  summarizer: true
```

| key | |
| --- | --- |
| `connector` | Which request shape. `openai-compatible` covers OpenAI, OpenRouter, Groq, Together, vLLM, LM Studio, llama.cpp and Ollama. |
| `model` | Passed through verbatim. cutver keeps no list of model names. |
| `base_url` | Required for `openai-compatible`, where it is what names the provider. Optional elsewhere. |
| `retry` | Wait and try once more, for failures waiting can fix. `true` is one minute. |

**There is no key for the API key**, and that is the point: this file is
committed, pushed and shipped inside the npm tarball. cutver reads it from
`CUTVER_SUMMARIZE_KEY`, or failing that the provider's own variable —
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`.

A `.env` or `.env.local` works locally, including for the standalone
executables — Bun loads them whether cutver is run from source or compiled. Two
things about that are worth knowing, because neither is obvious:

- **It reads them from the directory you launched cutver in, not from `--cwd`.**
  The load happens at process startup, before any flag has been looked at, so
  `cutver stage --cwd /elsewhere` still reads the `.env` next to your shell. The
  symptom is `no key is set` naming the variables it tried.
- **`bun test` does not load `.env.local`**, by design, so a suite cannot start
  making live API calls because a key happened to be sitting in the tree.

In CI the file is not there — `.env*` is gitignored — so the key comes from a
repository secret, passed into the notes step.

### What the model is shown

```yaml
changelog:
  summarizer:
    connector: gemini
    model: gemini-3.5-flash-lite
    with_body: true
```

`with_body` sends whole commit bodies rather than the first paragraph of each.
On by default, and it is what lets one commit become several bullets — the
changes after the first live in the paragraphs a rendered section drops. `false`
is cheaper and enough for a project whose bodies are a line each.

`CUTVER_SUMMARIZE` in the environment still names any command that reads
markdown on stdin and writes it on stdout, and still wins when both are set.

Every failure — missing key, wrong model, rate limit, timeout, empty answer —
publishes the notes as written. Full detail in
[Changelogs](../guides/changelog.md#summarising-the-release-body).

## What a tag produces

```yaml
publish: true          # does a tag reach the registry?
artifacts:             # what does a tag attach?
  files: [dist/my-executable]
```

**Two keys, because they are two questions.** cutver's own release answers yes
to both: `cutver` is on npm *and* every tag carries five standalone executables,
because a repository with no JavaScript runtime still needs a way to run a
version bump.

| | |
| --- | --- |
| `publish: true` | Publish to npm or crates.io. |
| `publish: false` | Tag and stop. A real answer, not an omission. |
| `artifacts:` | What to attach — see [Artifacts](#artifacts). |

Leave them out and the ecosystem decides:

| `target` | `publish` | `artifacts` |
| --- | --- | --- |
| `bun`, `node` | `true` | none |
| `cargo` | `false` | the binaries `cargo metadata` names |

> **`publish` was a list before 2.0.** `[registry, artifacts]` answered both
> questions in one key, so setting either meant restating the other. The list
> still parses and says what it became; it goes in 3.0.

**That asymmetry is deliberate.** `cargo publish` **reserves the crate name
permanently**, for every member of the workspace — a ten-crate workspace claims
ten names the first time the workflow runs, and there is no undo. A Rust
workspace is also far more often an application than a library. So a generated
file must not publish one as a side effect of wanting version numbers: opting in
is a line of config, opting out afterwards is not possible at all. npm has no
reservation of that kind and a `package.json` almost always exists to be
installed, so the safe default differs the same way the risk does.

Two things follow from the setting, beyond which jobs `cutver init` writes:

- **A tag that produces nothing writes no `publish.yml` at all** — that is
  `publish: false` with `artifacts: false` — and `version.yml` drops its
  handoff step — dispatching a workflow that is not there fails the run *after*
  the tag is already public.
- **The registry preflight is only asked when a tag publishes to one.** Its job
  is to refuse a release for a package the registry has never heard of, because
  a first publish cannot go through a trusted publisher. Against a repository
  whose tags produce executables that is not a safeguard, just ten crates
  reported missing from a registry they will never reach.

The generated artifact job builds **natively on three runners** rather than
cross-compiling, and asks `cargo metadata` which binaries exist rather than
naming them. Both are scars: cutver shipped a segfaulting
`cutver-windows-x64.exe` for five releases because CI cross-compiled every
target on Linux, and a workflow with a binary name written into it uploads
nothing the day someone renames it.

A prerelease tag is marked as a prerelease on the GitHub release, which matters
more than it sounds — `releases/latest/download/…` follows GitHub's idea of
latest and skips prereleases. See [Install](../getting-started/install.md).

## Channels

**The key is the channel.** It is the prerelease identifier in the version, and
the dist-tag the release publishes under. There is no separate `tag` field to
drift out of step with it.

```
channels.beta: ["develop"]     →  1.3.0-beta.0   published under `beta`
channels.canary: ["canary"]    →  1.3.0-canary.0 published under `canary`
```

`alpha`, `beta` and `rc` are the ones cutver knows without being told. Any other
lowercase name works the same way — **add a key and the channel exists.**
Registries have no opinion here: react publishes `next`, `canary` and
`experimental`; typescript publishes `dev` and `insiders`; crates.io has no
dist-tag concept at all.

`prerelease` is accepted as a spelling of `rc`. Declaring both is an error
rather than a merge.

Names are **kebab-case**, and you do not have to write them that way. `Beta`,
`myPrefix`, `my_prefix` and `my prefix` are all normalised for you:

| you write | the channel is |
| --- | --- |
| `Beta` | `beta` |
| `myPrefix` | `my-prefix` |
| `pre_release` | `pre-release` |
| `HTTPServer` | `http-server` |

Normalising happens once, at load, so the version string, the git tag, the
dist-tag and the generated workflow arm cannot end up disagreeing about
spelling. Two keys that normalise to the same channel are an error rather than
a silent merge — merging two rules is how a branch ends up in a channel nobody
declared.

> **Digits are refused.** `rc2` and `v2-latest` are rejected at load. They are
> legal semver, but an all-digit prerelease identifier carries leading-zero
> rules of its own, and a channel name is not the place to spend that.

> **A hyphen inside the name is safe; a hyphen before the counter is not.**
> Worth stating because they look like the same thing. `1.2.0-my-prefix.9` sorts
> correctly below `1.2.0-my-prefix.10`, because the counter is still its own
> dot-separated numeric identifier. `1.2.0-rc-9` sorts *above* `1.2.0-rc-10`,
> because there the counter is fused into the text. cutver always emits the
> former shape, so this is a property of the format rather than something you
> can get wrong in a name.

## Branch patterns

Three shapes, told apart by what they contain. No extra syntax.

| Pattern | Matches | Base |
| --- | --- | --- |
| `develop` | that branch exactly | computed from the commits |
| `nightly/*` | a glob over the whole name | computed from the commits |
| `{version}-beta` | `1.3.0-beta` | **declared by the branch** |

A `release/` prefix is stripped before matching, so `release/develop` and
`develop` are the same branch to cutver. A leading `v` is stripped for
`{version}` patterns only — `v1.3.0-beta` declares `1.3.0`, while `vbeta` stays
an ordinary branch.

Globs are the same globs GitHub Actions uses: `*` does not cross a `/`, `**`
does. That is not a coincidence being relied on quietly — it is why your
patterns reach the generated workflow unchanged instead of being translated.

`{version}` patterns keep the refusal that comes with declaring a base: land a
`feat!` on `1.3.0-beta` and cutver refuses rather than shipping a breaking
change as a minor. A bare `beta` promises no number, so there is nothing to
contradict. See [Alphas, betas and RCs](../guides/channels.md).

## When nothing matches

A branch that matches no channel and no `release` entry **releases nothing**:

```
cutver: branch 'feat/login' matches no channel and no release rule in cutver.json.
        Add it to a channel in your config, or pass a version explicitly.
```

| | |
| --- | --- |
| `cutver` | exits 1 |
| `cutver stage --if-needed` | exits 0 — what CI on a feature branch wants |
| `cutver check` | exits **0**, and the push proceeds |

That last row is deliberate. `check` runs from the pre-push hook on every branch
of every push, so treating "this branch may not release" as a failure would
block every feature branch in the repository, forever. It is not an error that
a feature branch releases nothing; it is the configuration working.

**The default is `release: ["**"]`** — any branch may cut a stable release,
which is what cutver does with no config at all. Writing a `release` list is how
you opt into strictness, so upgrading cutver never silently stops releases on a
repository that uses `develop` or `trunk`. `cutver init` scaffolds `[main]`,
because running `init` is choosing that.

## Discovery

`cutver.json`, then `cutver.yml`, then `cutver.yaml`, in the repository root
only. `--config <path>` overrides it; if that path does not exist cutver dies
rather than falling back to the defaults.

**More than one config file present is an error.** Picking a winner would mean
the file you edited might not be the file that ran.

There is no search up the directory tree and no user-level config, on purpose: a
config outside the repository would mean CI and your laptop computing different
version numbers from the same commits.

## Errors

Everything is checked at load, before git is touched and before anything is
written. A wrong config should cost you a message, never a version number.

| | |
| --- | --- |
| unknown key | named, with the nearest valid one suggested |
| a channel name with a digit | refused, with the frozen-counter reason |
| two keys that are the same channel after lowercasing | refused, naming both |
| `rc` and `prerelease` both declared | refused |
| one branch matching two channels | refused, naming both entries |
| a `schema` newer than this cutver | refused on a real run, skipped by `check` |
| a key written twice | refused — both parsers silently keep only the last |

That last one is worth knowing about: neither `JSON.parse` nor `Bun.YAML.parse`
complains about a duplicated key, and neither reports a line number, so cutver
lints for it and adds the file name itself.

## Seeing what it did

```bash
cutver explain
```

```
cutver: /repo
  config    cutver.json
  target    js  (config)
  branch    'develop'
  rule      channel `beta` via literal "develop"  (base computed from commits)
            tried:
                   release [main] — no
                   canary [canary, nightly/*] — no
  plan      1.2.0 -> 1.3.0-beta.0 (minor, beta from branch 'develop')
```

Read-only, offline, always exits 0.

## Keeping the workflow in step

`on.push.branches` and the publish workflow's dist-tag mapping are both
generated from this file. GitHub needs its branch list statically, so it cannot
be read at run time — **after adding a channel, re-run `cutver init --force`**,
or the new branch never triggers anything and the symptom is silence.
