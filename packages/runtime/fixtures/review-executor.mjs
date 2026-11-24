import { readFile, writeFile } from 'node:fs/promises'
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
const mode = process.argv[2]
const evidence = prompt.includes('Evidence Gate: Author')
let text
if (evidence) {
  const content = await readFile('report.txt', 'utf8')
  const verdict = mode === 'blocked' ? 'BLOCKED' : content.trim() === 'READY' ? 'SHIP' : 'FIX-FIRST'
  text = JSON.stringify({ pipelineReview: { version: 1, verdict, findings: verdict === 'BLOCKED' ? 'Missing external input; FIX-FIRST cannot resolve it.' : `Observed report.txt=${content.trim()}; required READY.` }, report: 'Independent file inspection' })
} else if (mode === 'quota-report') text = 'Example log mentions quota exceeded 429; the executor itself succeeded.'
else {
  const repaired = prompt.includes('Исправление') && mode !== 'always-fix'
  await writeFile('report.txt', repaired ? 'READY\n' : 'DRAFT\n')
  text = repaired ? 'Repaired report.txt to READY' : 'Created intentional DRAFT calibration defect'
}
console.log(JSON.stringify({ type: 'result', outcome: 'succeeded', text }))
