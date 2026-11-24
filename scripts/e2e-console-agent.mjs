// Real Pi assistant tools with disposable JSONL workers. No source checkout edits.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url))
const project = await mkdtemp(join(tmpdir(), 'pipeline-console-agent-'))
const call = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args, '-C', project, '--json'], { encoding: 'utf8', timeout: 90000, maxBuffer: 4000000 })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error))
  return JSON.parse(result.stdout)
}
const evidence = { project, turns: [] }
const ask = (prompt, ...args) => {
  const result = call('agent', prompt, ...args)
  evidence.turns.push(result)
  console.log(JSON.stringify({ turn: evidence.turns.length, file: result.file, runId: result.run?.id, status: result.run?.status }))
  return result
}
await mkdir(join(project, '.agent-pipeline'))
const fixture = join(project, 'executor.mjs')
await writeFile(fixture, 'for await(const c of process.stdin){};console.log(JSON.stringify({type:"working",text:"Fixture running"}));await new Promise(r=>setTimeout(r,120000));console.log(JSON.stringify({type:"result",outcome:"succeeded",text:"Fixture complete"}));\n')
await writeFile(join(project, '.agent-pipeline/config.json'), JSON.stringify({ executors: { planner: { kind: 'pi' }, fixture: { kind: 'jsonl', executable: process.execPath, args: [fixture] } } }))
await writeFile(join(project, 'README.md'), '# Console tools calibration\nMake a three-step read-only DAG: analyze, improve, review. Workers use the fixture executor and acceptance pwd. No project file changes or external actions.\n')
let runId
try {
  console.log(JSON.stringify({ project }))
  const first = ask('Прочитай README и составь новый YAML с тремя последовательными шагами analyze, improve, review, все agent fixture, acceptance pwd, readOnly true. Сохрани через plan. Только составь план, не запускай.')
  assert.ok(first.file); assert.ok(first.source)
  assert.equal(call('status').runs.length, 0)
  const before = await readFile(first.file, 'utf8')
  const second = ask('Измени только название текущего сценария на console-agent-updated через update. Сохрани все три шага и их зависимости. Не запускай.', '-f', first.file)
  assert.notEqual(second.file, first.file)
  assert.match(second.source, /name: console-agent-updated/)
  assert.equal(await readFile(first.file, 'utf8'), before)
  assert.equal(call('status').runs.length, 0)
  const started = ask('Проверь статус и запусти выбранный план ОДИН раз через control action run. Не жди завершения и не меняй план.', '-f', second.file)
  runId = started.run?.id
  assert.ok(runId)
  const paused = ask('Поставь этот выбранный запуск на паузу через control action pause. Не останавливай уже работающего исполнителя.', '--run', runId)
  assert.equal(paused.run?.status, 'paused')
  const observed = ask('Посмотри свежий статус через status и объясни состояние. Только наблюдение, никаких управляющих действий.', '--run', runId)
  assert.equal(observed.run?.status, 'paused')
  const stopped = ask('Останови выбранный запуск через control action stop и проверь подтверждённый итоговый статус.', '--run', runId)
  assert.equal(stopped.run?.status, 'cancelled')
  const allRuns = call('status').runs
  assert.equal(allRuns.length, 1)
  assert.equal(Object.values(allRuns[0].tasks).flatMap(task => task.attempts).length, 1)
  const usedTools = []
  for (const turn of evidence.turns) {
    const records = (await readFile(turn.sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    usedTools.push(records.flatMap(entry => entry.message?.role === 'assistant' ? entry.message.content.filter(item => item.type === 'toolCall').map(item => item.name) : []))
  }
  assert.ok(usedTools[0].includes('plan')); assert.ok(usedTools[1].includes('update'))
  assert.ok(usedTools[2].includes('control')); assert.ok(usedTools[3].includes('control'))
  assert.ok(usedTools[4].includes('status')); assert.ok(!usedTools[4].includes('control'))
  assert.ok(usedTools[5].includes('control'))
  assert.ok(usedTools.flat().includes('inspect')); assert.ok(!usedTools.flat().includes('write_file'))
  evidence.usedTools = usedTools
  const evidenceFile = join(project, 'e2e-evidence.json')
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ status: 'passed', project, runId, turns: evidence.turns.length, evidenceFile }))
} finally {
  for (const run of call('status').runs) if (['running', 'paused', 'failed'].includes(run.status)) { try { call('stop', '--run', run.id) } catch (error) { console.error(error.message) } }
  try { call('shutdown') } catch (error) { console.error(error.message) }
}
