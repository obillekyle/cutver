/**
 * The command tree, written down once.
 *
 * **Three things used to describe this surface and none of them agreed.** The
 * help text was a template literal, the dispatch was a switch, and the shell
 * completions did not exist because there was nothing to generate them from. A
 * flag added to one was a flag missing from the others, and the only thing
 * noticing was a docs test comparing two of the three.
 *
 * So the tree is data. `HELP` renders it, `cutver help <command>` renders one
 * entry of it, `completions` compiles it into a shell script, and the docs test
 * checks the reference page against it. Adding a command means adding a row.
 */
import { ADAPTER_IDS } from '../adapters'
import { pad, plain } from './style'

/** A flag, as it appears in help and in completions. */
export interface Flag {
  /** Long form, with the dashes. */
  name: string
  /** What it takes, or `null` for a boolean. Shown as `<value>` in help. */
  takes: string | null
  /** One line, lower case, no full stop — it is a table cell, not a sentence. */
  summary: string
}

/** Accepted everywhere, because they decide *which repository* is being read. */
export const GLOBAL_FLAGS: readonly Flag[] = [
  {
    name: '--cwd',
    takes: 'path',
    summary: 'repository root (default: the working directory)',
  },
  {
    name: '--config',
    takes: 'path',
    summary: 'read this config instead of looking for one',
  },
]

const STAGE_FLAGS: readonly Flag[] = [
  {
    name: '--dry-run',
    takes: null,
    summary: 'compute and report, write nothing',
  },
  {
    name: '--if-needed',
    takes: null,
    summary: 'exit 0 rather than 1 when no release is warranted',
  },
  { name: '--offline', takes: null, summary: 'skip the registry preflight' },
  {
    name: '--allow-first-publish',
    takes: null,
    summary: 'proceed even though a package is not on the registry yet',
  },
  {
    name: '--adapter',
    takes: ADAPTER_IDS.join('|'),
    summary: 'force the manifest adapter (default: detected)',
  },
  {
    name: '--branch',
    takes: 'name',
    summary: 'branch name, for CI on a detached HEAD',
  },
]

/** One command, as help prints it and as completions offer it. */
export interface Command {
  name: string
  /** The usage line, without the leading `cutver`. */
  args: string
  /** One line for the command list. */
  summary: string
  /** The paragraphs `cutver help <name>` prints. Blank line between each. */
  detail: readonly string[]
  /** Flags beyond the global ones. */
  flags: readonly Flag[]
  /** Fixed words this command's first argument accepts, for completions. */
  values?: readonly string[]
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'stage',
    args: '[<channel>|<version>]',
    summary: 'work out the next version and write it into every manifest',
    detail: [
      'Reads the conventional commits since the last stable tag, decides ' +
        'whether that is a major, minor or patch, and writes the result into ' +
        'every manifest it can find.',
      'It stops there. No commit, no tag, no publish — publishing is the one ' +
        'irreversible step in a release, so it gets its own trigger and its ' +
        'own credentials.',
      'The argument is a channel or a version, and they cannot be confused: a ' +
        'channel name may not contain digits, so anything parsing as semver ' +
        'is a version. `cutver stage beta` cuts a prerelease in that channel; ' +
        '`cutver stage release` forces a stable one; `cutver stage 1.4.0` ' +
        'overrides the computation entirely. With no argument the branch ' +
        'decides, which is what CI wants.',
    ],
    flags: STAGE_FLAGS,
  },
  {
    name: 'notes',
    args: '<tag> | <from> <to>',
    summary:
      "the release body on stdout: a tag's changelog section, or a compiled range",
    detail: [
      'A tag prints its section from CHANGELOG.md, so the body on the release ' +
        'page is the same words as the file in the repository.',
      'A range compiles straight from the commits and never looks at the ' +
        'changelog — the form for a repository that keeps none, and for ' +
        'backfilling a release that predates one.',
      'Never fails over content. No changelog, no section for the tag, a ' +
        'summariser that died — each prints why on stderr and exits 0, ' +
        'because it runs in a publish job that has already tagged and already ' +
        'built. A missing or extra argument is still an argument error, and ' +
        'still exits 1.',
    ],
    flags: [],
  },
  {
    name: 'changelog',
    args: '[file | pages [<all|count|version>]]',
    summary: 'rebuild CHANGELOG.md, or the GitHub release pages, from the tags',
    detail: [
      'The changelog is otherwise only written when a version is cut, which ' +
        'leaves no way to adopt `changelog:` on an existing project, change ' +
        '`keep` or `sections`, or pick up a better rendering — short of ' +
        'cutting a release you did not want.',
      'Two targets, because they are two jobs. `file` rebuilds CHANGELOG.md ' +
        'and is what a bare `cutver changelog` does. `pages` writes the ' +
        'compiled sections onto the GitHub releases, creating one where a tag ' +
        'has none.',
      '`pages` alone covers the tags the file lists. `pages all` covers every ' +
        'tag, prereleases included — `keep` and `prereleases` describe the ' +
        'file, and a release page is one per tag. `pages 5` takes the newest ' +
        'five; `pages v1.2.0` takes that one.',
      'No manifest, no tag, no version is touched by any of it. This was ' +
        '`--regenerate-changelogs`, and `--overwrite` for the pages half; both ' +
        'still work and warn.',
    ],
    values: ['file', 'pages'],
    flags: [
      {
        name: '--dry-run',
        takes: null,
        summary: 'report what would change, write nothing',
      },
      {
        name: '--overwrite',
        takes: null,
        summary: 'also update GitHub release bodies that nobody wrote',
      },
      {
        name: '--force',
        takes: null,
        summary: 'with --overwrite, replace written bodies too',
      },
    ],
  },
  {
    name: 'check',
    args: '',
    summary: 'exit 1 only if this branch may not release what it implies',
    detail: [
      'Read-only and offline, with exit codes suited to a pre-push hook ' +
        'rather than to a person: 0 for "nothing to release", which is not a ' +
        'problem and must not block a push, and 1 only for the ' +
        'branch-declared refusal.',
      'Anything else — cutver crashed, git is broken, the manifest will not ' +
        'parse — also exits 0, loudly. A guard that fails closed on its own ' +
        'bug blocks every push in the repository.',
    ],
    flags: [
      {
        name: '--rev',
        takes: 'commit',
        summary: 'the commit to judge, default HEAD',
      },
      {
        name: '--branch',
        takes: 'name',
        summary: 'branch name, for CI on a detached HEAD',
      },
    ],
  },
  {
    name: 'doctor',
    args: '',
    summary:
      'one read-only report: the config, the workflows, and the registry',
    detail: [
      'Everything `check` deliberately will not say. `check` runs from a hook ' +
        'on every push and has to stay quiet; this is the command you run ' +
        'when something is wrong and you want all of it at once.',
      'Reports the config as resolved, the plan for this branch, drift ' +
        'between the config and the generated workflows, whether the ' +
        'summariser is configured and keyed, and — unless `--offline` — ' +
        'whether the registry has heard of each package.',
      'Exits 1 when it finds something that would fail a release, 0 otherwise.',
    ],
    flags: [
      { name: '--offline', takes: null, summary: 'skip the registry lookups' },
      {
        name: '--branch',
        takes: 'name',
        summary: 'branch name, for CI on a detached HEAD',
      },
    ],
  },
  {
    name: 'explain',
    args: '',
    summary: 'which rule claims this branch, and what else was tried',
    detail: [
      'Read-only, offline, and always exits 0 — a diagnostic that can fail is ' +
        'one more thing to diagnose.',
    ],
    flags: [
      {
        name: '--branch',
        takes: 'name',
        summary: 'branch name, for CI on a detached HEAD',
      },
    ],
  },
  {
    name: 'config',
    args: '',
    summary: 'the effective configuration, defaults merged in',
    detail: [
      'What cutver actually believes, rather than what the file says. Every ' +
        'default is filled in and every channel is normalised, so a key that ' +
        'was ignored because it was misspelt is visible by its absence.',
      'Reads no git and touches no network.',
    ],
    flags: [],
  },
  {
    name: 'init',
    args: '[<ecosystem>]',
    summary: 'set this repository up to release: workflows, config and hook',
    detail: [
      `The ecosystem is detected when omitted, and only has to be given when ` +
        `a repository has more than one manifest. One of ` +
        `${ADAPTER_IDS.length ? 'cargo, node, bun' : ''}.`,
      'Writes two workflows, a CHANGELOG.md stub and a commented cutver.yml, ' +
        'pins cutver as a devDependency where there is a package.json, and ' +
        'installs the pre-push guard unless --no-hook.',
      'Two of those change behaviour rather than just adding a file. The ' +
        'scaffolded cutver.yml declares `release: [main]`, where the default ' +
        'was every branch — so a repository whose trunk is named something ' +
        'else needs that line edited. And the new devDependency is not in ' +
        'your lockfile yet, while the generated workflow installs with ' +
        '--frozen-lockfile, so run your install before pushing.',
      'Deliberately does not require a git repository: scaffolding the ' +
        'workflows is the one thing here that makes sense in a tree that has ' +
        'not been initialised yet.',
      'Nothing is overwritten without `--force`, and `--force` names the ' +
        'files it is about to replace and asks.',
    ],
    flags: [
      {
        name: '--force',
        takes: null,
        summary: 'replace files that are already there',
      },
      {
        name: '--no-hook',
        takes: null,
        summary: 'do not install the pre-push guard',
      },
      {
        name: '--dry-run',
        takes: null,
        summary: 'report what would be written, write nothing',
      },
    ],
    values: ['cargo', 'node', 'bun'],
  },
  {
    name: 'hook',
    args: 'install|uninstall',
    summary: 'install or remove the pre-push guard that runs check',
    detail: [
      'It refuses a push to a release branch whose name promises a lower ' +
        'version than its commits justify. Everything else it lets through, ' +
        'including its own failures. `git push --no-verify` bypasses it.',
    ],
    flags: [
      {
        name: '--force',
        takes: null,
        summary: 'replace a hook that is already there',
      },
      {
        name: '--runner',
        takes: 'cmd',
        summary: 'how the hook should invoke cutver',
      },
      {
        name: '--dry-run',
        takes: null,
        summary: 'report what would be written, write nothing',
      },
    ],
    values: ['install', 'uninstall'],
  },
  {
    name: 'completions',
    args: '<bash|zsh|fish>',
    summary: 'a completion script for that shell, on stdout',
    detail: [
      'Generated from the same command table that prints this help, so a ' +
        'command that exists is a command that completes.',
      "Nothing is installed for you — it goes to stdout and where it belongs is your shell's business.",
    ],
    flags: [],
    values: ['bash', 'zsh', 'fish'],
  },
  {
    name: 'help',
    args: '[command]',
    summary: 'this, or the long form for one command',
    detail: [
      '`cutver help stage` prints what `stage` does and every flag it takes.',
    ],
    flags: [],
  },
  {
    name: 'version',
    args: '',
    summary: 'print the version of cutver itself',
    detail: [],
    flags: [],
  },
]

/**
 * Spellings 2.0 replaced, kept working and kept out of the help.
 *
 * They complete nowhere and appear in no command's flag list, so nobody learns
 * them; they still parse, so no workflow written before 2.0 breaks for a
 * rename. The reference page documents them under their own heading, which is
 * why they are exported rather than buried in the parser.
 */
export const DEPRECATED_FLAGS: readonly Flag[] = [
  { name: '--channel', takes: 'name', summary: 'now `cutver stage <channel>`' },
  {
    name: '--regenerate-changelogs',
    takes: null,
    summary: 'now `cutver changelog`',
  },
]

/**
 * The flags one command accepts — its own, plus the ones every command takes.
 *
 * **`parse` is global, so until this existed nothing refused a flag in the
 * wrong place.** `cutver check --dry-run --runner foo` exited 0 having silently
 * dropped both, and the reference page carefully annotated which command each
 * flag belonged to while nothing enforced it. For a tool whose argument is
 * everywhere else "be loud rather than silent", that was the odd one out.
 *
 * `stage` additionally accepts the deprecated spellings, which is where they
 * were valid before they were deprecated.
 */
export function flagsAllowedFor(command: string): Set<string> {
  const own = COMMANDS.find(c => c.name === command)?.flags ?? []
  const names = [...own, ...GLOBAL_FLAGS].map(f => f.name)
  if (command === 'stage' || command === 'changelog') {
    names.push(...DEPRECATED_FLAGS.map(f => f.name))
  }
  return new Set([...names, '-h', '--help', '-v', '--version'])
}

/** Every flag cutver accepts anywhere, for the docs check. */
export function allFlags(): string[] {
  const named = [
    ...COMMANDS.flatMap(c => c.flags),
    ...GLOBAL_FLAGS,
    ...DEPRECATED_FLAGS,
  ].map(f => f.name)
  return [...new Set([...named, '--help', '--version'])]
}

/** Look a command up by name. `null` for anything that is not one. */
export function commandNamed(name: string | undefined): Command | null {
  return COMMANDS.find(c => c.name === name) ?? null
}

/** `--flag <value>` or `--flag`, padded so a column of them lines up. */
function flagLabel(f: Flag): string {
  return f.takes ? `${f.name} <${f.takes}>` : f.name
}

/**
 * Two aligned columns, the left one styled.
 *
 * Padded on the plain text and coloured after, because an escape code counts
 * as characters — `padEnd` on a styled string aligns the table only while
 * colour is off, which is exactly when nobody is looking at it.
 */
function table(
  rows: readonly [string, string][],
  indent = '  ',
  mark = (s: string) => `%c${s}%0`,
): string {
  const width = Math.max(...rows.map(([l]) => plain(mark(l)).length), 0)
  return rows
    .map(([l, r]) => `${indent}${pad(mark(l), width)}  ${r}`)
    .join('\n')
}

/** A section heading, which is what someone scanning is looking for. */
const heading = (s: string): string => `%<bold>${s}%0`

/** The whole surface, for a bare `cutver` or `cutver help`. */
export function help(version: string): string {
  // The command is what someone is looking for; its arguments are a reminder
  // of the shape. Styled apart so the eye lands on the word it came for.
  const commands = table(
    COMMANDS.map(c => [`${c.name} ${c.args}`.trim(), c.summary]),
    '  ',
    label => {
      const [name, ...rest] = label.split(' ')
      const args = rest.join(' ')
      return `%<bold>${name}%0` + (args ? ` %d${args}%0` : '')
    },
  )
  const globals = table(GLOBAL_FLAGS.map(f => [flagLabel(f), f.summary]))
  const width = Math.max(...GLOBAL_FLAGS.map(f => flagLabel(f).length))

  return `%<bold>cutver ${version}%0 — cut a version from your commit messages.

  %dcutver <command> [options]%0

${heading('Commands')}
${commands}

${heading('Everywhere')}
${globals}
  ${pad('%c-h, --help%0', width)}  this
  ${pad('%c-v, --version%0', width)}  print the version of cutver itself

%d\`cutver help <command>\` for one command in full.%0

It never publishes. It stages a release and prints what to do next.
The release body can be handed to a model — see \`summarizer:\` in the config.
%dDocs: https://cutver.okyle.dev%0`
}

/** One command in full, for `cutver help <name>`. */
export function helpFor(c: Command): string {
  const flags = [...c.flags, ...GLOBAL_FLAGS]
  const body = c.detail.length
    ? `\n${c.detail.map(p => wrap(p)).join('\n\n')}\n`
    : ''
  const options = flags.length
    ? `\n${heading('Options')}\n${table(flags.map(f => [flagLabel(f), f.summary]))}\n`
    : ''

  return (
    `%<bold>cutver ${c.name}%0 %d${c.args}%0`.trimEnd() +
    `\n\n  ${c.summary}\n${body}${options}`
  )
}

/**
 * Hard-wrapped at 78 columns.
 *
 * The detail paragraphs are written as single strings so they are editable as
 * prose rather than as a column of quoted fragments — which means the wrapping
 * has to happen here rather than in the source.
 */
function wrap(text: string, width = 78): string {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) out.push(line)
  return out.join('\n')
}
