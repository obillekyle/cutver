#!/usr/bin/env bun
/**
 * cutver — work out the next version, write it into every manifest, stop.
 *
 *     cutver stage              # version computed from the commit messages
 *     cutver stage --dry-run    # show the computed bump, write nothing
 *     cutver stage 1.4.0        # explicit, overrides the computation
 *     cutver stage beta         # 1.3.0-beta.0
 *
 * **Does not publish, and that is the design rather than an omission.**
 * Publishing is the one irreversible step in the whole sequence — npm does not
 * allow a version number to be reused, by anyone, ever — so it gets its own
 * trigger, its own credentials, and a human or a workflow that decided to run
 * it. A tool that both rewrites the tree and pushes to a registry is one typo
 * away from a mistake nobody can take back. This gets the tree to a releasable
 * state and stops. `stage` is the honest verb for that.
 *
 * **This file is the dispatch and nothing else.** The tree lives in `help.ts`,
 * `args.ts` turns argv into `Options`, and each command has its own module.
 */
import { die, VERSION } from './args'
import {
  runChangelog,
  runCheck,
  runConfig,
  runExplain,
  runHook,
  runInit,
  runNotes,
} from './commands'
import { runCompletions } from './completions'
import { runDoctor } from './doctor'
import { commandNamed, help, helpFor } from './help'
import { runStage } from './stage'

/**
 * A bare `cutver` says what it is, the way a bare `bun` does.
 *
 * **The exit code is the whole subtlety, and it is a migration hazard rather
 * than a preference.** Until 2.0 the release command *was* the bare invocation,
 * so every workflow `cutver init` has ever generated runs
 * `cutver --if-needed --branch …`. Printing help and exiting 0 there would turn
 * those into green steps that release nothing, forever, with no error anywhere
 * to notice — the worst failure available to a release tool.
 *
 * So a terminal gets help and a zero, because a person typing `cutver` to see
 * what it does has not made a mistake. Anything that is not a terminal gets the
 * same text on stderr and a **1**, naming the line to change. A red step
 * carrying its own fix beats a silent one.
 */
function noCommand(): never {
  if (process.stdin.isTTY) {
    console.log(help(VERSION))
    process.exit(0)
  }

  console.error(help(VERSION))
  console.error(
    '\ncutver: no command given.\n' +
      '        Releasing is `cutver stage` since 2.0 — a workflow generated before\n' +
      '        then runs `cutver --if-needed`, which now does nothing at all.\n' +
      '        Change that line to `cutver stage --if-needed`, or re-run\n' +
      '        `cutver init --force`.\n' +
      '        Docs: https://cutver.okyle.dev/#/getting-started/ci',
  )
  process.exit(1)
}

/**
 * A function rather than a top-level await, and it is not a style choice.
 * `bun build --compile --bytecode` emits CommonJS — bytecode compilation
 * requires it — and CommonJS has no top-level await, so a module-scoped
 * `await` here fails the build with an error that points at the line rather
 * than at the reason. The whole entry lives in `main()` so the compiled binary
 * and `bun run src/cli/index.ts` are the same program.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv

  // The two that are flags as well as words, checked before anything else so
  // `cutver --help` and `cutver help` cannot answer differently.
  if (command === '-h' || command === '--help')
    return void console.log(help(VERSION))
  if (command === '-v' || command === '--version')
    return void console.log(VERSION)

  switch (command) {
    case undefined:
      return noCommand()

    case 'help': {
      const named = commandNamed(rest[0])
      if (rest[0] && !named)
        die(`no command named '${rest[0]}' — \`cutver help\` lists them`)
      return void console.log(named ? helpFor(named) : help(VERSION))
    }
    case 'version':
      return void console.log(VERSION)

    case 'stage':
      return runStage(rest)
    case 'notes':
      return runNotes(rest)
    case 'changelog':
      return runChangelog(rest)
    case 'check':
      return runCheck(rest)
    case 'doctor':
      return runDoctor(rest)
    case 'explain':
      return runExplain(rest)
    case 'config':
      return runConfig(rest)
    case 'init':
      return runInit(rest)
    case 'hook':
      return runHook(rest)
    case 'completions':
      return runCompletions(rest)

    default: {
      // **A flag here is the pre-2.0 shape**, and it is worth saying so rather
      // than reporting an unknown command: `cutver --dry-run` used to be a
      // whole release. The word case is an ordinary typo.
      if (command.startsWith('-')) {
        die(
          `\`cutver ${command}\` has no command. Releasing is \`cutver stage\` since 2.0 —\n` +
            `        try \`cutver stage ${argv.join(' ')}\`.`,
        )
      }
      die(`no command named '${command}' — \`cutver help\` lists them`)
    }
  }
}

main().catch((e: unknown) => {
  // Anything that got past a specific handler, printed with its stack: an
  // unexpected failure in a release tool is a bug report, not a user error,
  // and the one thing worse than the crash is a crash with no location.
  console.error(e)
  process.exit(1)
})
