/**
 * Everything that touches the world outside this process.
 *
 * **Written against `node:*`, which both runtimes speak.** Bun implements the
 * Node API surface, so one implementation runs on Bun and on Node — where two
 * would mean a second code path that the suite, running under Bun, would never
 * execute. The alternative was `Bun.file`/`Bun.YAML`/Bun Shell scattered across
 * nineteen files, which made the published npm package installable everywhere
 * and runnable only where Bun already was.
 *
 * Collected here rather than imported directly at each call site so the answer
 * to "what does cutver need from its host" is one file long. Two of these are
 * local implementations of things Node has no equivalent for — see `glob.ts`
 * and `semver.ts`. YAML is the exception and the only dependency: see the note
 * on `parseYaml` below.
 */
import { promises as fsp } from 'node:fs'
import { parse as parseYamlText } from 'yaml'

export { globFiles as glob, globMatch } from './glob'
export { order as semverOrder } from './semver'
export { pathToFileURL } from 'node:url'
export { runCommand, runShell, type Run, type ShellRun } from './proc'

/** The whole file as text. Rejects when it is not there. */
export function readText(path: string): Promise<string> {
  return fsp.readFile(path, 'utf8')
}

/**
 * Whether a path exists *and is readable*, which is the question every caller
 * is actually asking.
 *
 * `access` rather than `stat`: a path that exists and cannot be opened answers
 * "can I read the manifest" the same way a missing one does.
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Write, creating parent directories.
 *
 * **The mkdir is not incidental.** `init` writes
 * `.github/workflows/version.yml` into a tree that has neither directory and
 * never calls mkdir — `fs.writeFile` alone throws ENOENT there, which is the
 * exact case `init` exists for.
 */
export async function write(path: string, contents: string): Promise<void> {
  const dir = path.replace(/[\\/][^\\/]*$/, '')
  if (dir && dir !== path) await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path, contents)
}

/** Remove a file. Absent is not an error — the end state is what matters. */
export async function remove(path: string): Promise<void> {
  await fsp.rm(path, { force: true })
}

/**
 * Parse a YAML document. Throws on malformed input.
 *
 * The one dependency in the tree, because Node has no YAML and a config format
 * is not a thing to hand-roll a parser for. It is bundled into the published
 * artefact, so an installed cutver still has no dependencies of its own.
 */
export function parseYaml(text: string): unknown {
  // **`uniqueKeys: false` keeps cutver's own duplicate-key error.** This parser
  // rejects a repeated key itself, with a message about YAML maps — but the
  // same mistake is possible in `cutver.json`, where nothing rejects it, and
  // cutver already detects it in both formats and says `channels.beta is
  // declared more than once`. Letting the parser win would mean one message for
  // YAML and a different one for JSON, for one mistake.
  return parseYamlText(text, { uniqueKeys: false }) as unknown
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The environment.
 *
 * **Under Bun this includes `.env` files; under Node it does not.** Bun loads
 * `.env`, `.env.local` and friends at startup and Node has no such step, so a
 * laptop that keeps its summariser key in `.env.local` needs it exported when
 * cutver runs on Node. Said plainly in the docs rather than papered over with a
 * half-implemented dotenv, which would differ from Bun's in some third way.
 */
export const env: Record<string, string | undefined> = process.env
