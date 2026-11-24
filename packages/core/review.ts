import type { FailureInfo, ReviewResult } from './types'

export function validateReview(value: unknown): ReviewResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a versioned review verdict')
  const review = value as Record<string, unknown>
  if (review.version !== 1 || !['SHIP', 'FIX-FIRST', 'BLOCKED'].includes(String(review.verdict)) || typeof review.findings !== 'string' || !review.findings.trim() || review.findings.length > 12_000) throw new Error('Review requires version 1, SHIP/FIX-FIRST/BLOCKED and 1–12000 characters of evidence')
  return { version: 1, verdict: review.verdict as ReviewResult['verdict'], findings: review.findings }
}

export function reviewFromText(text: string): ReviewResult {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text.trim())
  let value: unknown
  try { value = JSON.parse(match?.[1] ?? text.trim()) } catch { throw new Error('Expected JSON {pipelineReview: {version: 1, verdict: "SHIP|FIX-FIRST|BLOCKED", findings: "evidence"}, report: "..."}') }
  return validateReview(value && typeof value === 'object' ? (value as Record<string, unknown>).pipelineReview : undefined)
}

export const reviewInstructions = 'Independent evidence review: do not modify project files. Inspect the author result and actual files. If submit_review is available, call it with SHIP, FIX-FIRST or BLOCKED and concrete findings before finishing. Otherwise return a single JSON object {"pipelineReview":{"version":1,"verdict":"SHIP|FIX-FIRST|BLOCKED","findings":"concrete evidence"},"report":"concise review"}. SHIP means acceptance may pass; FIX-FIRST requests the configured separate repair, BLOCKED rejects the work. Do not fabricate command failures to express a semantic verdict.'

export function failureInfo(value: unknown): FailureInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const failure = value as Record<string, unknown>
  if (failure.version !== 1 || !['executor', 'validation', 'acceptance', 'review', 'cancellation'].includes(String(failure.phase)) || !['quota', 'auth', 'network', 'unknown'].includes(String(failure.kind)) || typeof failure.message !== 'string') return undefined
  return { version: 1, phase: failure.phase as FailureInfo['phase'], kind: failure.kind as FailureInfo['kind'], message: failure.message.slice(0, 12_000) }
}
