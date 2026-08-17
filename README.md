<div align="center">

<a href="https://cutver.okyle.dev"><img src="https://raw.githubusercontent.com/obillekyle/cutver/main/assets/logo.svg" alt="cutver" title="Read the docs" width="80"></a>

# cutver

### The version is arithmetic. The prose is the work.

<!--
  One line each, and not by accident. GitHub renders a single newline inside a
  centred block as a `<br>`, so an 80-column paragraph breaks mid-sentence and
  four badges become four rows. Wrapping these would be a layout change.
-->

Works out the next version from your commit messages, writes it into every manifest, and stops.

[![npm](https://img.shields.io/npm/v/cutver?label=npm&color=295d8d&logo=npm)](https://www.npmjs.com/package/cutver) [![dependencies](https://img.shields.io/badge/dependencies-0-295d8d)](https://www.npmjs.com/package/cutver?activeTab=dependencies) ![license](https://img.shields.io/npm/l/cutver?color=295d8d) ![stars](https://img.shields.io/github/stars/obillekyle/cutver?color=295d8d)

</div>

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/obillekyle/cutver/main/assets/terminal-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/obillekyle/cutver/main/assets/terminal-light.svg">
  <img alt="cutver stage --dry-run: a commit survey showing two features, three fixes and one subject counted for nothing, then 1.2.0 -&gt; 1.3.0" src="https://raw.githubusercontent.com/obillekyle/cutver/main/assets/terminal-light.svg" width="620">
</picture>
</div>

```bash
bunx cutver stage --dry-run
```

That run is against a JavaScript repository with `--offline`, which is why it
says `preflight: skipped`. Given a config that publishes, the preflight block
asks the registry about every package before a single file is written — and a
Cargo repository publishes nothing by default, so it skips for a different
reason. [Configuration](docs/reference/config.md#what-a-tag-produces) covers
what a tag produces.

**It does not publish.** Publishing is the one irreversible step in a release —
a registry never lets a version number be reused, by anyone, ever — so it gets
its own trigger, its own credentials, and something that decided to run it. This
gets the tree to a releasable state and stops.

## Install

Nothing to install for a repository that already has Bun:

```bash
bunx cutver stage --dry-run
```

For one that does not — a Rust workspace, a CI image without a package manager —
every release attaches a standalone executable with no runtime:

```bash
curl -L -o cutver https://github.com/obillekyle/cutver/releases/latest/download/cutver-linux-x64 && chmod +x cutver
```

`cutver-{linux,darwin}-{x64,arm64}` and `cutver-windows-x64.exe`. Full options,
including pinning a version, in [Install](docs/getting-started/install.md).

## Documentation

**[cutver.okyle.dev](https://cutver.okyle.dev)** — the whole of it. Source in
[docs/](docs/), and the pages worth starting from:

| | |
| --- | --- |
| [Your first release](docs/getting-started/first-release.md) | Start here. What to run, in order, and why the first publish is manual. |
| [Set up CI](docs/getting-started/ci.md) | `cutver init` scaffolds the release setup. What each file does, which parts are yours to edit, and the two it changes rather than adds. |
| [Writing the commits](docs/guides/commits.md) | The only input cutver reads. The subject decides the version; the body becomes the release note. |
| [How the number is chosen](docs/guides/versions.md) | The ranges, the baseline, and what happens with no tags. |
| [Alphas, betas and RCs](docs/guides/channels.md) | Prereleases, and branches that declare their own version. |
| [Changelogs](docs/guides/changelog.md) | Compiling the file, and handing the release body to a model. |
| [CLI](docs/reference/cli.md) | Every command and flag. |
| [Configuration](docs/reference/config.md) | Every config key, and what omitting it means. |
| [Troubleshooting](docs/reference/troubleshooting.md) | When something has already gone wrong. |

Or ask it directly:

```bash
cutver help
```

```bash
cutver doctor
```

`doctor` is the one to reach for when a release is not doing what you expected:
it reports the config as resolved, the plan for this branch, drift between your
config and the generated workflows, and whether the registry has heard of each
package.

## Development

```bash
bun run test
```

```bash
bun run typecheck
```

```bash
bun run build
```

`bun run build --all` cross-compiles every release target.

## Provenance

`src/version-from-commits.ts` and its tests were extracted verbatim from the
`bakery` monorepo (the `@bakery-framework/*` packages), where the rules were
worked out against a real release history — the comments cite that history, and
they are kept because the evidence is what makes each rule worth trusting. The
rest of this repository is the part that was coupled to npm, generalised behind
the adapter interface.

## License

MIT
