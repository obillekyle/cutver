/**
 * `Bun.semver.order`, for Node.
 *
 * One caller: sorting tags that share a commit timestamp, in `lastStableTag`.
 * That happens whenever two tags land in the same second, which is exactly what
 * a scripted release does — so the tiebreaker decides which version cutver
 * measures from, and getting it backwards would compute the next version from
 * the wrong baseline.
 *
 * Implemented rather than depended on. The rules are short, they are frozen by
 * the spec, and the alternative is carrying a package to compare two strings.
 */

/** Numeric where both sides are numeric, ASCII otherwise. */
function compareIdentifier(a: string, b: string): number {
  const numeric = /^\d+$/
  const aNum = numeric.test(a)
  const bNum = numeric.test(b)

  // "Identifiers consisting of only digits are compared numerically" — so
  // `beta.9` sorts below `beta.10`, where a string compare puts it above. This
  // is the entire reason cutver emits `-rc.N` with the counter as its own
  // dot-separated identifier.
  if (aNum && bNum) return Number(a) - Number(b)

  // "Numeric identifiers always have lower precedence than non-numeric."
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** `1.2.3-rc.1` into its parts, ignoring build metadata, which has no precedence. */
function parse(version: string): { main: number[]; pre: string[] } {
  const [withoutBuild] = version.split('+')
  const dash = (withoutBuild as string).indexOf('-')
  const main = (
    dash < 0 ? withoutBuild : (withoutBuild as string).slice(0, dash)
  ) as string
  const pre = dash < 0 ? '' : (withoutBuild as string).slice(dash + 1)

  return {
    main: main.split('.').map(n => Number(n) || 0),
    pre: pre ? pre.split('.') : [],
  }
}

/**
 * Negative when `a` has lower precedence, positive when higher, 0 when equal.
 *
 * Matches `Bun.semver.order`'s signature and ordering, which the parity test
 * in `runtime/index.test.ts` checks against Bun's own answer rather than
 * against a table someone wrote out by hand.
 */
export function order(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)

  for (let i = 0; i < 3; i++) {
    const diff = (left.main[i] ?? 0) - (right.main[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }

  // "A pre-release version has lower precedence than the associated normal
  // version" — so 1.0.0-rc.1 < 1.0.0, and an empty prerelease wins.
  if (!left.pre.length && !right.pre.length) return 0
  if (!left.pre.length) return 1
  if (!right.pre.length) return -1

  const shared = Math.min(left.pre.length, right.pre.length)
  for (let i = 0; i < shared; i++) {
    const diff = compareIdentifier(
      left.pre[i] as string,
      right.pre[i] as string,
    )
    if (diff !== 0) return diff < 0 ? -1 : 1
  }

  // "A larger set of pre-release fields has a higher precedence than a smaller
  // set, if all of the preceding identifiers are equal": 1.0.0-rc < 1.0.0-rc.1.
  const diff = left.pre.length - right.pre.length
  return diff === 0 ? 0 : diff < 0 ? -1 : 1
}
