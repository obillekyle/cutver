# cutver

Work out the next version from your commit messages, write it into every
manifest, and stop.

```bash
bunx cutver stage --dry-run
```

```
cutver: /repo (cargo, at 0.1.0, on 'main')
cutver: 49 commit(s) since the first commit
  minor 5
        feat: bidirectional sync engine
        … and 4 more
  patch 8
cutver: 0.1.0 -> 0.2.0 (minor)

preflight (10 package(s) on crates.io)
  · oidc  not in CI — publishing will use whatever credential crates.io finds locally
  ✗ alloyfs-proto  NOT on the registry — this would be its first publish

files (dry run — nothing is written)
  ↑ Cargo.toml  [workspace.package] 0.1.0 -> 0.2.0
  ↑ Cargo.lock  would run `cargo update -w`
```

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
| [Set up CI](docs/getting-started/ci.md) | `cutver init` writes two workflows. This is what they do and which parts are yours to edit. |
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
bun test ./src
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
