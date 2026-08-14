/**
 * `cutver explain` — which rule claimed this branch, and what was tried.
 *
 * Once branch matching is configurable, "why did my branch not release" stops
 * having an obvious answer. Without this the only way to find a typo in a
 * pattern is to edit it and push again, which is a slow loop for a question
 * with a local answer.
 *
 * A pure report builder: it returns lines and `cli.ts` prints them, for the
 * same reason `plan.ts` returns a `Plan` instead of writing to a terminal.
 */
import { matchBranch, type Match } from './config/match'
import { RELEASE, type Config } from './config/schema'

export interface ExplainInput {
  root: string
  branch: string
  config: Config
  /** Which adapter was chosen, and whether a flag forced it. */
  adapter: string
  adapterFrom: 'flag' | 'config' | 'detected'
  /** The plan's own one-line summary, when there was one. */
  plan: string | null
}

function describe(match: Match): string {
  switch (match.kind) {
    case 'channel':
      return (
        `channel \`${match.channel}\` via ${match.shape} "${match.via}"` +
        (match.declared
          ? `  (base ${match.declared}, declared by the branch)`
          : '  (base computed from commits)')
      )
    case 'release':
      return `stable release via ${match.shape} "${match.via}"`
    case 'none':
      return 'nothing — this branch may not release'
  }
}

export function explainReport(input: ExplainInput): string[] {
  const { config, branch } = input
  const lines = [`cutver: ${input.root}`]

  lines.push(`  config    ${config.source ?? 'none, using built-in defaults'}`)
  lines.push(`  target    ${input.adapter}  (${input.adapterFrom})`)
  lines.push(`  branch    '${branch}'`)

  let match: Match | null = null
  try {
    match = matchBranch(branch, config)
    lines.push(`  rule      ${describe(match)}`)
  } catch (e) {
    // An ambiguous config is exactly the thing someone runs this to diagnose,
    // so it is reported here rather than thrown out of a diagnostic command.
    lines.push(`  rule      REFUSED — ${(e as Error).message.split('\n')[0]}`)
  }

  // What was tried, and did not fire. This is the half that turns "nothing
  // matched" from a bisect into a read.
  const fired = match?.kind === 'channel' ? match.channel : match?.kind === 'release' ? RELEASE : null
  const others = Object.entries(config.channels).filter(([name]) => name !== fired)
  if (others.length) {
    lines.push(`            tried:`)
    for (const [name, entries] of others) {
      lines.push(`                   ${name} [${entries.join(', ')}] — no`)
    }
  }

  lines.push(`  plan      ${input.plan ?? 'nothing to release'}`)
  return lines
}
