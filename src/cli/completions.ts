/**
 * Shell completion, compiled from the same table that prints the help.
 *
 * **Generated rather than written, because a hand-kept completion script is a
 * fourth place to describe the surface and the first one to go stale.** A
 * command that exists is a command that completes, and a flag that was renamed
 * completes under its new name on the next release — with no file for anyone to
 * remember to edit.
 *
 * Deprecated spellings are deliberately absent. They keep working, so nothing
 * breaks; they do not complete, so nobody learns them.
 */
import { COMMANDS, GLOBAL_FLAGS } from './help'
import { die } from './args'

const SHELLS = ['bash', 'zsh', 'fish'] as const
type Shell = (typeof SHELLS)[number]

/** Every flag a command takes, its own plus the global ones. */
function flagsFor(name: string): string[] {
  const c = COMMANDS.find(x => x.name === name)
  return [...(c?.flags ?? []), ...GLOBAL_FLAGS].map(f => f.name)
}

const NAMES = COMMANDS.map(c => c.name)

/**
 * A `case` over the first word, which is all the shape this CLI needs.
 *
 * cutver is one level deep — a command, then its flags — so the completion is
 * a lookup rather than a parser. `compgen -W` against a per-command word list
 * is the whole of it.
 */
function bash(): string {
  const arms = NAMES.map(
    n =>
      `      ${n}) ` +
      `words="${[...flagsFor(n), ...(COMMANDS.find(c => c.name === n)?.values ?? [])].join(' ')}" ;;`,
  ).join('\n')

  return `# cutver completion for bash. Source it, or drop it in your completions dir.
_cutver() {
  local cur prev words
  cur="\${COMP_WORDS[COMP_CWORD]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${NAMES.join(' ')} --help --version" -- "$cur") )
    return
  fi

  case "\${COMP_WORDS[1]}" in
${arms}
      *) words="" ;;
  esac

  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -F _cutver cutver
`
}

/** Descriptions come along, because zsh shows them and that is most of the value. */
function zsh(): string {
  const commands = COMMANDS.map(
    c => `    '${c.name}:${c.summary.replace(/'/g, "'\\''")}'`,
  ).join('\n')

  const arms = COMMANDS.map(c => {
    const flags = [...c.flags, ...GLOBAL_FLAGS]
      .map(f => `        '${f.name}[${f.summary.replace(/'/g, "'\\''")}]'`)
      .join(' \\\n')
    const values = c.values?.length
      ? `\n        '1:value:(${c.values.join(' ')})'`
      : ''
    return `    ${c.name})\n      _arguments \\\n${flags}${values ? ' \\' + values : ''}\n      ;;`
  }).join('\n')

  return `#compdef cutver
# cutver completion for zsh.

_cutver() {
  local -a commands
  commands=(
${commands}
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  case "\${words[2]}" in
${arms}
  esac
}

_cutver "$@"
`
}

/** fish wants one line per completion, and gives descriptions for free. */
function fish(): string {
  const esc = (s: string) => s.replace(/'/g, "\\'")
  const lines: string[] = [
    '# cutver completion for fish.',
    'complete -c cutver -f',
    '',
  ]

  for (const c of COMMANDS) {
    lines.push(
      `complete -c cutver -n __fish_use_subcommand -a ${c.name} -d ` +
        `'${esc(c.summary)}'`,
    )
  }
  lines.push('')

  for (const c of COMMANDS) {
    for (const f of [...c.flags, ...GLOBAL_FLAGS]) {
      lines.push(
        `complete -c cutver -n "__fish_seen_subcommand_from ${c.name}" -l ${f.name.replace(/^--/, '')} -d '${esc(f.summary)}'` +
          (f.takes ? ' -r' : ''),
      )
    }
    for (const v of c.values ?? []) {
      lines.push(
        `complete -c cutver -n "__fish_seen_subcommand_from ${c.name}" -a ${v}`,
      )
    }
  }

  return lines.join('\n') + '\n'
}

const GENERATORS: Record<Shell, () => string> = { bash, zsh, fish }

/** `cutver completions <bash|zsh|fish>` — the script on stdout, nothing installed. */
export function runCompletions(argv: string[]): void {
  const shell = argv.find(a => !a.startsWith('-'))

  if (!shell) die(`completions takes one of ${SHELLS.join(', ')}`)
  if (!(SHELLS as readonly string[]).includes(shell)) {
    die(`no completion for '${shell}' — cutver generates ${SHELLS.join(', ')}`)
  }

  // stdout, and nothing else on it. The usual way to use this is to redirect it
  // into a file or `eval` it, and a courtesy line would land in both.
  console.log(GENERATORS[shell as Shell]())
}
