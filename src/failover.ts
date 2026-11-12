import type { Attempt, ScenarioStep } from './types'

export type FailureKind = 'quota' | 'auth' | 'network' | 'unknown'

const QUOTA = [
  /usage\s+limit/i,
  /rate\s+limit/i,
  /quota\s+(?:exhausted|exceeded)/i,
  /insufficient[_\s-]?quota/i,
  /resource[_\s-]?exhausted/i,
  /\b429\b/,
  /weekly\s+(?:usage\s+)?limit/i,
  /исчерпан\s+лимит/i
]
const AUTH = [/unauthorized/i, /authentication\s+(?:failed|error)/i, /invalid\s+api\s+key/i, /\b401\b/, /\b403\b/]
const NETWORK = [/network\s+error/i, /connection\s+(?:lost|refused|reset)/i, /host_unavailable/i, /timed?\s*out/i]

export function classifyFailure(output: string): FailureKind {
  if (QUOTA.some((pattern) => pattern.test(output))) return 'quota'
  if (AUTH.some((pattern) => pattern.test(output))) return 'auth'
  if (NETWORK.some((pattern) => pattern.test(output))) return 'network'
  return 'unknown'
}

export function nextAgent(step: ScenarioStep, attempts: Attempt[]): string | undefined {
  const used = new Set(attempts.map((attempt) => attempt.agent))
  return [step.agent, ...step.fallback].find((agent) => !used.has(agent))
}

export function redactSecrets(input: string): string {
  return input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|xoxb)[_-][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
}

export function handoffFor(step: ScenarioStep, attempts: Attempt[]): string {
  const history = attempts.map((attempt, index) => {
    const lines = [
      `Attempt ${index + 1}: ${attempt.agent} — ${attempt.status}${attempt.reason ? ` (${attempt.reason})` : ''}`,
      `Time: ${attempt.startedAt}${attempt.finishedAt ? ` → ${attempt.finishedAt}` : ''}`
    ]
    if (attempt.filesModified?.length) lines.push(`Files: ${attempt.filesModified.join(', ')}`)
    if (attempt.checks?.length) {
      lines.push('Checks:', ...attempt.checks.map((check) => `- ${check.command} → ${check.exitCode ?? 'unknown'}`))
    }
    if (attempt.output) lines.push(`Output (redacted, bounded):\n${redactSecrets(attempt.output.slice(-4_000))}`)
    return lines.join('\n')
  }).join('\n\n')
  return [
    'Continuation checkpoint v1',
    `Step: ${step.id} — ${step.title}`,
    'Продолжи в том же workspace с текущего состояния. Не начинай задачу заново и не повторяй подтверждённую работу. Сначала проверь git status/diff и существующие артефакты.',
    `Acceptance, требующий подтверждения:\n${step.acceptance.map((command) => `- ${command}`).join('\n')}`,
    `Attempts:\n${history || 'Предыдущий вывод недоступен.'}`,
    'После продолжения приложи к worker_done список изменённых файлов и фактические результаты всех проверок.'
  ].join('\n\n').slice(0, 12_000)
}
