# Configuration

Optional. With no config file cutver behaves exactly as it always has, and
there is a test whose whole job is to keep that true.

`cutver.json` or `cutver.yml` at the repository root — same schema, pick your
poison. JSON gets editor completion from `$schema`; YAML gets comments.

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
| `channels.release` | Branches that cut a stable release. |
| `channels.<name>` | Branches that cut a prerelease under that identifier. |

Every key is optional. `--adapter` and `--<channel>` on the command line beat
whatever the file says — the flag was typed just now, the file was written
months ago.

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

> **Lowercase letters only, and this one has teeth.** Channel keys are
> lowercased for you — `Beta` and `myPrefix` become `beta` and `myprefix` — but
> a digit or a hyphen is refused outright. The prerelease counter reads the
> identifier as `[a-z]+`, so `rc2` or `v2-latest` would restart at `.0` on every
> run; the next version would then equal the current one, and the channel would
> report "nothing to release" **forever**. Refusing at load beats a channel that
> looks fine and never advances.

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
| `cutver --if-needed` | exits 0 — what CI on a feature branch wants |
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
| a channel with a digit or hyphen | refused, with the frozen-counter reason |
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
