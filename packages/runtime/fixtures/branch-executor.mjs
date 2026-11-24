let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
const decision = process.argv[2] ?? 'improve'
let text, outcome = 'succeeded'
if (prompt.startsWith('Task: Decide')) text = JSON.stringify({ pipelineResult: { version: 1, data: { decision } }, report: 'Independent fixture decision' })
else if (prompt.startsWith('Task: Improve') || prompt.startsWith('Task: Pass')) {
  const expected = decision === 'invalid' ? 'pass' : decision
  if (!prompt.includes(`Validated data: {"decision":"${expected}"}`) || !prompt.includes('Predecessor decide (done)')) { outcome = 'failed'; text = 'Predecessor typed data was not supplied' }
  else text = 'Branch received confirmed predecessor data: ' + expected
} else {
  text = 'Joined predecessor reports.\n' + prompt
  if (!prompt.includes('(skipped)') && !prompt.includes('(failed)')) { outcome = 'failed'; text = 'Missing settled predecessor state' }
}
console.log(JSON.stringify({ type: 'result', outcome, text, ...(outcome === 'failed' ? { error: text } : {}) }))
