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
  await $`bun build ${flags} ./src/cli/index.ts --outfile dist/${out}`.quiet()
}

/**
 * The JavaScript the npm package runs, for hosts that are not Bun.
 *
 * **This is what `bin` points at, and it is why the package works under Node.**
 * The source is TypeScript and Node cannot execute it; bundling to one
 * `.mjs` resolves that, inlines `prompt.md` and the YAML parser, and leaves an
 * installed cutver with no dependencies of its own.
 *
 * Bun runs it too — everything under `src/runtime` is written against `node:*`,
 * which Bun implements — so there is one artefact rather than one per runtime.
 *
 * Not minified. It is the file someone reads when cutver misbehaves inside
 * their release pipeline, and 300 KB against 150 KB buys nothing that matters
 * to a command run once a release.
 */
async function bundle(): Promise<void> {
  await $`bun build ./src/cli/index.ts --target=node --outfile dist/cutver.mjs --define CUTVER_VERSION="${version}"`.quiet()

  // **Replaced, not added.** The bundler carries the entry's shebang through,
  // and the entry says `#!/usr/bin/env bun` because that is how it is run from
  // a checkout. Left alone, the published bundle would demand the runtime it
  // exists to avoid — installing fine everywhere and running only where Bun
  // already was, which is the whole bug. npm's bin shim executes this file
  // directly on Unix, so the line has to name node.
  const path = 'dist/cutver.mjs'
  const built = await Bun.file(path).text()
  const body = built.startsWith('#!')
    ? built.slice(built.indexOf('\n') + 1)
    : built

  // **`// @bun` is stripped, and it is not cosmetic.** The bundler writes that
  // pragma to tell Bun the file is already transpiled, and Bun's fast path for
  // it decodes the source as latin1 — so every non-ASCII character
  // in a string literal arrives mangled. An em-dash ships as `c3 a2 c2 80 c2
  // 94` instead of `e2 80 94`, in the help text, in every error message, and in
  // the `## [1.0.0] — 2026-01-01` headings this tool writes into other people's
  // changelogs. Every platform, not just Windows: measured identically on Linux
  // Bun 1.3.14, which is what CI runs.
  //
  // Only text from *source literals* corrupts. Anything read at runtime — a
  // commit subject, a manifest — is UTF-8 whatever the module decode did, which
  // is the split that makes this hard to notice.
  //
  //     printf '// @bun\nconsole.log("—")\n' > t.mjs && bun t.mjs | od -c
  //
  // Reproduced down to that two-line file: the same program without the pragma
  // prints the right bytes. It is Bun's bug rather than this one's, but this is
  // the artefact that carries it — `bunx cutver` and `npx cutver` both run this
  // file, and the compiled executables are unaffected.
  //
  // What the pragma buys is skipping a parse at startup, which is worth less
  // than correct output.
  const clean = body.replace(/^\/\/ *@bun.*\r?\n/, '')

  await Bun.write(path, `#!/usr/bin/env node\n${clean}`)
  console.log('  dist/cutver.mjs  (node)')
}

const all = process.argv.includes('--all')
console.log(`cutver ${version} -> dist/`)

await bundle()

if (all) {
  for (const { target, out } of TARGETS) await compile(out, target)
} else {
  await compile(process.platform === 'win32' ? 'cutver.exe' : 'cutver')
}
