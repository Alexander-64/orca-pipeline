let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
console.log(JSON.stringify({ type: 'working', text: 'fixture activity' }))
await new Promise(resolve => setTimeout(resolve, Number(process.argv[2] ?? 50)))
const mode = process.argv[3]
if (mode === 'bad-json') console.log('not JSON')
else if (mode === 'quota') console.log(JSON.stringify({ type: 'result', outcome: 'failed', error: 'quota exceeded 429' }))
else console.log(JSON.stringify({ type: 'result', outcome: 'succeeded', text: `Fixture report: ${prompt.slice(0, 150)}\nIndependent context verified by process ${process.pid}` }))
