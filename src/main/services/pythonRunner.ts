import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RunRequest, RunResult } from '@shared/types'
import { logger } from '@main/logger'

const RUN_TIMEOUT_MS = 10_000
const MAX_OUTPUT_CHARS = 20_000

/** Candidate interpreter commands to probe, in order. Windows favors the `py` launcher. */
const CANDIDATES =
  process.platform === 'win32'
    ? [{ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }]

let cachedInterpreter: { cmd: string; args: string[] } | null | undefined

function findInterpreter(): { cmd: string; args: string[] } | null {
  if (cachedInterpreter !== undefined) return cachedInterpreter
  for (const candidate of CANDIDATES) {
    try {
      const probe = spawnSync(candidate.cmd, [...candidate.args, '--version'], {
        timeout: 3000,
        windowsHide: true
      })
      if (probe.status === 0) {
        cachedInterpreter = candidate
        logger.info('pythonRunner', `Using interpreter: ${candidate.cmd} ${candidate.args.join(' ')}`)
        return candidate
      }
    } catch {
      // try next candidate
    }
  }
  cachedInterpreter = null
  logger.warn('pythonRunner', 'No Python interpreter found on PATH (tried py/python/python3).')
  return null
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '\n…(truncated)' : s
}

async function runPython(code: string, stdin: string | undefined): Promise<RunResult> {
  const interpreter = findInterpreter()
  if (!interpreter) {
    return {
      ok: false,
      stdout: '',
      stderr:
        'No Python interpreter found on PATH. Install Python 3 (python.org) or the "py" launcher, then restart the app.',
      exitCode: null,
      durationMs: 0,
      timedOut: false
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'prep-copilot-'))
  const file = join(dir, `solution_${randomUUID().slice(0, 8)}.py`)
  await writeFile(file, code, 'utf8')

  const started = Date.now()
  try {
    return await new Promise<RunResult>((resolve) => {
      const child = spawn(interpreter.cmd, [...interpreter.args, file], {
        cwd: dir,
        windowsHide: true
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      const killTimer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, RUN_TIMEOUT_MS)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })

      if (stdin) {
        child.stdin.write(stdin)
      }
      child.stdin.end()

      child.on('error', (err) => {
        clearTimeout(killTimer)
        resolve({
          ok: false,
          stdout: truncate(stdout),
          stderr: truncate(stderr + '\n' + String(err)),
          exitCode: null,
          durationMs: Date.now() - started,
          timedOut
        })
      })

      child.on('close', (code) => {
        clearTimeout(killTimer)
        resolve({
          ok: code === 0 && !timedOut,
          stdout: truncate(stdout),
          stderr: truncate(timedOut ? stderr + `\n(killed after ${RUN_TIMEOUT_MS}ms timeout)` : stderr),
          exitCode: code,
          durationMs: Date.now() - started,
          timedOut
        })
      })
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Runs submitted code. Python actually executes locally via child_process.
 * Other languages aren't wired to a real toolchain yet — v1 scope is Python first —
 * so they get a clearly-labeled mock result instead of a silent failure.
 */
export async function runCode(req: RunRequest): Promise<RunResult> {
  if (req.language === 'python') {
    return runPython(req.code, req.stdin)
  }

  return {
    ok: true,
    stdout: `(mock runner) Real execution for "${req.language}" isn't wired up yet — only Python runs for real in v1.`,
    stderr: '',
    exitCode: 0,
    durationMs: 0,
    timedOut: false
  }
}
