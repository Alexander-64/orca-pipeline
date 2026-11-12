import type { CommandPolicy } from './types'

const DESTRUCTIVE = /\b(?:sudo|rm|mv|cp|chmod|chown|kill|shutdown|reboot)\b|\bgit\s+(?:push|reset|clean)\b/i
const NETWORK = /\b(?:curl|wget|ssh|scp|nc|ncat|telnet)\b/i
const READ_ONLY = ['pwd', 'ls', 'echo', 'cat', 'git status', 'git diff', 'git show']

function allowedBy(command: string, prefix: string): boolean {
  return command === prefix || command.startsWith(`${prefix} `)
}

export function validateCommand(command: string, policy: CommandPolicy = {}): void {
  const normalized = command.trim()
  if (!normalized) throw new Error('acceptance: пустая команда')
  if (DESTRUCTIVE.test(normalized)) throw new Error(`acceptance: destructive команда запрещена: ${normalized}`)
  if (NETWORK.test(normalized)) throw new Error(`acceptance: сетевая команда требует отдельного разрешения: ${normalized}`)
  if (policy.readOnly && !READ_ONLY.some((prefix) => allowedBy(normalized, prefix))) {
    throw new Error(`acceptance: команда не разрешена в read-only режиме: ${normalized}`)
  }
  if (policy.allowedCommands && !policy.allowedCommands.some((prefix) => allowedBy(normalized, prefix))) {
    throw new Error(`acceptance: команда отсутствует в allowlist: ${normalized}`)
  }
}

export function validateAcceptance(commands: string[], policy?: CommandPolicy): void {
  for (const command of commands) validateCommand(command, policy)
}
