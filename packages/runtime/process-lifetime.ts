import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

let identity: string | undefined, loaded = false
export function currentBootId(): string | undefined {
  if (loaded) return identity
  loaded = true
  try {
    const value = process.platform === 'linux' ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      : process.platform === 'darwin' ? /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/.exec(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2000 }))?.slice(1).join(':') : undefined
    if (value) identity = createHash('sha256').update(process.platform + ':' + value).digest('hex')
  } catch { /* No boot identity means conservative PID/receipt checks, never a guessed exit. */ }
  return identity
}

export function processExited(pid: number | undefined, observedBootId?: string, group = false): boolean {
  const boot = currentBootId()
  if (boot && observedBootId && boot !== observedBootId) return true
  if (!Number.isSafeInteger(pid) || pid! < 1) return false
  try { process.kill(group && process.platform !== 'win32' ? -pid! : pid!, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
