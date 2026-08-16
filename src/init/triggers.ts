/**
 * The two lists a generated workflow cannot compute for itself.
 *
 * GitHub needs `on.push.branches` statically — it reads the workflow to decide
 * whether to start it, long before anything could read a config file — and the
 * dist-tag `case` arms have the same problem for the opposite reason: by the
 * time a publish job is running, a channel it cannot name has already been
 * tagged. Both are derived from the config here, once, and written into the
 * file.
 *
 * Which is also why `drift.ts` imports them. A workflow generated from an older
 * config is a workflow that fails after a tag is public, so the check that
 * notices needs the same derivation the generator used — not a second copy of
 * the rules that can disagree with it.
 */
import { RELEASE, type Config } from '../config/schema'
import { shapeOf } from '../config/match'

/**
 * The workflow's `on.push.branches` list, derived from the config.
 *
 * Nine hard-coded literals used to live here, which meant adding a channel took
 * a code change *and* a workflow regeneration. Now the config is the one place.
 *
 * **cutver globs reach GitHub verbatim**, because the two agree: `*` does not
 * cross a `/` in either, and `**` does in both. A translation layer here would
 * be a second place to be wrong about the same thing.
 *
 * A catch-all is dropped **only when there is no config file**, and the
 * distinction is provenance rather than the text. `release: ['**']` is the
 * built-in default meaning "no branch gating configured"; turning that into a
 * trigger would wake CI on every branch in the repository, so `main` stands in.
 * But a repository that *wrote* `['**']` down meant it, and overruling a
 * written rule with a branch that may not even exist is the opposite of what
 * this function is for. Testing the literal text conflated the two, and it
 * silently dropped a `canary: ['**']` as well.
 */
export function branchTriggers(config: Config): string[] {
  const globs = new Set<string>()
  const literals = new Set<string>()
  const stable: string[] = []

  for (const [channel, entries] of Object.entries(config.channels)) {
    // **Per channel, not per file.** A catch-all is dropped when it arrived by
    // inheritance and kept when the file wrote it — the difference is whether
    // anybody decided it. Testing `config.source !== null` conflated the two
    // and broke the moment someone added a `cutver.yml` for `changelog:` and
    // never mentioned channels: `release: ['**']` then read as deliberate, and
    // the workflow was told to trigger on every branch in the repository.
    const declared = config.declaredChannels.includes(channel)

    for (const entry of entries) {
      // A branch that declares its own version triggers on the shape, since
      // the version part is different every time.
      const value =
        shapeOf(entry) === 'declaring' ? entry.replace('{version}', '*') : entry
      if (!declared && (value === '**' || value === '*')) continue

      if (channel === RELEASE) stable.push(value)
      else if (/[*?]/.test(value)) globs.add(value)
      else literals.add(value)
    }
  }

  const release = stable.length ? stable : ['main']
  return [...release, ...[...globs].sort(), ...[...literals].sort()]
}

/**
 * The publish workflow's dist-tag `case`, derived from the same config.
 *
 * Hard-coded arms are what make a configured channel fail *after* its tag and
 * bump commit are already public — the run gets all the way to the last step
 * and hits the catch-all. The catch-all itself stays: refusing an unrecognised
 * prerelease is better than defaulting it to `latest`.
 */
export function distTagArms(config: Config): string[] {
  return Object.keys(config.channels)
    .filter(c => c !== RELEASE)
    .map(
      c =>
        `            ` +
        `*-${c}.*)${' '.repeat(Math.max(1, 10 - c.length))}tag=${c} ;;`,
    )
}
