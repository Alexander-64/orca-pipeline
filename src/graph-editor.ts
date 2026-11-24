import type {} from 'orca/frame'
import { parseScenario, serializeScenario } from './scenario'
import { connectSteps, disconnectSteps, deleteStep, insertStep, patchStep, validateGraph, waves } from './editor'
import { agentOptions } from './agents'
import type { Scenario, ScenarioStep } from './types'
import { appendCondition, conditionLabel, conditionValue, filterCondition, parseCondition, parseOutputSchema, predecessorFields, predicates } from '../packages/core/results'
import type { Predicate } from './types'

import { diagnosticText } from './diagnostics'
import { translate, languageOf, type Message } from './i18n'

let language = languageOf(await orca.settings.get('interfaceLanguage'))
const t = (key: Message, ...values: unknown[]) => translate(language, key, ...values)
document.documentElement.lang = language

const style = document.createElement('style')
style.textContent = `
html,body{height:100%;overflow:hidden;color-scheme:dark}*{box-sizing:border-box}body{display:flex;flex-direction:column;margin:0;font:14px system-ui;color:var(--orca-foreground,#e4e7f1);background:var(--orca-background,#1d202b)}
button,input,textarea,select{font:inherit;color:inherit;background:#ffffff09;border:1px solid #8994b044;border-radius:7px;padding:8px}button{cursor:pointer}button:hover{background:#9b83ef30}button:disabled{opacity:.4;cursor:default}button.primary{background:#7955c3;color:white}label{display:flex;flex-direction:column;gap:6px;margin:12px 0}textarea{width:100%;resize:vertical}header{flex-shrink:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px;border-bottom:1px solid #8994b044}header strong{margin-right:auto}#status{flex-shrink:0;padding:10px 16px;min-height:39px;color:#aeb9d1}.error{color:#ff9d9d!important}.layout{display:grid;grid-template-columns:minmax(400px,1fr) 360px;flex:1;min-height:0}.canvas{position:relative;overflow:auto;background-image:radial-gradient(#8891ac35 1px,transparent 1px);background-size:20px 20px}.world{position:relative;min-width:1100px;min-height:800px;transform-origin:0 0}svg{position:absolute;inset:0;overflow:visible;pointer-events:none}.edge{fill:none;stroke:#a58de2;stroke-width:2.5;pointer-events:stroke;cursor:pointer}.edge:focus,.edge:hover{stroke:#d3baff;stroke-width:5}.node{position:absolute;width:240px;border:1px solid #8994b066;border-radius:12px;background:var(--orca-background,#262936);box-shadow:0 5px 20px #0002;padding:16px;cursor:grab;user-select:none}.node.selected{border:2px solid #b49ae9}.node strong{display:block;padding-bottom:8px}.node small{display:block;color:#aeb9d1;margin-top:8px;line-height:1.4}.port{position:absolute;width:21px;height:21px;border-radius:50%;padding:0;background:#ae92eb;border:3px solid #303448;top:34px}.port.input{left:-11px}.port.output{right:-11px}.node.pending{border-color:#e7c55e}aside{overflow:auto;border-left:1px solid #8994b044;padding:16px}.hint{color:#aeb9d1;font-size:12px;line-height:1.5}.yaml{display:none;width:100%;flex:1;min-height:0;border:0;padding:20px;resize:none;font:14px/1.6 ui-monospace,monospace;white-space:pre;tab-size:2}.yaml.visible{display:block}.layout.hidden{display:none}.row{display:flex;gap:8px;flex-wrap:wrap}aside h3{margin-top:0}select option{color:#202334} :fullscreen{background:var(--orca-background,#1d202b)}
.expanded .layout{grid-template-columns:1fr;position:relative}.expanded aside{max-width:100%;position:absolute;right:0;top:0;bottom:0;width:360px;background:var(--orca-background,#252835);z-index:2;box-shadow:-8px 0 30px #0004}.collapsed{display:none}@media(max-width:800px){.layout{grid-template-columns:minmax(0,1fr);grid-template-rows:55vh auto;height:auto}aside{min-width:0;border-top:1px solid #8994b044}aside input,aside select,aside textarea{min-width:0;max-width:100%}.canvas{min-height:55vh}}
`
document.head.append(style)
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const el = document.createElement(tag); if (text) el.textContent = text; return el }
const header = make('header')
const heading = make('strong', t("Pipeline · graph and YAML")); header.append(heading)
const status = make('div'); status.id = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
const layout = make('div'); layout.className = 'layout'
const canvas = make('div'); canvas.className = 'canvas'; canvas.setAttribute('aria-label', t("Pipeline graph"))
const world = make('div'); world.className = 'world'; canvas.append(world)
const aside = make('aside'); aside.setAttribute('aria-label', t("Selected step settings"))
const yaml = make('textarea'); yaml.className = 'yaml'; yaml.setAttribute('aria-label',t("Scenario YAML")); yaml.spellcheck = false
layout.append(canvas, aside); document.body.append(header,status,layout,yaml)
const session = await orca.document!.session({ debounceMs: 150 })
let scenario: Scenario | null = null, selected = '', connecting: string | null = null, invalid = false
let edgeSource: string | null = null
let positions = new Map<string, { x: number; y: number }>()
const undo: string[] = [], redo: string[] = []
let source = session.value
let workspaceId: string | undefined
const headerFor = (text: string) => workspaceId && !text.includes('# agent-pipeline-workspace:') ? `# agent-pipeline-workspace: ${JSON.stringify(workspaceId)}\n${text}` : text
const say = (text: string, error = false) => { status.textContent = error ? diagnosticText(language, text) : text; status.className = error ? 'error' : '' }
const button = (text: string, action: () => unknown, parent: HTMLElement = header) => {
  const el = make('button',text); el.addEventListener('click',()=>Promise.resolve().then(action).catch(error=>say(String(error),true))); parent.append(el); return el
}
const headerLabels = new Map<HTMLButtonElement, Message>()
function headerButton(key: Message, action: () => unknown) {
  const element = button(t(key), action)
  headerLabels.set(element, key)
  return element
}
const mode = button('YAML', () => { const on = !yaml.classList.contains('visible'); yaml.classList.toggle('visible',on); layout.classList.toggle('hidden',on); mode.textContent = on ? t("Graph") : 'YAML' })
headerButton("Add successor", () => mutate(graph => insertStep(graph, selected || undefined, undefined, language), true))
headerButton("Parallel branch", () => mutate(graph => insertStep(graph, undefined, undefined, language), true))
headerButton("Auto-layout", () => { positions.clear(); render(); saveLayout() })
headerButton("Undo", () => history(false))
headerButton("Redo", () => history(true))
let expanded = false
const fullscreen = headerButton("Expand graph", () => {
  expanded = !expanded
  document.body.classList.toggle('expanded', expanded)
  aside.classList.toggle('collapsed', expanded)
  fullscreen.textContent = expanded ? t("Standard view") : t("Expand graph")
  say(expanded ? t("The graph fills the tab. Step settings open over the graph. Press Esc to restore the standard view.") : t("The graph and settings are side by side."))
})
headerButton("Step settings", () => aside.classList.toggle('collapsed'))
const publish = headerButton("Apply to pipeline", async () => {
  if (invalid || !scenario) throw new Error(t("Fix the YAML first"))
  await session.flush()
  await orca.plugin.request('editor.publish', { source, workspaceId })
  say(t("Scenario applied. Open 3. Launch in the pipeline panel."))
});publish.className='primary'
function load(next: string) {
  const identity = next.match(/^# agent-pipeline-workspace: (.+)$/m)
  if(identity){try{workspaceId=JSON.parse(identity[1])}catch{}}
  source = next; yaml.value = next
  try { scenario = parseScenario(next, { expandEvidence: false }); invalid = false; if (scenario.layout) for (const [id, pos] of Object.entries(scenario.layout)) if(!positions.has(id)) positions.set(id, pos); selected = scenario.steps.some(step=>step.id===selected) ? selected : scenario.steps[0].id; render(); say(t("Drag between ports, or use Tab and Enter to select an output and then an input. Select a connection to inspect or remove it.")); }
  catch (error) { invalid = true; say(t("Waiting for a plan, or invalid YAML: {0}", diagnosticText(language, String(error))),true) }
  publish.disabled = invalid || session.readOnly
}
function commit(next: string) {
  if (session.readOnly) throw new Error(t("This document is read-only"))
  undo.push(source); redo.length=0; load(next); session.change(next)
}
function history(forward: boolean) {
  if (session.readOnly) return
  const from = forward ? redo : undo, to = forward ? undo : redo
  const next = from.pop(); if (next===undefined) return
  to.push(source); load(next); session.change(next)
}
function mutate(operation: (scenario: Scenario)=>Scenario, last = false) {
  if (invalid || !scenario) throw new Error(t("Fix the YAML before editing the graph"))
  const next = validateGraph(operation(scenario))
  if(last) selected = next.steps.at(-1)!.id
  commit(headerFor(serializeScenario(next)))
}
function saveLayout() {
  if(scenario && !invalid) mutate(graph => ({ ...graph, layout: Object.fromEntries(positions) }))
}
function field(label: string, value: string, multiline = false) {
  const wrapper=make('label',label), input=make(multiline ? 'textarea' : 'input')
  input.value=value; if(input instanceof HTMLTextAreaElement)input.rows=5
  wrapper.append(input); aside.append(wrapper); return input
}
function selectField(label: string, options: { value: string; label: string }[], value: string) {
  const wrap = make('label', label), input = make('select')
  for (const option of options) { const el = make('option', option.label); el.value = option.value; input.append(el) }
  input.value = value; wrap.append(input); aside.append(wrap); return input
}
let currentCondition: (() => ScenarioStep['when']) | undefined
function inspector(step: ScenarioStep) {
  aside.replaceChildren(make('h3',step.title),make('p',`ID: ${step.id}`))
  const title=field(t("Title"),step.title), spec=field(t("Instructions"),step.spec,true)
  const wrap=make('label',t("Agent")), agent=make('select')
  for(const option of agentOptions([], [step.agent,...step.fallback])){const el=make('option',option.label);el.value=option.value;agent.append(el)}
  agent.value=step.agent;wrap.append(agent);aside.append(wrap)
  const fallback=field(t("Fallback agents, comma-separated"),step.fallback.join(', '))
  const acceptance=field(t("Checks, one command per line"),step.acceptance.join('\n'),true)
  const taskDetails = make('details'), taskSummary = make('summary', t("Instructions, fallback agents and checks"))
  taskDetails.append(taskSummary, spec.parentElement!, fallback.parentElement!, acceptance.parentElement!); aside.append(taskDetails)
  const approval=field(t("Manual approval before step"),step.approval??'')
  const join = selectField(t("Join dependencies"), [{ value: 'all_success', label: t("All predecessors succeed") }, { value: 'all_settled', label: t("All predecessors finish, including failures and skips") }], step.join ?? 'all_success')
  aside.append(make('h4', t("Output conditions")))
  if (edgeSource) aside.append(make('p', t("Selected connection {0} → {1}", edgeSource, step.id)))
  let when = step.when
  currentCondition = () => when
  const conditions = make('div'); aside.append(conditions)
  const renderConditions = () => {
    conditions.replaceChildren(make('p', when ? conditionLabel(when, language) : t("No output condition")))
    for (const [index, predicate] of (when ? predicates(when) : []).entries()) {
      const row = make('div', conditionLabel(predicate, language)); conditions.append(row)
      button(t("Remove condition {0}", index + 1), () => { let position = 0; when = filterCondition(when, () => position++ !== index); renderConditions() }, row)
    }
  }
  renderConditions()
  const fields = predecessorFields(step, scenario!.steps)
  if (fields.length) {
    const initial = fields.find(field => field.step === edgeSource) ?? fields[0]
    const source = selectField(t("Predecessor field"), fields.map(field => ({ value: `${field.step}:${field.field}`, label: `${field.step}.${field.field} · ${field.type}` })), `${initial.step}:${initial.field}`)
    const op = selectField(t("Comparison"), ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists'].map(value => ({ value, label: value })), 'eq')
    const value = field(t("Condition value"), initial.enum ? String(initial.enum[0]) : initial.type === 'boolean' ? 'true' : '')
    const group = selectField(t("Combine with"), [{ value: 'all', label: t("AND · all checks") }, { value: 'any', label: t("OR · any check") }], 'all')
    source.addEventListener('change', () => {
      const current = fields.find(field => `${field.step}:${field.field}` === source.value)!
      op.value = 'eq'; value.value = current.enum ? String(current.enum[0]) : current.type === 'boolean' ? 'true' : ''
    })
    op.addEventListener('change', () => { if (op.value === 'exists') value.value = 'true' })
    button(t("Add check"), () => {
      const current = fields.find(field => `${field.step}:${field.field}` === source.value)!
      const clause = parseCondition({ step: current.step, field: current.field, op: op.value, value: conditionValue(current.type, op.value as Predicate['op'], value.value) })
      when = appendCondition(when, clause, group.value as 'all' | 'any'); renderConditions()
    }, aside)
  } else aside.append(make('p', t("Connect a predecessor that declares output fields.")))
  const schema = field(t("Result schema (JSON)"), step.outputSchema ? JSON.stringify(step.outputSchema, null, 2) : '', true)
  schema.placeholder = '{"decision":{"type":"string","enum":["improve","pass"]}}'
  aside.append(make('p',t("Conditions compare typed predecessor outputs. Approval is a separate user decision.")))
  button(t("Apply step"),()=>mutate(graph=>patchStep(graph,step.id,{ title:title.value,spec:spec.value,agent:agent.value,fallback:fallback.value.split(',').map(x=>x.trim()).filter(x=>x&&x!==agent.value),acceptance:acceptance.value.split('\n').filter(x=>x.trim()),approval:approval.value.trim()||undefined, when, join: join.value === 'all_success' && step.join === undefined ? undefined : join.value as ScenarioStep['join'], outputSchema: schema.value.trim() ? parseOutputSchema(JSON.parse(schema.value)) : undefined })),aside)
  const deps=make('div');aside.append(deps)
  for (const id of step.needs) {
    const remove = button(t("Remove connection {0} → {1}", id, step.id), () => {
      mutate(graph => disconnectSteps(graph, id, step.id))
      focusGraph('input:' + step.id)
    }, deps)
    if (edgeSource === id) remove.dataset.selectedEdge = id
  }
  button(t("Delete step"),()=>mutate(graph=>deleteStep(graph,step.id)),aside).disabled=!!scenario&&scenario.steps.length===1
}
function render(redrawInspector = true) {
  if (!scenario) return
  const focusKey = document.activeElement?.getAttribute('data-focus')
  world.replaceChildren()
  const layers=waves(scenario.steps)
  layers.forEach((layer, x)=>layer.forEach((step,y)=>{if(!positions.has(step.id))positions.set(step.id,{x:50+x*330,y:60+y*200})}))
  const all=[...positions.values()];world.style.width=`${Math.max(1100,...all.map(p=>p.x+310))}px`;world.style.height=`${Math.max(800,...all.map(p=>p.y+220))}px`
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width',world.style.width);svg.setAttribute('height',world.style.height)
  const defs=document.createElementNS(svg.namespaceURI,'defs');defs.innerHTML='<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a58de2"/></marker>';svg.append(defs);world.append(svg)
  for(const step of scenario.steps) for(const need of step.needs){
    const a=positions.get(need)!,b=positions.get(step.id)!,path=document.createElementNS('http://www.w3.org/2000/svg','path')
    const label = step.when ? conditionLabel(step.when, language) : step.join === 'all_settled' ? t("All finished") : t("After success")
    const bypass = b.x - a.x > 450, arcY = Math.max(8, Math.min(a.y, b.y) - 95)
    path.setAttribute('d', bypass ? `M${a.x+240},${a.y+44} C${a.x+330},${arcY} ${b.x-90},${arcY} ${b.x},${b.y+44}` : `M${a.x+240},${a.y+44} C${a.x+290},${a.y+44} ${b.x-60},${b.y+44} ${b.x},${b.y+44}`);path.setAttribute('class','edge');path.setAttribute('marker-end','url(#arrow)');path.setAttribute('aria-label',t("Connection {0} → {1}: {2}", need, step.id, label))
    const description = document.createElementNS(svg.namespaceURI, 'title'); description.textContent = label; path.append(description)
    if (step.when) path.setAttribute('stroke-dasharray', '7 4')
    path.setAttribute('tabindex', '0')
    path.setAttribute('role', 'button')
    path.setAttribute('data-focus', 'edge:' + need + ':' + step.id)
    path.setAttribute('aria-pressed', String(edgeSource === need && selected === step.id))
    const inspectEdge = () => {
      selected = step.id; edgeSource = need; aside.classList.remove('collapsed'); render()
      say(t("Connection {0} → {1}: edit the condition in step settings. Use Remove connection to disconnect it.", need, step.id))
      aside.querySelector<HTMLButtonElement>('[data-selected-edge]')?.focus()
    }
    path.addEventListener('click', inspectEdge)
    path.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspectEdge() }
    })
    svg.append(path)
    if (step.when || step.join === 'all_settled') {
      const text = document.createElementNS(svg.namespaceURI, 'text')
      text.setAttribute('x', String((a.x + 240 + b.x) / 2)); text.setAttribute('y', String(bypass ? (a.y + b.y + 88) / 8 + arcY * .75 - 10 : (a.y + b.y) / 2 + 30)); text.setAttribute('fill', '#d3baff'); text.setAttribute('font-size', '12'); text.setAttribute('text-anchor', 'middle')
      const short = step.when && 'step' in step.when ? `${({eq:'=',ne:'≠',gt:'>',gte:'≥',lt:'<',lte:'≤',exists:t("exists")})[step.when.op]} ${String(step.when.value)}` : step.when ? t("Condition") : t("Wait for all")
      text.textContent = short.length > 12 ? short.slice(0, 11) + '…' : short
      text.setAttribute('style', 'paint-order:stroke;stroke:var(--orca-background,#262936);stroke-width:4px;pointer-events:none'); svg.append(text)
    }
  }
  for(const step of scenario.steps){
    const pos=positions.get(step.id)!,node=make('div');node.className=`node ${selected===step.id?'selected':''} ${connecting===step.id?'pending':''}`;node.style.left=`${pos.x}px`;node.style.top=`${pos.y}px`;node.dataset.step=step.id
    node.append(make('strong',step.title),make('span',step.agent),make('small',step.needs.length?`${step.join === 'all_settled' ? t("After completion") : t("After success")}: ${step.needs.join(', ')}`:t("Independent start")))
    if(step.when) { const label = make('small', t("If: ") + conditionLabel(step.when, language)); label.title = conditionLabel(step.when, language); label.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis'; node.append(label) }
    if(step.join === 'all_settled') node.append(make('small',t("Wait for all branches, including skipped steps")))
    if(step.approval)node.append(make('small',t("◈ Condition: {0}", step.approval)))
    const input=make('button');input.className='port input';input.dataset.input=step.id;input.setAttribute('aria-label',t("Input for {0}", step.title))
    const output=make('button');output.className='port output';output.setAttribute('aria-label',t("Connect {0}", step.title))
    input.dataset.focus = 'input:' + step.id
    output.dataset.focus = 'output:' + step.id
    output.addEventListener('click', event => {
      if (event.detail === 0) {
        connecting = step.id
        say(t("Choose a target input with Tab and press Enter. Escape cancels."))
      }
    })
    output.addEventListener('pointerdown',event=>{event.stopPropagation();connecting=step.id;say(t("Select the next step’s input to connect it to “{0}”", step.title))})
    input.addEventListener('pointerup',event=>{event.stopPropagation();connect(step.id)})
    input.addEventListener('click',event=>{event.stopPropagation();connect(step.id)})
    node.append(input,output)
    node.addEventListener('pointerdown',event=>{
      if((event.target as HTMLElement).closest('button'))return
      selected=step.id;edgeSource=null;inspector(step);if(expanded)aside.classList.remove('collapsed')
      // Keep coordinates relative to the starting position, regardless of DOM redraws.
      const original={...pos}
      const drag=(e:PointerEvent)=>{positions.set(step.id,{x:Math.max(15,original.x+e.clientX-event.clientX),y:Math.max(15,original.y+e.clientY-event.clientY)});render()}
      window.addEventListener('pointermove',drag)
      window.addEventListener('pointerup',()=>{window.removeEventListener('pointermove',drag);render();saveLayout()},{once:true})
    })
    world.append(node)
  }
  const step=scenario.steps.find(s=>s.id===selected);if(step && redrawInspector)inspector(step)
  if (focusKey) focusGraph(focusKey)
}

function focusGraph(key: string) {
  Array.from(world.querySelectorAll<HTMLElement | SVGElement>('[data-focus]'))
    .find(element => element.getAttribute('data-focus') === key)?.focus()
}
function connect(to: string) {
  if(!connecting)return
  const from=connecting;connecting=null
  try {
    mutate(graph => connectSteps(graph, from, to))
    say(t("Connected {0} → {1}", from, to))
  } catch (error) { say(String(error), true); render() }
  focusGraph('input:' + to)
}
yaml.addEventListener('input',()=>{if(session.readOnly)return;undo.push(source);redo.length=0;source=yaml.value;session.change(source);try{scenario=parseScenario(source,{expandEvidence:false});invalid=false;publish.disabled=false;say(t("YAML updated. Changes are syncing to the Orca document."))}catch(error){invalid=true;publish.disabled=true;say(String(error),true)}})
window.addEventListener('pointermove',event=>{
  if(!connecting)return
  const svg=world.querySelector('svg'),pos=positions.get(connecting);if(!svg||!pos)return
  let path=svg.querySelector('#draft-edge')
  if(!path){path=document.createElementNS(svg.namespaceURI,'path');path.id='draft-edge';path.setAttribute('fill','none');path.setAttribute('stroke','#edcd71');path.setAttribute('stroke-width','3');path.setAttribute('stroke-dasharray','7 5');svg.append(path)}
  const bounds=world.getBoundingClientRect();path.setAttribute('d',`M${pos.x+240},${pos.y+44} L${event.clientX-bounds.left},${event.clientY-bounds.top}`)
})
window.addEventListener('pointerup',event=>{const input=(event.target as HTMLElement).closest<HTMLElement>('[data-input]');if(input?.dataset.input)connect(input.dataset.input)})
window.addEventListener('keydown',event=>{if(event.key==='Escape'){if(connecting)focusGraph('output:'+connecting);connecting=null;world.querySelector('#draft-edge')?.remove();if(expanded){expanded=false;document.body.classList.remove('expanded');aside.classList.remove('collapsed');fullscreen.textContent=t("Expand graph")};say(t("Standard editor view"))}if((event.ctrlKey||event.metaKey)&&event.key==='z'){event.preventDefault();history(event.shiftKey)}})
session.onReplace(next=>{positions.clear();load(next)})
load(source)

orca.settings.onDidChange(async ({ key }) => {
  if (key !== 'interfaceLanguage') return
  const next = languageOf(await orca.settings.get(key))
  if (next === language) return
  language = next
  document.documentElement.lang = next
  heading.textContent = t("Pipeline · graph and YAML")
  for (const [element, key] of headerLabels) element.textContent = t(key)
  fullscreen.textContent = expanded ? t("Standard view") : t("Expand graph")
  mode.textContent = yaml.classList.contains('visible') ? t("Graph") : 'YAML'
  canvas.setAttribute('aria-label', t("Pipeline graph"))
  aside.setAttribute('aria-label', t("Selected step settings"))
  yaml.setAttribute('aria-label', t("Scenario YAML"))
  const step = scenario?.steps.find(item => item.id === selected)
  if (step) {
    // Rebuild labels, retaining unpublished form values and conditions.
    const controls = () => Array.from(aside.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea'))
    const values = controls().map(control => control.value)
    const open = aside.querySelector('details')?.open ?? false
    const when = currentCondition?.()
    render(false)
    inspector({ ...step, when })
    controls().forEach((control, index) => { if (index < values.length) control.value = values[index] })
    const details = aside.querySelector('details')
    if (details) details.open = open
  }
  if (!invalid) say(t("Drag between ports, or use Tab and Enter to select an output and then an input. Select a connection to inspect or remove it."))
})
