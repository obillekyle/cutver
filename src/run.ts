/** Run a command, capture stdout, never throw. Callers decide what a failure means. */
export interface Run {
  ok: boolean
  out: string
  err: string
}

export async function run(cmd: string[], cwd: string): Promise<Run> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { ok: code === 0, out: out.trim(), err: err.trim() }
  } catch (e) {
    // The binary is missing entirely. Same shape as a non-zero exit, because
    // every caller treats both as "no answer" — but the message is kept, since
    // "cargo is not installed" and "cargo failed" want different advice.
    return { ok: false, out: '', err: (e as Error).message }
  }
}
