/**
 * `cutver hook install` — a pre-push guard.
 *
 * **The check it runs already exists.** A release branch named `1.3.0-beta`
 * declares its base, and cutver refuses to cut a release when the commits imply
 * a higher one: a `feat!` on a `1.3.0-beta` branch means 2.0.0, and publishing
 * 1.3.0 would ship a breaking change as a minor. The same `feat!` on a
 * `2.0.0-beta` branch is fine, because there the declared base and the implied
 * base agree.
 *
 * What the hook changes is *when you find out*. Without it the refusal happens
 * in CI, after the commit is public and after everyone has pulled it; the fix
 * is a branch rename, which is cheap before a push and awkward after one.
 *
 * **It fails open on anything that is not that refusal.** cutver missing, git
 * broken, a manifest that will not parse — the push goes through and the hook
 * says why. A guard that blocks every push because it crashed is worse than no
 * guard, and CI still catches the real thing. `git push --no-verify` is the
 * escape hatch for the refusal itself, and it is git's own, so nothing here has
 * to invent one.
 */
import { hooksDir } from './git'
import { run } from './run'

export const HOOK_NAME = 'pre-push'

/** Marks the file as ours, so `install` can tell its own hook from someone else's. */
export const MARKER = '# installed by `cutver hook install`'

/** GitHub release assets, by what `uname` says. Matches `scripts/build.ts`. */
const PLATFORM_CASE = `  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) echo "cutver-windows-x64.exe"; return 0 ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) return 1 ;;
  esac
  echo "cutver-$os-$arch"`

/**
 * How the hook finds cutver.
 *
 * Tried in order, and the order is the point.
 *
 * `cutver` on PATH, then `bunx`, then `npx` — *not* pinned at install time, so
 * a repository that adds cutver as a devDependency next month gets the local
 * copy without reinstalling the hook. Both `bunx` and `npx` prefer
 * `node_modules/.bin` over the registry, so the local copy wins by itself.
 *
 * **Then the release binary**, which is what makes this work at all in a
 * repository with no JavaScript runtime — a Rust workspace, a Go module, a
 * bare deployment checkout. Every release attaches an executable per platform,
 * so there is something to fetch; it lands in `.git/cutver`, which is never
 * committed and never needs a gitignore entry, and it is fetched once rather
 * than per push.
 *
 * Only then does it give up, and giving up lets the push through.
 */
function runner(explicit: string | undefined, base: string): string {
  if (explicit) return `RUN="${explicit}"`

  return `cutver_asset() {
${PLATFORM_CASE}
}

# Downloaded once into .git/, which is never committed and needs no gitignore
# entry. Keyed by URL so a re-pinned hook fetches its own version rather than
# reusing whatever happened to be cached.
cutver_download() {
  asset=$(cutver_asset) || return 1
  dir="$(git rev-parse --git-dir)/cutver"
  bin="$dir/$asset"

  [ -x "$bin" ] && { echo "$bin"; return 0; }
  mkdir -p "$dir" || return 1

  echo "cutver: fetching the release binary once into .git/cutver (~95 MB)" >&2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$bin" "${base}/$asset" || { rm -f "$bin"; return 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$bin" "${base}/$asset" || { rm -f "$bin"; return 1; }
  else
    return 1
  fi

  chmod +x "$bin" || return 1
  echo "$bin"
}

if command -v cutver >/dev/null 2>&1; then
  RUN="cutver"
elif command -v bunx >/dev/null 2>&1; then
  RUN="bunx cutver"
elif command -v npx >/dev/null 2>&1; then
  RUN="npx --yes cutver"
elif RUN=$(cutver_download); then
  : # the portable executable, no runtime required
else
  echo "cutver: not available and could not be fetched, skipping the check" >&2
  exit 0
fi`
}

export interface ScriptOptions {
  /** Pin the command instead of detecting one. */
  runner?: string | undefined
  /**
   * Which release to download from, when nothing else is available. A known
   * version pins the tag; without one it falls back to GitHub's `latest`,
   * which **skips prereleases** — so a project still in beta must pin.
   */
  version?: string | undefined
}

const RELEASES = 'https://github.com/obillekyle/cutver/releases'

export function downloadBase(version?: string): string {
  return version && version !== 'dev'
    ? `${RELEASES}/download/v${version}`
    : `${RELEASES}/latest/download`
}

export function hookScript({
  runner: explicit,
  version,
}: ScriptOptions = {}): string {
  return `#!/bin/sh
${MARKER}
#
# Refuses a push to a release branch whose name promises a lower version than
# its commits justify — a \`feat!\` on \`1.3.0-beta\` implies 2.0.0, and cutting
# 1.3.0 from it would ship a breaking change as a minor. The same commit on
# \`2.0.0-beta\` is fine and passes.
#
# Anything other than that refusal lets the push through: this is a convenience
# that moves a CI failure earlier, not a second opinion on whether your code is
# good. Bypass with \`git push --no-verify\`.

set -u

${runner(explicit, downloadBase(version))}

# stdin is one line per ref: <local ref> <local sha> <remote ref> <remote sha>
ZERO=0000000000000000000000000000000000000000

while read -r local_ref local_sha _remote_ref _remote_sha; do
  # Tags and deletions carry no commits to judge.
  case "$local_ref" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  [ "$local_sha" = "$ZERO" ] && continue

  branch=\${local_ref#refs/heads/}

  # --rev, because the ref being pushed is not always the one checked out.
  $RUN check --branch "$branch" --rev "$local_sha" || exit 1
done

exit 0
`
}

export interface HookResult {
  path: string
  state: 'written' | 'skipped'
  detail: string
}

export interface InstallOptions extends ScriptOptions {
  force?: boolean
  dryRun?: boolean
}

/**
 * Where this repository's pre-push hook lives.
 *
 * `hooksDir` answers relative to the repository root for an ordinary checkout
 * and absolutely for a worktree, so both are handled here — once. Written out
 * at each call site, the rule's explanation sat on only one of the two copies,
 * and an uninstall that kept looking in the old place would be silent.
 */
async function hookPath(root: string): Promise<string> {
  const dir = await hooksDir(root)
  if (!dir) throw new Error("could not find this repository's hooks directory")

  return dir.startsWith('/') || /^[A-Za-z]:/.test(dir)
    ? `${dir}/${HOOK_NAME}`
    : `${root}/${dir}/${HOOK_NAME}`
}

export async function installHook(
  root: string,
  {
    force = false,
    dryRun = false,
    runner: explicit,
    version,
  }: InstallOptions = {},
): Promise<HookResult> {
  const path = await hookPath(root)
  const existing = await Bun.file(path)
    .text()
    .catch(() => null)

  // Ours is replaceable without ceremony — it is generated, and an old copy is
  // worth nothing. Somebody else's is a file they wrote, and silently
  // overwriting a pre-push hook is how a repository loses a guard it thought
  // it had.
  if (existing !== null && !existing.includes(MARKER) && !force) {
    return {
      path: HOOK_NAME,
      state: 'skipped',
      detail:
        'a pre-push hook is already there and is not ours — --force to ' +
        'replace it',
    }
  }

  if (!dryRun) {
    await Bun.write(path, hookScript({ runner: explicit, version }))
    // Bun.write does not set a mode, and git skips a hook it cannot execute —
    // silently, which would make this look installed and do nothing. Windows
    // has no execute bit and git for Windows does not check for one.
    if (process.platform !== 'win32') await run(['chmod', '+x', path], root)
  }

  return {
    path: HOOK_NAME,
    state: 'written',
    detail: existing === null ? 'created' : 'replaced',
  }
}

export async function uninstallHook(
  root: string,
  { dryRun = false } = {},
): Promise<HookResult> {
  const path = await hookPath(root)
  const existing = await Bun.file(path)
    .text()
    .catch(() => null)

  if (existing === null) {
    return { path: HOOK_NAME, state: 'skipped', detail: 'not installed' }
  }
  if (!existing.includes(MARKER)) {
    return {
      path: HOOK_NAME,
      state: 'skipped',
      detail: 'not ours — left alone',
    }
  }

  if (!dryRun) await Bun.file(path).delete()
  return { path: HOOK_NAME, state: 'written', detail: 'removed' }
}
