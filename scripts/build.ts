#!/usr/bin/env bun
/**
 * Compile cutver to a standalone executable.
 *
 *     bun run build          # for this machine, into dist/
 *     bun run build --all    # every release target, into dist/
 *
 * **Why an executable at all, when `bunx cutver` already works.** A release
 * tool is run by CI, by release scripts, and by people who are not otherwise
 * in a JavaScript project — a Rust workspace being the case this was written
 * for. `bunx` in that repository means installing Bun and reaching across
 * ecosystems to fetch a package on every run; a single file that runs does
 * not. Both are shipped: npm for the repositories that already have a package
 * manager, a binary for the ones that do not.
 *
 * **The version is a build-time define, not a file read.** A compiled
 * executable does not carry `package.json` — Bun's docs are explicit that it
 * is not embedded unless asked for — so `cutver --version` reading it from
 * disk works in development and reports nothing at all from the binary, which
 * is the one place a person is most likely to ask. `--define` puts the string
 * in the bundle where it cannot go missing.
 */
import { $ } from 'bun'

const { version } = (await Bun.file(
  new URL('../package.json', import.meta.url),
).json()) as { version: string }

/**
 * The targets a release ships.
 *
 * `-baseline` variants exist for pre-2013 x64 CPUs without AVX2; the default
 * builds are `-modern`. Not shipped here — a release tool is run on developer
 * machines and CI runners, and adding four more artefacts to cover hardware
 * neither of those has is weight without a reader.
 */
const TARGETS = [
  { target: 'bun-linux-x64', out: 'cutver-linux-x64' },
  { target: 'bun-linux-arm64', out: 'cutver-linux-arm64' },
  { target: 'bun-darwin-x64', out: 'cutver-darwin-x64' },
  { target: 'bun-darwin-arm64', out: 'cutver-darwin-arm64' },
  { target: 'bun-windows-x64', out: 'cutver-windows-x64.exe' },
] as const

async function compile(out: string, target?: string): Promise<void> {
  // **No `--bytecode`, and that is measured rather than cautious.**
  //
  // Bytecode moves parsing to build time and roughly halves startup. It also
  // produces a binary that segfaults when the build is cross-compiled to
  // Windows — which is every release, because CI builds all five targets on
  // Linux. Every `cutver-windows-x64.exe` published before this was built that
  // way and crashed on launch with `panic: Segmentation fault`, including when
  // the pre-push hook downloaded one.
  //
  // Isolated to a one-line program rather than blamed on cutver: built on
  // Linux for `bun-windows-x64`, `console.log("hello")` segfaults with
  // `--bytecode` and prints with it removed, on Bun 1.3.14. Cross-compiling
  // the other way (Windows host, `bun-linux-x64` target) is fine with it, so
  // it is the Windows target specifically — but it is dropped for every target
  // regardless, because a released artefact that differs from the one built
  // locally is a thing nobody tests.
  //
  // The trade is trivial in context: this runs once per release, and a few
  // milliseconds of startup is worth nothing against shipping a binary that
  // does not start.
  const flags = [
    '--compile',
    '--minify',
    '--sourcemap',
    ...(target ? [`--target=${target}`] : []),
    `--define`,
    `CUTVER_VERSION="${version}"`,
  ]

  console.log(`  ${out}${target ? `  (${target})` : ''}`)
  await $`bun build ${flags} ./src/cli.ts --outfile dist/${out}`.quiet()
}

const all = process.argv.includes('--all')
console.log(`cutver ${version} -> dist/`)

if (all) {
  for (const { target, out } of TARGETS) await compile(out, target)
} else {
  await compile(process.platform === 'win32' ? 'cutver.exe' : 'cutver')
}
