/**
 * Running other programs, which is the half of this port with a real seam.
 *
 * Two shapes, and they are not variations of each other:
 *
 * - **An argument array** — `['git', 'tag', '--list']`. No shell is involved on
 *   either runtime, so nothing is quoted, split or expanded, and a branch named
 *   `feat/it's fine` cannot become two arguments. This is every internal call.
 * - **A command line** — whatever `CUTVER_SUMMARIZE` holds. That is a string a
 *   person wrote expecting a shell to read it, so a shell has to.
 */
import { spawn } from 'node:child_process'

/** Run a command, capture stdout, never throw. Callers decide what a failure means. */
export interface Run {
  ok: boolean
  out: string
  err: string
}

/** The array form. Every internal call — git, cargo, chmod — is one of these. */
export function runCommand(cmd: string[], cwd: string): Promise<Run> {
  return new Promise(resolve => {
    const [file, ...args] = cmd
    if (!file) return resolve({ ok: false, out: '', err: 'no command given' })

    let out = ''
    let err = ''

    // `shell: false` is the default and is load-bearing: with it on, a path
    // containing a space or an ampersand would be re-parsed by cmd.exe.
    const child = spawn(file, args, { cwd, shell: false })

    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))

    // The binary is missing entirely. Same shape as a non-zero exit, because
    // every caller treats both as "no answer" — but the message is kept, since
    // "cargo is not installed" and "cargo failed" want different advice.
    child.on('error', e =>
      resolve({ ok: false, out: '', err: (e as Error).message }),
    )
    child.on('close', code =>
      resolve({ ok: code === 0, out: out.trim(), err: err.trim() }),
    )
  })
}

export interface ShellRun {
  ok: boolean
  out: string
  code: number
}

/**
 * A command line the user wrote, fed `input` on stdin.
 *
 * **The platform's shell, which is a change from Bun Shell.** `CUTVER_SUMMARIZE`
 * used to be parsed by Bun Shell, which implements POSIX syntax itself on every
 * platform — so one command string behaved identically on a Windows runner and
 * a Linux one. `shell: true` is `/bin/sh` on Unix and `cmd.exe` on Windows
 * instead, so a command relying on POSIX quoting or pipes now needs to suit the
 * platform it runs on. Documented rather than emulated: shipping half a shell
 * would fail in subtler ways than using the real one.
 *
 * Never throws. A missing binary, a non-zero exit and a line the shell cannot
 * parse all come back the same way, because the caller publishes the notes as
 * written for all three.
 */
export async function runShell(
  command: string,
  input: string,
): Promise<ShellRun> {
  return new Promise(resolve => {
    let out = ''
    const child = spawn(command, { shell: true })

    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => resolve({ ok: false, out: '', code: 1 }))
    child.on('close', code => resolve({ ok: code === 0, out, code: code ?? 1 }))

    // Written after the handlers are attached, so a command that exits before
    // reading — or never reads at all — cannot take the process down with an
    // unhandled EPIPE.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}
